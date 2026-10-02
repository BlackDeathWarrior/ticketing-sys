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
import { TicketsService } from '../tickets/tickets.service';
import { currentTrace, SpanKind, withSpan } from '../telemetry/tracing';
import type { DomainEventHandler } from '../worker/domain-events';
import { AiAgentService, ConversationBusyError } from './ai-agent.service';
import { AiClassifierService } from './ai-classifier.service';

export const AI_QUEUE = 'ai-turns';

const TURN_PRIORITY: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
const CLASSIFY_PRIORITY = 5;
/** How long a typed message waits before its turn starts. */
const SETTLE_MS = 1_200;
const TYPED_CHANNELS = new Set(['webchat', 'whatsapp', 'api']);

type AiJob = (
  | {
      kind: 'turn';
      conversationId: string;
      messageId: string;
      handBack?: string;
      /** The ticket's priority, so urgent customers are answered first when the queue is long. */
      priority?: string;
      /** A typed channel: wait a moment, so a burst of short messages gets one answer. */
      settle?: boolean;
    }
  | { kind: 'classify'; ticketId: string }
  | { kind: 'followup'; approvalId: string }
) & {
  /** W3C traceparent of whatever queued the job. */
  trace?: string | null;
};

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
    const jobId =
      job.kind === 'turn'
        ? `turn--${job.messageId}${job.handBack ? `--handback--${job.handBack}` : ''}`
        : job.kind === 'classify'
          ? `classify--${job.ticketId}`
          : `followup--${job.approvalId}`;
    await this.queue.add(
      job.kind,
      { ...job, trace: currentTrace() },
      {
        jobId,
        // BullMQ runs lower numbers first, and jobs with no priority before all of them:
        // every job gets one, so a ticket's priority decides and not the job's kind.
        priority:
          job.kind === 'turn'
            ? (TURN_PRIORITY[job.priority ?? 'normal'] ?? TURN_PRIORITY.normal)
            : job.kind === 'followup'
              ? TURN_PRIORITY.high
              : CLASSIFY_PRIORITY,
        ...(job.kind === 'turn' && job.settle ? { delay: SETTLE_MS } : {}),
        // A busy conversation is retried until the turn in front of it has finished.
        attempts: 30,
        backoff: { type: 'fixed', delay: 1_500 },
        removeOnComplete: { count: 2_000 },
        removeOnFail: { count: 2_000 },
      },
    );
  }

  private async process(job: Job<AiJob>) {
    const d = job.data;
    return withSpan(`ai ${d.kind}`, { parent: d.trace, kind: SpanKind.CONSUMER }, async () => {
      if (d.kind === 'turn') return this.agent.runTurn(d.conversationId, d.messageId);
      if (d.kind === 'followup') return this.agent.followUp(d.approvalId);
      return this.classifier.classify(d.ticketId);
    });
  }
}

/**
 * Sends customer messages on AI-owned conversations, new customer tickets,
 * and decided or expired approvals (the follow-up) to the AI queue.
 */
@Injectable()
export class AiDispatchHandler implements DomainEventHandler {
  readonly name = 'ai-dispatch';

  constructor(
    private readonly ai: AiWorker,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
  ) {}

  handles(type: DomainEventType): boolean {
    return (
      type === 'message.received' ||
      type === 'ticket.created' ||
      type === 'approval.decided' ||
      type === 'approval.expired' ||
      type === 'conversation.controller_changed'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'approval.decided' || event.type === 'approval.expired') {
      await this.ai.enqueue({ kind: 'followup', approvalId: event.aggregateId });
      return;
    }
    if (event.type === 'conversation.controller_changed') {
      // Handed back to the AI: answer the customer's last message if nobody has.
      const c = event.payload as { conversationId: string; to: string };
      if (c.to !== 'ai') return;
      const last = (await this.conversations.transcript(c.conversationId, 1))[0];
      if (last?.authorType === 'customer' && last.channel !== 'voice') {
        await this.ai.enqueue({
          kind: 'turn',
          conversationId: c.conversationId,
          messageId: last.id,
          handBack: event.id,
        });
      }
      return;
    }
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
    // A voice call answers while the caller is on the line (VoiceService), not from this queue.
    if (conv?.controller === 'ai' && conv.channel !== 'voice') {
      await this.ai.enqueue({
        kind: 'turn',
        conversationId: conv.id,
        messageId: p.messageId,
        priority: await this.tickets.priorityOf(conv.ticketId).catch(() => undefined),
        settle: TYPED_CHANNELS.has(conv.channel),
      });
    }
  }
}
