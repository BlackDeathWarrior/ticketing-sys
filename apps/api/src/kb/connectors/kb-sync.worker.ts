import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { currentTrace, SpanKind, withSpan } from '../../telemetry/tracing';
import type { DomainEventHandler } from '../../worker/domain-events';
import { KbConnectorsService } from './kb-connectors.service';

export const KB_SYNC_QUEUE = 'kb-sync';
/** How often the worker looks for connectors whose schedule says they are due. */
const SWEEP_MS = 5 * 60_000;

type SyncJob = { kind: 'sync'; connectorId: string; trace?: string | null } | { kind: 'sweep' };

/**
 * Runs connector syncs one at a time (ADR 0033): a sync calls outside
 * services and writes many documents, so two at once would only compete.
 * A sweep every five minutes queues the connectors that are due.
 */
@Injectable()
export class KbSyncWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(KbSyncWorker.name);
  private readonly connection: Redis;
  readonly queue: Queue<SyncJob>;
  private worker?: Worker<SyncJob>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly connectors: KbConnectorsService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<SyncJob>(KB_SYNC_QUEUE, { connection: this.connection });
  }

  async onApplicationBootstrap() {
    this.worker = new Worker<SyncJob>(KB_SYNC_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      if (job) this.logger.warn(`knowledge base sync ${job.id} failed: ${err.message}`);
    });
    await this.queue.upsertJobScheduler(
      'kb-sync-sweep',
      { every: SWEEP_MS },
      { name: 'sweep', data: { kind: 'sweep' }, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  async enqueue(connectorId: string, reason: string) {
    await this.queue.add(
      'sync',
      { kind: 'sync', connectorId, trace: currentTrace() },
      {
        // One waiting sync per connector and reason: pressing "Sync now" twice queues one.
        jobId: `${connectorId}--${reason}`,
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    );
  }

  private async process(job: Job<SyncJob>) {
    const d = job.data;
    if (d.kind === 'sweep') {
      const slot = Math.floor(Date.now() / SWEEP_MS);
      for (const id of await this.connectors.due()) await this.enqueue(id, `schedule-${slot}`);
      return;
    }
    return withSpan('kb sync', { parent: d.trace, kind: SpanKind.CONSUMER }, () =>
      this.connectors.sync(d.connectorId),
    );
  }
}

/** "Sync now" from Knowledge base → Sources. */
@Injectable()
export class KbSyncHandler implements DomainEventHandler {
  readonly name = 'kb-sync';

  constructor(private readonly worker: KbSyncWorker) {}

  handles(type: DomainEventType): boolean {
    return type === 'kb.connector_sync_requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    await this.worker.enqueue(event.aggregateId, `now-${event.id}`);
  }
}
