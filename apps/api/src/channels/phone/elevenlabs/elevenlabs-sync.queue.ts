import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { BRANDING_KEY, type DomainEvent, type DomainEventType } from '@tms/shared';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../../config/env';
import { ENV } from '../../../infra/tokens';
import { currentTrace, SpanKind, withSpan } from '../../../telemetry/tracing';
import type { DomainEventHandler } from '../../../worker/domain-events';
import { ElevenLabsAgentSync } from './elevenlabs-agent-sync.service';

export const ELEVENLABS_SYNC_QUEUE = 'phone-agent-sync';
const ATTEMPTS = 5;
const BACKOFF_MS = 60_000;
/** Several changes close together (a few tools edited in a row) become one run. */
const SETTLE_MS = 30_000;
const JOB_ID = 'elevenlabs-sync';
/** A change that arrived while a run was under way. */
const JOB_ID_NEXT = 'elevenlabs-sync-next';

interface SyncJob {
  reason: 'button' | 'tool_changed' | 'settings_saved';
  trace?: string | null;
}

/** Asks for a sync. Used by the API (the button) and by the worker (a change on the desk). */
@Injectable()
export class ElevenLabsSyncQueue implements BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue<SyncJob>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async request(reason: SyncJob['reason']): Promise<void> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue ??= new Queue<SyncJob>(ELEVENLABS_SYNC_QUEUE, { connection: this.connection });
    const options = {
      attempts: ATTEMPTS,
      backoff: { type: 'exponential' as const, delay: BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400, count: 50 },
    };
    const job = { reason, trace: currentTrace() };
    // One job at a time holds the id, and an id that exists is not added again. So what the
    // earlier one is doing decides what this request needs.
    const earlier = await this.queue.getJob(JOB_ID);
    const doing = earlier ? await earlier.getState() : null;
    if (earlier && (doing === 'failed' || doing === 'completed')) {
      await earlier.remove();
    } else if (earlier && doing === 'active') {
      // It has already read the tools and settings: this change needs a run of its own.
      const next = await this.queue.getJob(JOB_ID_NEXT);
      if (next && (await next.isFailed())) await next.remove();
      await this.queue.add('sync', job, { ...options, jobId: JOB_ID_NEXT, delay: SETTLE_MS });
      return;
    } else if (earlier) {
      // Waiting, settling, or between two tries after a failure. It will read everything
      // fresh when it runs; a person who pressed the button or corrected a setting after a
      // failure should not wait out the retry delay.
      if (doing === 'delayed' && (reason === 'button' || earlier.attemptsMade > 0)) {
        await earlier.promote();
      }
      return;
    }
    await this.queue.add('sync', job, {
      ...options,
      jobId: JOB_ID,
      delay: reason === 'button' ? 0 : SETTLE_MS,
    });
  }

  async beforeApplicationShutdown() {
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}

/** Worker side: runs the sync, one at a time. */
@Injectable()
export class ElevenLabsSyncWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ElevenLabsSyncWorker.name);
  private readonly connection: Redis;
  private worker?: Worker<SyncJob>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly sync: ElevenLabsAgentSync,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<SyncJob>(ELEVENLABS_SYNC_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= (job.opts.attempts ?? ATTEMPTS)) {
        this.logger.error(`the ElevenLabs agent was not synced: ${err.message}`);
      }
    });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.connection.quit().catch(() => undefined);
  }

  private process(job: Job<SyncJob>) {
    return withSpan(
      'elevenlabs agent sync',
      { parent: job.data.trace, kind: SpanKind.CONSUMER },
      async () => {
        const state = await this.sync.run();
        this.logger.log(
          state
            ? `ElevenLabs agent synced (${job.data.reason}): ${state.tools} tools, ${state.skipped.length} skipped`
            : 'ElevenLabs agent sync skipped: the card is off or has no key',
        );
      },
    );
  }
}

/** What the agent is built from: a change to any of it asks for a sync. */
const SETTINGS_THAT_MATTER = ['channel.elevenlabs', 'elevenlabs.api_key', BRANDING_KEY];

@Injectable()
export class ElevenLabsSyncHandler implements DomainEventHandler {
  readonly name = 'elevenlabs-sync';

  constructor(private readonly queue: ElevenLabsSyncQueue) {}

  handles(type: DomainEventType): boolean {
    return (
      type === 'tool.config_changed' ||
      type === 'settings.updated' ||
      type === 'settings.secret_changed'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'tool.config_changed') return this.queue.request('tool_changed');
    // Not the sync's own record, and not the secrets the sync itself saves: no loop.
    if (SETTINGS_THAT_MATTER.includes(event.aggregateId)) {
      await this.queue.request('settings_saved');
    }
  }
}
