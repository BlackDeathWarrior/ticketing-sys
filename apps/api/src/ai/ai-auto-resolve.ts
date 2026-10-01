import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Database } from '@tms/db';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { AI_CTX } from '../common/request-context';
import type { Env } from '../config/env';
import { ConversationsService } from '../conversations/conversations.service';
import { DB, ENV } from '../infra/tokens';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';

const QUEUE = 'ai-auto-resolve';
const HOUR_MS = 3_600_000;
/** Tickets looked at per run; the rest wait for the next one. */
const BATCH = 200;

/**
 * Closes the loop on tickets the AI answered (ADR 0019). After a confident
 * answer a ticket waits for the customer; if they stay quiet for the
 * configured time, the answer is taken to have settled it and the ticket is
 * resolved, with the AI as the actor. A later reply reopens it as usual.
 *
 * Only tickets the AI still owns are touched: once a person has taken over,
 * closing is their call.
 */
@Injectable()
export class AiAutoResolveService {
  private readonly logger = new Logger(AiAutoResolveService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly behaviour: AiBehaviourService,
    private readonly tickets: TicketsService,
    private readonly conversations: ConversationsService,
  ) {}

  async run(now = new Date()): Promise<{ resolved: number }> {
    const { autoResolveHours } = await this.behaviour.get();
    if (!autoResolveHours) return { resolved: 0 };
    const cutoff = now.getTime() - autoResolveHours * HOUR_MS;

    const waiting = await this.tickets.awaitingCustomerWithAi(BATCH);
    const last = await this.conversations.lastVisibleMessages(waiting);
    let resolved = 0;
    for (const ticketId of waiting) {
      const m = last.get(ticketId);
      // The AI's answer must be the last word, and old enough.
      if (!m || m.direction !== 'outbound' || m.authorType !== 'ai') continue;
      if (m.createdAt.getTime() > cutoff) continue;
      const moved = await this.db.transaction((tx) =>
        this.tickets.resolveInTx(
          tx,
          AI_CTX,
          ticketId,
          `No reply from the customer for ${autoResolveHours} hours after the AI's answer.`,
        ),
      );
      if (moved) resolved++;
    }
    if (resolved) this.logger.log(`resolved ${resolved} ticket(s) the AI had answered`);
    return { resolved };
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
