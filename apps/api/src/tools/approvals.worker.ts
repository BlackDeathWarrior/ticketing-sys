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
import { ApprovalsService } from './approvals.service';

export const APPROVALS_QUEUE = 'approvals';

/** A delayed job per approval that expires it if nobody decided in time. */
@Injectable()
export class ApprovalExpiryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ApprovalExpiryWorker.name);
  private readonly connection: Redis;
  private readonly queue: Queue<{ approvalId: string }>;
  private worker?: Worker<{ approvalId: string }>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly approvals: ApprovalsService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(APPROVALS_QUEUE, { connection: this.connection });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<{ approvalId: string }>(
      APPROVALS_QUEUE,
      async (job) => {
        if (await this.approvals.expire(job.data.approvalId)) {
          this.logger.log(`approval ${job.data.approvalId} expired`);
        }
      },
      { connection: this.connection.duplicate() },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  async schedule(approvalId: string, expiresAt: Date) {
    await this.queue.add(
      'expire',
      { approvalId },
      {
        jobId: `expire--${approvalId}`,
        // A second late, so the approval's own expiry check agrees.
        delay: Math.max(0, expiresAt.getTime() - Date.now() + 1_000),
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    );
  }
}

@Injectable()
export class ApprovalsHandler implements DomainEventHandler {
  readonly name = 'approvals';

  constructor(private readonly expiry: ApprovalExpiryWorker) {}

  handles(type: DomainEventType): boolean {
    return type === 'approval.requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as { approvalId: string; expiresAt: string };
    await this.expiry.schedule(p.approvalId, new Date(p.expiresAt));
  }
}
