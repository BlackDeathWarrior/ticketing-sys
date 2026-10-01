import { createHash } from 'node:crypto';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import type { WaWebhookPayload } from './webhook-payload';
import { WhatsAppService } from './whatsapp.service';

export const WHATSAPP_WEBHOOK_QUEUE = 'whatsapp-webhooks';
const ATTEMPTS = 6;

interface WebhookJob {
  payload: WaWebhookPayload;
}

/**
 * API side: the webhook route answers Meta at once and leaves the work
 * (media downloads, tickets) to the worker. The job id is the body's hash, so
 * a redelivered webhook that is still queued isn't processed twice.
 */
@Injectable()
export class WhatsAppWebhookQueue implements BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue<WebhookJob>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async add(rawBody: Buffer, payload: WaWebhookPayload): Promise<void> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue ??= new Queue<WebhookJob>(WHATSAPP_WEBHOOK_QUEUE, { connection: this.connection });
    await this.queue.add(
      'webhook',
      { payload },
      {
        jobId: `wa-${createHash('sha256').update(rawBody).digest('hex').slice(0, 40)}`,
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 5_000 },
        removeOnFail: { age: 7 * 86_400, count: 1_000 },
      },
    );
  }

  async beforeApplicationShutdown() {
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}

/** Worker side: one webhook at a time, so a customer's messages keep their order. */
@Injectable()
export class WhatsAppWebhookWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WhatsAppWebhookWorker.name);
  private readonly connection: Redis;
  private worker?: Worker<WebhookJob>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly whatsapp: WhatsAppService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<WebhookJob>(
      WHATSAPP_WEBHOOK_QUEUE,
      async (job) => {
        const outcome = await this.whatsapp.process(job.data.payload);
        // A delivery report can overtake our own record of the send; try again shortly.
        if (outcome.unknownStatuses > 0 && job.attemptsMade < 2) {
          throw new Error(`${outcome.unknownStatuses} status report(s) for unknown messages`);
        }
        this.logger.debug(`webhook ${job.id}: ${JSON.stringify(outcome)}`);
      },
      { connection: this.connection, concurrency: 1 },
    );
    this.worker.on('failed', (job, err) => {
      if (job && job.attemptsMade >= ATTEMPTS) {
        this.logger.error(`webhook ${job.id} failed for good: ${err.message}`);
      }
    });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.connection.quit().catch(() => undefined);
  }
}
