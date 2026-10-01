import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DomainEvent, DomainEventType, WebhookEvent } from '@tms/shared';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { currentTrace, SpanKind, withSpan } from '../telemetry/tracing';
import type { DomainEventHandler } from '../worker/domain-events';
import { isWebhookSource, toWebhookEvent } from './webhook-events';
import { WebhookPayloadService } from './webhook-payload.service';
import { WebhookSender } from './webhook-sender';
import { WebhooksService } from './webhooks.service';

export const WEBHOOK_QUEUE = 'webhook-deliveries';

interface DeliveryJob {
  deliveryId: string;
  /** W3C traceparent of whatever queued the job. */
  trace?: string | null;
}

/**
 * Sends webhook deliveries on their own queue, so a slow or dead receiver
 * never holds up message delivery or other follow-up work. A failed send is
 * retried with a doubling wait; after the last attempt it is marked failed.
 */
@Injectable()
export class WebhookDeliveryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private readonly connection: Redis;
  readonly queue: Queue<DeliveryJob>;
  private worker?: Worker<DeliveryJob>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly webhooks: WebhooksService,
    private readonly payloads: WebhookPayloadService,
    private readonly sender: WebhookSender,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<DeliveryJob>(WEBHOOK_QUEUE, { connection: this.connection });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<DeliveryJob>(WEBHOOK_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: 5,
    });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  async enqueue(deliveryId: string) {
    await this.queue.add(
      'deliver',
      { deliveryId, trace: currentTrace() },
      {
        // One job per delivery, however often its event is handled.
        jobId: deliveryId,
        attempts: this.env.WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: this.env.WEBHOOK_BACKOFF_MS },
        removeOnComplete: { count: 2_000 },
        removeOnFail: { count: 2_000 },
      },
    );
  }

  private async process(job: Job<DeliveryJob>) {
    return withSpan(
      'webhook deliver',
      { parent: job.data.trace, kind: SpanKind.CONSUMER },
      async () => {
        const found = await this.webhooks.delivery(job.data.deliveryId);
        // Deleted with its subscription, or already sent by an earlier run of this job.
        if (!found || found.delivery.status === 'delivered') return;
        const { delivery, subscription } = found;
        const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

        /** Records a failure no retry can fix and stops the job. */
        const giveUp = async (error: string): Promise<never> => {
          await this.webhooks.recordAttempt(
            delivery,
            { ok: false, httpStatus: null, error, durationMs: 0 },
            true,
          );
          throw new UnrecoverableError(error);
        };

        if (!subscription.isActive) return giveUp('The webhook is switched off');
        if (!found.secret) return giveUp('The signing secret is missing. Rotate it.');
        const data = await this.payloads.data(delivery.eventType as WebhookEvent, found.refs);
        if (!data) return giveUp('What this event was about no longer exists');

        const outcome = await this.sender.send(subscription.url, found.secret, {
          id: delivery.id,
          type: delivery.eventType as WebhookEvent,
          createdAt: delivery.eventAt.toISOString(),
          integration: found.integration.slug,
          data,
        });
        if (outcome.ok) {
          await this.webhooks.recordAttempt(delivery, outcome, true);
          return;
        }
        if (outcome.permanent) return giveUp(outcome.error ?? 'failed');
        await this.webhooks.recordAttempt(delivery, outcome, final);
        this.logger.warn(
          `webhook delivery ${delivery.id} failed (attempt ${job.attemptsMade + 1}): ${outcome.error}`,
        );
        throw new Error(outcome.error ?? 'failed');
      },
    );
  }
}

/**
 * Turns domain events into webhook deliveries: one log row per subscription
 * that wants the event, then a job. It never calls a receiver itself, so the
 * shared `domain-events` consumer is not held up or failed by one.
 */
@Injectable()
export class WebhookDispatchHandler implements DomainEventHandler {
  readonly name = 'webhook-dispatch';

  constructor(
    private readonly webhooks: WebhooksService,
    private readonly payloads: WebhookPayloadService,
    private readonly worker: WebhookDeliveryWorker,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'webhook.redelivery_requested' || isWebhookSource(type);
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'webhook.redelivery_requested') {
      const { deliveryId } = event.payload as { deliveryId: string };
      await this.worker.enqueue(deliveryId);
      return;
    }
    const mapped = toWebhookEvent(event);
    if (!mapped) return;
    const owner = await this.payloads.owner(mapped.refs);
    const subscriptions = await this.webhooks.matching(mapped.type, owner);
    for (const s of subscriptions) {
      const deliveryId = await this.webhooks.queue(
        s.id,
        { id: event.id, at: new Date(event.occurredAt) },
        mapped,
      );
      await this.worker.enqueue(deliveryId);
    }
  }
}
