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
import type { Env } from '../config/env';
import { ConversationsService } from '../conversations/conversations.service';
import { ENV } from '../infra/tokens';
import type { DomainEventHandler } from '../worker/domain-events';
import { AiAgentService, ConversationBusyError } from './ai-agent.service';
import { AiClassifierService } from './ai-classifier.service';

export const AI_QUEUE = 'ai-turns';

type AiJob =
  | { kind: 'turn'; conversationId: string; messageId: string }
  | { kind: 'classify'; ticketId: string };

/**
 * AI work runs on its own queue so slow model calls never hold up delivery
 * or realtime events. Turns for one conversation are serialised by a Redis
 * lock in AiAgentService; a busy conversation retries shortly.
 */
@Injectable()
export class AiWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(AiWorker.name);
  private readonly connection: Redis;
  readonly queue: Queue<AiJob>;
  private worker?: Worker<AiJob>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly agent: AiAgentService,
    private readonly classifier: AiClassifierService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<AiJob>(AI_QUEUE, { connection: this.connection });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<AiJob>(AI_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: this.env.AI_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => {
      if (job && !(err instanceof ConversationBusyError)) {
        this.logger.warn(`AI job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`);
      }
    });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  async enqueue(job: AiJob) {
    const jobId = job.kind === 'turn' ? `turn--${job.messageId}` : `classify--${job.ticketId}`;
    await this.queue.add(job.kind, job, {
      jobId,
      attempts: 8,
      backoff: { type: 'fixed', delay: 1_500 },
      removeOnComplete: { count: 2_000 },
      removeOnFail: { count: 2_000 },
    });
  }

  private async process(job: Job<AiJob>) {
    const d = job.data;
    if (d.kind === 'turn') return this.agent.runTurn(d.conversationId, d.messageId);
    return this.classifier.classify(d.ticketId);
  }
}

/** Sends customer messages on AI-owned conversations, and new customer tickets, to the AI queue. */
@Injectable()
export class AiDispatchHandler implements DomainEventHandler {
  readonly name = 'ai-dispatch';

  constructor(
    private readonly ai: AiWorker,
    private readonly conversations: ConversationsService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'message.received' || type === 'ticket.created';
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'ticket.created') {
      // Only tickets customers opened through a channel; agents set their own categories.
      if (event.actor.type === 'customer') {
        await this.ai.enqueue({ kind: 'classify', ticketId: event.aggregateId });
      }
      return;
    }
    const p = event.payload as { conversationId?: string; messageId?: string };
    if (!p.conversationId || !p.messageId) return;
    const conv = await this.conversations.get(p.conversationId).catch(() => null);
    if (conv?.controller === 'ai') {
      await this.ai.enqueue({ kind: 'turn', conversationId: conv.id, messageId: p.messageId });
    }
  }
}
