import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import type { DomainEventHandler } from '../worker/domain-events';
import { SlaService } from './sla.service';

export const SLA_QUEUE = 'sla';

/**
 * Sweeps SLA timers on a repeating BullMQ job (one run at a time across
 * workers), marking them at risk and breached. A sweep instead of one delayed
 * job per timer survives restarts, backdated data and changed deadlines.
 */
@Injectable()
export class SlaSweepWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(SlaSweepWorker.name);
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly sla: SlaService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(SLA_QUEUE, { connection: this.connection });
  }

  async onApplicationBootstrap() {
    this.worker = new Worker(
      SLA_QUEUE,
      async (job) => {
        if (job.name === 'reconcile-open') return this.sla.reconcileOpen();
        const r = await this.sla.sweep();
        if (r.atRisk || r.breached)
          this.logger.log(`SLA sweep: ${r.atRisk} at risk, ${r.breached} breached`);
        return r;
      },
      { connection: this.connection.duplicate(), concurrency: 1 },
    );
    await this.queue.upsertJobScheduler(
      'sla-sweep',
      { every: this.env.SLA_SWEEP_SECONDS * 1000 },
      { name: 'sweep', opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  /** Re-checks open tickets once, e.g. after a policy changed. */
  async reconcileOpenSoon() {
    await this.queue.add(
      'reconcile-open',
      {},
      { jobId: `reconcile-open--${Date.now()}`, delay: 500 },
    );
  }
}

/** Keeps a ticket's SLA timers in step with what happens to it. */
@Injectable()
export class SlaHandler implements DomainEventHandler {
  readonly name = 'sla';

  constructor(
    private readonly sla: SlaService,
    private readonly sweeper: SlaSweepWorker,
  ) {}

  handles(type: DomainEventType): boolean {
    return (
      type === 'ticket.created' ||
      type === 'ticket.status_changed' ||
      type === 'ticket.updated' ||
      type === 'ticket.classified' ||
      type === 'ticket.escalated' ||
      type === 'message.outbound' ||
      type === 'sla.config_changed'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'sla.config_changed') return this.sweeper.reconcileOpenSoon();
    if (event.aggregateType === 'ticket') await this.sla.reconcile(event.aggregateId);
  }
}
