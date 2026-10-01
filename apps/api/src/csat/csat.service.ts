import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { csatRequests, csatResponses, type Database } from '@tms/db';
import {
  CSAT_WINDOW_DAYS,
  type CsatPrompt,
  type CsatSource,
  type CsatSubmit,
  type CsatView,
  type ChatRatingPrompt,
  formatTicketNumber,
  type HandledBy,
} from '@tms/shared';
import { eq, inArray } from 'drizzle-orm';
import { AiRunsService } from '../ai/ai-runs.service';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { readToken, signToken } from '../common/signed-token';
import type { Env } from '../config/env';
import { ConversationsService } from '../conversations/conversations.service';
import { DB, ENV } from '../infra/tokens';
import { type Ticket, TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';

const TOKEN_PURPOSE = 'csat';
const DAY_MS = 86_400_000;

type Response = typeof csatResponses.$inferSelect;

/**
 * Customer ratings (ADR 0019). A rating is given by the customer only: with
 * the token from a survey link or the chat prompt, or signed in to the
 * portal. There is no route for staff to rate a ticket.
 */
@Injectable()
export class CsatService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tickets: TicketsService,
    private readonly workflow: WorkflowService,
    private readonly conversations: ConversationsService,
    private readonly aiRuns: AiRunsService,
  ) {}

  /** The token a survey link or chat prompt carries for this ticket. */
  tokenFor(ticketId: string): string {
    return signToken(this.env.JWT_SECRET, TOKEN_PURPOSE, ticketId);
  }

  /** Where the survey email sends the customer. */
  linkFor(ticketId: string): string {
    return `${this.env.HELP_CENTER_URL.replace(/\/?$/, '/')}#/rate/${this.tokenFor(ticketId)}`;
  }

  /** What the rating page shows. 404 for a token that is not ours. */
  async prompt(token: string): Promise<CsatPrompt> {
    const ticket = await this.ticketFor(token);
    return {
      reference: formatTicketNumber(ticket.number),
      subject: ticket.subject,
      rating: await this.forTicket(ticket.id),
    };
  }

  submitWithToken(token: string, input: CsatSubmit, source: CsatSource): Promise<CsatView> {
    const ticketId = readToken(this.env.JWT_SECRET, TOKEN_PURPOSE, token);
    if (!ticketId) throw new NotFoundException('This rating link is not valid');
    return this.submit(ticketId, input, source);
  }

  /**
   * Stores the customer's rating, or changes the one they gave. Callers have
   * already established that the customer is the one asking.
   */
  async submit(ticketId: string, input: CsatSubmit, source: CsatSource): Promise<CsatView> {
    const row = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.lockRow(tx, ticketId);
      const problem = await this.whyNotRatable(ticket);
      if (problem) throw new ConflictException(problem);
      const [previous] = await tx
        .select()
        .from(csatResponses)
        .where(eq(csatResponses.ticketId, ticketId));
      const values = {
        rating: input.rating,
        comment: input.comment ?? null,
        source,
        handling: await this.handledBy(ticket),
        assigneeId: ticket.assigneeId,
      };
      const [saved] = await tx
        .insert(csatResponses)
        .values({ ticketId, customerId: ticket.customerId, ...values })
        .onConflictDoUpdate({
          target: csatResponses.ticketId,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();

      const ctx: RequestCtx = { actor: { type: 'customer', id: ticket.customerId } };
      const data = {
        rating: input.rating,
        previousRating: previous?.rating ?? null,
        hasComment: !!input.comment,
        source,
      };
      await this.audit.record(tx, ctx, {
        action: 'csat.submitted',
        targetType: 'ticket',
        targetId: ticketId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'csat.submitted',
        aggregateType: 'ticket',
        aggregateId: ticketId,
        payload: data,
      });
      return saved!;
    });
    return view(row);
  }

  async forTicket(ticketId: string): Promise<CsatView | null> {
    const [row] = await this.db
      .select()
      .from(csatResponses)
      .where(eq(csatResponses.ticketId, ticketId));
    return row ? view(row) : null;
  }

  /** Ratings by ticket id, for lists. */
  async ratings(ticketIds: string[]): Promise<Map<string, number>> {
    if (!ticketIds.length) return new Map();
    const rows = await this.db
      .select({ ticketId: csatResponses.ticketId, rating: csatResponses.rating })
      .from(csatResponses)
      .where(inArray(csatResponses.ticketId, ticketIds));
    return new Map(rows.map((r) => [r.ticketId, r.rating]));
  }

  /** Null when the ticket can be rated now; otherwise the reason, for the customer. */
  async whyNotRatable(ticket: Ticket): Promise<string | null> {
    const { category } = await this.workflow.status(ticket.status);
    if (category !== 'resolved' && category !== 'closed') {
      return 'This request is still open. You can rate it once it is solved.';
    }
    const since = ticket.resolvedAt ?? ticket.closedAt ?? ticket.updatedAt;
    if (Date.now() - since.getTime() > CSAT_WINDOW_DAYS * DAY_MS) {
      return `Ratings close ${CSAT_WINDOW_DAYS} days after a request is solved.`;
    }
    return null;
  }

  async wasAsked(ticketId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ ticketId: csatRequests.ticketId })
      .from(csatRequests)
      .where(eq(csatRequests.ticketId, ticketId));
    return !!row;
  }

  /** Notes that the customer was asked. False when they had been asked before. */
  async markAsked(ticketId: string, channel: 'email' | 'chat'): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(csatRequests)
        .values({ ticketId, channel })
        .onConflictDoNothing()
        .returning({ ticketId: csatRequests.ticketId });
      if (!inserted.length) return false;
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'csat.requested',
        targetType: 'ticket',
        targetId: ticketId,
        data: { channel },
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'csat.requested',
        aggregateType: 'ticket',
        aggregateId: ticketId,
        payload: { channel },
      });
      return true;
    });
  }

  /**
   * The rating question a returning chat visitor still owes an answer to: they
   * were asked in the chat, the ticket can still be rated, and they haven't.
   */
  async pendingChatPrompt(sessionId: string): Promise<ChatRatingPrompt | null> {
    const ticketIds = await this.conversations.ticketIdsForChatSession(sessionId);
    if (!ticketIds.length) return null;
    const asked = await this.db
      .select({ ticketId: csatRequests.ticketId })
      .from(csatRequests)
      .where(inArray(csatRequests.ticketId, ticketIds));
    const rated = await this.ratings(ticketIds);
    for (const { ticketId } of asked.reverse()) {
      if (rated.has(ticketId)) continue;
      const ticket = await this.tickets.get(ticketId);
      if (await this.whyNotRatable(ticket)) continue;
      return { token: this.tokenFor(ticketId), reference: ticket.reference };
    }
    return null;
  }

  private async ticketFor(token: string): Promise<Ticket> {
    const ticketId = readToken(this.env.JWT_SECRET, TOKEN_PURPOSE, token);
    if (!ticketId) throw new NotFoundException('This rating link is not valid');
    const ticket = await this.tickets.get(ticketId).catch(() => null);
    if (!ticket) throw new NotFoundException('This rating link is not valid');
    const problem = await this.whyNotRatable(ticket);
    if (problem) throw new BadRequestException(problem);
    return ticket;
  }

  private async handledBy(ticket: Ticket): Promise<HandledBy> {
    if (ticket.handling === 'ai') return 'ai';
    return (await this.aiRuns.workedOn(ticket.id)) ? 'ai_then_human' : 'human';
  }
}

function view(row: Response): CsatView {
  return {
    rating: row.rating,
    comment: row.comment,
    source: row.source as CsatSource,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
