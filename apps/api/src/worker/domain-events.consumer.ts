import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { DOMAIN_EVENTS_QUEUE, type DomainEvent } from '@tms/shared';
import { type Job, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { DOMAIN_EVENT_HANDLERS, type DomainEventHandler } from './domain-events';

/** Runs every registered handler for each domain event; a throw retries the event. */
@Injectable()
export class DomainEventsConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(DomainEventsConsumer.name);
  private connection?: Redis;
  private worker?: Worker<DomainEvent>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DOMAIN_EVENT_HANDLERS) private readonly handlers: DomainEventHandler[],
  ) {}

  onApplicationBootstrap() {
    this.connection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker<DomainEvent>(DOMAIN_EVENTS_QUEUE, (job) => this.process(job), {
      connection: this.connection,
      concurrency: this.env.WORKER_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) =>
      this.logger.error(`event ${job?.data.type} ${job?.id} failed: ${err.message}`),
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.connection?.quit().catch(() => undefined);
  }

  async process(job: Pick<Job<DomainEvent>, 'data' | 'attemptsMade' | 'opts'>) {
    const event = job.data;
    const ctx = { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 };
    for (const handler of this.handlers) {
      if (handler.handles(event.type)) await handler.handle(event, ctx);
    }
  }
}
