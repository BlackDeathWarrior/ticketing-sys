import {
  BadRequestException,
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  DEFAULT_RETENTION,
  type FailedJobView,
  QUEUE_LABELS,
  type QueueView,
  type Retention,
  RETENTION_KEY,
  type RetentionCounts,
  type RetentionView,
  retentionSchema,
  VOICE_RECORDING_DAYS,
} from '@tms/shared';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { VoiceCallsService } from '../channels/voice/voice-calls.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { LlmClientService } from '../llm/llm-client.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PortalService } from '../portal/portal.service';
import { AppSettingsService } from '../settings/app-settings.service';
import type { Database } from '@tms/db';

const DAY_MS = 86_400_000;
const RETENTION_QUEUE = 'retention';
/** Failed jobs shown per queue. */
const SHOWN = 25;

/**
 * Deletes operational data that has served its purpose (ADR 0021). Tickets,
 * messages and the audit log are never touched: only logs and leftovers.
 * Each run is audited with what it deleted.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly settings: AppSettingsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly llm: LlmClientService,
    private readonly notifications: NotificationsService,
    private readonly portal: PortalService,
    private readonly calls: VoiceCallsService,
    private readonly webhooks: WebhooksService,
  ) {}

  async get(): Promise<Retention> {
    return (await this.settings.get(RETENTION_KEY, retentionSchema)) ?? DEFAULT_RETENTION;
  }

  async save(ctx: RequestCtx, input: unknown): Promise<Retention> {
    const parsed = new ZodPipe(retentionSchema).transform(input);
    await this.settings.set(ctx, RETENTION_KEY, parsed);
    return parsed;
  }

  async view(): Promise<RetentionView> {
    const [last] = await this.audit.list({ action: 'retention.ran', limit: 1 });
    return {
      settings: await this.get(),
      recordingsDays: VOICE_RECORDING_DAYS,
      lastRun: last
        ? { at: last.occurredAt.toISOString(), deleted: last.data.deleted as RetentionCounts }
        : null,
    };
  }

  async run(ctx: RequestCtx = SYSTEM_CTX, now = new Date()): Promise<RetentionCounts> {
    const s = await this.get();
    const before = (n: number) => new Date(now.getTime() - n * DAY_MS);
    const deleted: RetentionCounts = {
      llmCalls: await this.llm.purgeCalls(before(s.llmCallsDays)),
      notifications: await this.notifications.purge(before(s.notificationsDays)),
      events: await this.outbox.purgePublished(this.db, before(s.eventsDays)),
      signInLinks: await this.portal.purgeLogins(before(s.signInLinksDays)),
      recordings: await this.calls.purgeRecordings(VOICE_RECORDING_DAYS, now),
      webhookDeliveries: await this.webhooks.purgeDeliveries(before(s.webhookDeliveriesDays)),
    };
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: 'retention.ran',
        targetType: 'system',
        data: { deleted, settings: s },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'system.retention_ran',
        aggregateType: 'settings',
        aggregateId: RETENTION_KEY,
        payload: { deleted },
      });
    });
    if (Object.values(deleted).some((n) => n > 0)) {
      this.logger.log(`retention: ${JSON.stringify(deleted)}`);
    }
    return deleted;
  }
}

/** Runs retention once a day in the worker, one run at a time across workers. */
@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly retention: RetentionService,
  ) {}

  async onApplicationBootstrap() {
    if (!this.env.RETENTION_SWEEP_HOURS) return;
    this.connection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(RETENTION_QUEUE, { connection: this.connection });
    this.worker = new Worker(RETENTION_QUEUE, () => this.retention.run(), {
      connection: this.connection.duplicate(),
      concurrency: 1,
    });
    await this.queue.upsertJobScheduler(
      'retention',
      { every: this.env.RETENTION_SWEEP_HOURS * 3_600_000 },
      { name: 'run', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}

/**
 * Background jobs that failed for good, for an admin to look at, retry or
 * remove. Job payloads can hold customer content (a webhook body, a message),
 * so only the job's name, what it was about and the error are shown.
 */
@Injectable()
export class SystemJobsService implements OnApplicationShutdown {
  private readonly connection: Redis;
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(ENV) env: Env,
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
  }

  async onApplicationShutdown() {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit().catch(() => undefined);
  }

  async list(): Promise<QueueView[]> {
    const out: QueueView[] = [];
    for (const [name, label] of Object.entries(QUEUE_LABELS)) {
      const queue = this.queue(name);
      const [counts, failed] = await Promise.all([
        queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
        queue.getFailed(0, SHOWN - 1),
      ]);
      out.push({
        name,
        label,
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        jobs: failed
          .filter((j): j is Job => !!j)
          .sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))
          .map(jobView),
      });
    }
    return out;
  }

  /** Puts a failed job back in the queue. */
  async retry(ctx: RequestCtx, queueName: string, id: string): Promise<void> {
    const job = await this.failedJob(queueName, id);
    await job.retry('failed');
    await this.record(ctx, 'job_retried', queueName, job);
  }

  async remove(ctx: RequestCtx, queueName: string, id: string): Promise<void> {
    const job = await this.failedJob(queueName, id);
    await job.remove();
    await this.record(ctx, 'job_removed', queueName, job);
  }

  /** The queue lives in Redis, so the record follows the action instead of sharing a transaction. */
  private async record(
    ctx: RequestCtx,
    what: 'job_retried' | 'job_removed',
    queueName: string,
    job: Job,
  ): Promise<void> {
    const { id, name, about, reason } = jobView(job);
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: `system.${what}`,
        targetType: 'job',
        data: { queue: queueName, id, name, about, reason },
      });
      await this.outbox.publish(tx, ctx, {
        type: `system.${what}`,
        aggregateType: 'settings',
        aggregateId: `job:${queueName}:${id}`,
        payload: { queue: queueName, id, name, about },
      });
    });
  }

  private async failedJob(queueName: string, id: string): Promise<Job> {
    if (!(queueName in QUEUE_LABELS)) throw new NotFoundException('Unknown queue');
    const job = (await this.queue(queueName).getJob(id)) as Job | undefined;
    if (!job) throw new NotFoundException('Job not found');
    if (!(await job.isFailed())) throw new BadRequestException('This job has not failed');
    return job;
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }
}

function jobView(job: Job): FailedJobView {
  const data = (job.data ?? {}) as Record<string, unknown>;
  // Identifiers only: an event's type and record, a document, a message. Never the content.
  const about =
    typeof data.type === 'string'
      ? [data.type, data.aggregateId].filter((x) => typeof x === 'string').join(' · ')
      : ['document', 'ticket', 'message', 'conversation', 'approval']
          .filter((k) => typeof data[`${k}Id`] === 'string')
          .map((k) => `${k} ${String(data[`${k}Id`])}`)
          .join(' · ') || null;
  return {
    id: String(job.id),
    name: job.name,
    about,
    reason: (job.failedReason ?? 'Unknown error').slice(0, 500),
    attempts: job.attemptsMade,
    failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}
