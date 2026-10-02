import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '@tms/db';
import { type AiDecision, quietTimeMs } from '@tms/shared';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { OutboundService } from '../channels/outbound.service';
import { AI_CTX } from '../common/request-context';
import type { Env } from '../config/env';
import { ConversationsService } from '../conversations/conversations.service';
import { DB, ENV } from '../infra/tokens';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';
import { ApprovalsService } from '../tools/approvals.service';
import { AiRunsService } from './ai-runs.service';
import { closedForSilence, closingThanks } from './policy';
import { AGENT_PROMPT_VERSION } from './prompts';

const QUEUE = 'ai-auto-resolve';
const DAY_MS = 86_400_000;
/** Tickets looked at per run; the rest wait for the next one. */
const BATCH = 200;
/** Where a customer sees a message in place, so "this request was closed" reaches them. */
const TOLD_ON = new Set(['webchat', 'api']);

/** "30 minutes", "3 hours", "2 days": how long the customer was quiet, for the ticket's resolution. */
function span(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 72) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Brings tickets the AI answered to an end (ADR 0019). The AI resolves or
 * closes a ticket only here, and only while it still owns it; once a person
 * has taken over, closing is their call.
 *
 * - The customer answers "is there anything else?" with a no: resolved at
 *   once (`customerConfirmed`).
 * - The customer stays quiet for the channel's quiet time after the AI's last
 *   answer: resolved, and told so where they will see it (`run`).
 * - A ticket the AI resolved stays reopenable by a reply for some days, then
 *   is closed for good (`run`).
 */
@Injectable()
export class AiAutoResolveService {
  private readonly logger = new Logger(AiAutoResolveService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly behaviour: AiBehaviourService,
    private readonly tickets: TicketsService,
    private readonly conversations: ConversationsService,
    private readonly outbound: OutboundService,
    private readonly approvals: ApprovalsService,
    private readonly runs: AiRunsService,
  ) {}

  /**
   * The customer said nothing else is needed. No model is asked: the ticket
   * is resolved, they get a short goodbye, and the turn is recorded.
   */
  async customerConfirmed(i: {
    ticketId: string;
    conversationId: string;
    channel: string;
    language: string | null;
    triggerMessageId: string | null;
    /** They were already told the request is closed (a second "thanks"): resolve again, say nothing. */
    silent?: boolean;
  }): Promise<AiDecision> {
    return this.db.transaction(async (tx) => {
      const moved = await this.tickets.resolveByAiInTx(
        tx,
        AI_CTX,
        i.ticketId,
        'The customer said nothing else was needed.',
        'customer_confirmed',
      );
      if (!moved) return 'skipped';
      const message = i.silent
        ? null
        : await this.outbound.aiReply(
            AI_CTX,
            i.conversationId,
            closingThanks(i.language, i.channel),
            { draft: false, notice: true, metadata: { closing: true } },
            tx,
          );
      await this.runs.record(tx, {
        kind: 'turn',
        ticketId: i.ticketId,
        conversationId: i.conversationId,
        triggerMessageId: i.triggerMessageId,
        decision: 'sent',
        confidence: 1,
        promptVersion: AGENT_PROMPT_VERSION,
        tools: [
          { name: 'closing', summary: 'The customer needed nothing else; no model was asked' },
        ],
        replyMessageId: message?.id ?? null,
        language: i.language,
        intent: 'nothing_else',
      });
      return 'sent';
    });
  }

  async run(now = new Date()): Promise<{ resolved: number; closed: number }> {
    const behaviour = await this.behaviour.get();

    const waiting = await this.tickets.quietWithAi(BATCH);
    const ids = waiting.map((t) => t.id);
    const [last, undecided] = await Promise.all([
      this.conversations.lastVisibleMessages(ids),
      this.approvals.pendingTicketIds(ids),
    ]);
    let resolved = 0;
    for (const t of waiting) {
      const quiet = quietTimeMs(behaviour, t.channel);
      // 0: this channel's tickets are never closed for silence. A request with a colleague waits for them.
      if (!quiet || undecided.has(t.id)) continue;
      const m = last.get(t.id);
      // The AI's answer must be the last word, and old enough.
      if (!m || m.direction !== 'outbound' || m.authorType !== 'ai') continue;
      if (m.createdAt.getTime() > now.getTime() - quiet) continue;
      const moved = await this.db.transaction(async (tx) => {
        const done = await this.tickets.resolveByAiInTx(
          tx,
          AI_CTX,
          t.id,
          `No reply from the customer for ${span(quiet)} after the AI's answer.`,
          'no_reply',
        );
        if (done && behaviour.closing.tellCustomer && TOLD_ON.has(t.channel)) {
          const conv = await this.conversations.get(m.conversationId);
          await this.outbound.aiReply(
            AI_CTX,
            m.conversationId,
            closedForSilence(conv.language ?? null),
            { draft: false, notice: true, metadata: { closing: true } },
            tx,
          );
        }
        return done;
      });
      if (moved) resolved++;
    }

    let closed = 0;
    const days = behaviour.closing.closeResolvedAfterDays;
    if (days) {
      const before = new Date(now.getTime() - days * DAY_MS);
      for (const id of await this.tickets.aiResolvedBefore(before, BATCH)) {
        if (await this.db.transaction((tx) => this.tickets.closeAiResolvedInTx(tx, AI_CTX, id)))
          closed++;
      }
    }
    if (resolved || closed) {
      this.logger.log(`resolved ${resolved} and closed ${closed} ticket(s) the AI had answered`);
    }
    return { resolved, closed };
  }
}

/** Runs the check on a timer, one run at a time across workers. */
@Injectable()
export class AiAutoResolveWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly service: AiAutoResolveService,
  ) {}

  async onApplicationBootstrap() {
    if (!this.env.AI_AUTO_RESOLVE_SWEEP_SECONDS) return;
    this.connection = new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE, { connection: this.connection });
    this.worker = new Worker(QUEUE, () => this.service.run(), {
      connection: this.connection.duplicate(),
      concurrency: 1,
    });
    await this.queue.upsertJobScheduler(
      'ai-auto-resolve',
      { every: this.env.AI_AUTO_RESOLVE_SWEEP_SECONDS * 1000 },
      { name: 'sweep', opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}
