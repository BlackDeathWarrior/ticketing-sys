import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type Database, portalLogins } from '@tms/db';
import {
  type Channel,
  type CsatSubmit,
  type CsatView,
  PORTAL_LINK_MINUTES,
  PORTAL_LINKS_PER_ADDRESS,
  PORTAL_SESSION_MINUTES,
  type PortalMessage,
  type PortalSession,
  type PortalTicketDetail,
  type PortalTicketSummary,
  type StatusCategory,
} from '@tms/shared';
import { eq, lt } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { aiIsAnswering } from '../channels/ai-answering';
import { InboundService } from '../channels/inbound.service';
import type { RequestCtx } from '../common/request-context';
import { RateLimiterService } from '../common/rate-limit';
import { readToken, signToken } from '../common/signed-token';
import type { Env } from '../config/env';
import { ConversationsService } from '../conversations/conversations.service';
import { CsatService } from '../csat/csat.service';
import { CustomersService } from '../customers/customers.service';
import { DB, ENV } from '../infra/tokens';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { CustomerExperienceService } from '../settings/customer-experience.service';
import { StorageService } from '../storage/storage.service';
import { TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';

const LOGIN_PURPOSE = 'portal-login';
const AUDIENCE = 'tms-portal';
const ISSUER = 'tms';
const RATE_WINDOW_SECONDS = 15 * 60;

/** Who a portal request is from, once its session token has been checked. */
export interface PortalCustomer {
  customerId: string;
  email: string;
}

interface SessionClaims {
  sub: string;
  email: string;
  typ: 'portal';
}

/**
 * The customer portal (ADR 0019): sign-in by a one-time emailed link, then a
 * short session that can only ever reach that customer's own tickets. Every
 * read checks ownership; a ticket of someone else looks exactly like a ticket
 * that doesn't exist.
 */
@Injectable()
export class PortalService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly limiter: RateLimiterService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly experience: CustomerExperienceService,
    private readonly behaviour: AiBehaviourService,
    private readonly customers: CustomersService,
    private readonly tickets: TicketsService,
    private readonly workflow: WorkflowService,
    private readonly conversations: ConversationsService,
    private readonly inbound: InboundService,
    private readonly csat: CsatService,
    private readonly storage: StorageService,
  ) {}

  async assertEnabled(): Promise<void> {
    if (!(await this.experience.get()).portalEnabled) {
      throw new ForbiddenException('The customer portal is switched off');
    }
  }

  /**
   * Asks for a sign-in link. The answer is the same whether or not we know
   * the address, so the form can't be used to find out who is a customer.
   * The worker sends the email (PortalMailHandler).
   */
  async requestLink(email: string, ctx: RequestCtx): Promise<void> {
    await this.assertEnabled();
    // Always on, whatever RATE_LIMITS says: it protects a customer's inbox, not our servers.
    const allowance = await this.limiter.hit(
      'portal-links',
      createHash('sha256').update(email).digest('hex'),
      PORTAL_LINKS_PER_ADDRESS,
      RATE_WINDOW_SECONDS,
    );
    if (!allowance.allowed) {
      throw new HttpException(
        'Too many sign-in links were requested for this address. Try again in 15 minutes.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const customer = await this.customers.lookup('email', email);
    await this.db.transaction(async (tx) => {
      if (!customer) {
        await this.audit.record(tx, ctx, {
          action: 'portal.link_requested',
          targetType: 'customer',
          data: { known: false },
        });
        return;
      }
      const [login] = await tx
        .insert(portalLogins)
        .values({
          customerId: customer.id,
          email,
          expiresAt: new Date(Date.now() + PORTAL_LINK_MINUTES * 60_000),
        })
        .returning({ id: portalLogins.id });
      await this.audit.record(tx, ctx, {
        action: 'portal.link_requested',
        targetType: 'customer',
        targetId: customer.id,
        data: { known: true, loginId: login!.id },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'portal.link_requested',
        aggregateType: 'customer',
        aggregateId: customer.id,
        payload: { loginId: login!.id },
      });
    });
  }

  /** The email for a requested link, or null when it has expired or been used. */
  async linkMail(loginId: string): Promise<{ to: string; link: string; name: string } | null> {
    const [login] = await this.db.select().from(portalLogins).where(eq(portalLogins.id, loginId));
    if (!login || login.usedAt || login.expiresAt < new Date()) return null;
    const customer = await this.customers.findActive(this.db, login.customerId);
    const token = signToken(this.env.JWT_SECRET, LOGIN_PURPOSE, login.id);
    return {
      to: login.email,
      name: customer.displayName,
      link: `${this.env.HELP_CENTER_URL.replace(/\/?$/, '/')}#/portal/verify/${token}`,
    };
  }

  /** Trades a sign-in link's token for a session. The link works once. */
  async openSession(token: string): Promise<PortalSession> {
    await this.assertEnabled();
    const refused = new UnauthorizedException(
      'This sign-in link has expired or was already used. Ask for a new one.',
    );
    const loginId = readToken(this.env.JWT_SECRET, LOGIN_PURPOSE, token);
    if (!loginId) throw refused;

    const { customer, email } = await this.db.transaction(async (tx) => {
      const [login] = await tx
        .select()
        .from(portalLogins)
        .where(eq(portalLogins.id, loginId))
        .for('update');
      if (!login || login.usedAt || login.expiresAt < new Date()) throw refused;
      await tx.update(portalLogins).set({ usedAt: new Date() }).where(eq(portalLogins.id, loginId));
      const customer = await this.customers.findActive(tx, login.customerId);
      const ctx: RequestCtx = { actor: { type: 'customer', id: customer.id } };
      await this.audit.record(tx, ctx, {
        action: 'portal.signed_in',
        targetType: 'customer',
        targetId: customer.id,
        data: { loginId },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'portal.signed_in',
        aggregateType: 'customer',
        aggregateId: customer.id,
        payload: { loginId },
      });
      return { customer, email: login.email };
    });

    const claims: SessionClaims = { sub: customer.id, email, typ: 'portal' };
    return {
      token: await this.jwt.signAsync(claims, {
        secret: this.env.JWT_SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: `${PORTAL_SESSION_MINUTES}m`,
      }),
      expiresIn: PORTAL_SESSION_MINUTES * 60,
      customer: { name: customer.displayName, email },
    };
  }

  /** The customer behind a session token, or null. Staff tokens never pass: wrong audience. */
  async verifySession(token: string): Promise<PortalCustomer | null> {
    try {
      const c = await this.jwt.verifyAsync<SessionClaims>(token, {
        secret: this.env.JWT_SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (c.typ !== 'portal' || !c.sub || !c.email) return null;
      // Follows a merge, so the session keeps working if records were merged meanwhile.
      const customer = await this.customers.findActive(this.db, c.sub).catch(() => null);
      return customer ? { customerId: customer.id, email: c.email } : null;
    } catch {
      return null;
    }
  }

  async me(who: PortalCustomer) {
    const customer = await this.customers.findActive(this.db, who.customerId);
    return { name: customer.displayName, email: who.email };
  }

  async list(who: PortalCustomer): Promise<PortalTicketSummary[]> {
    const rows = await this.tickets.forCustomer(who.customerId);
    const [categories, ratings] = await Promise.all([
      this.categories(),
      this.csat.ratings(rows.map((t) => t.id)),
    ]);
    return rows.map((t) => ({
      reference: t.reference,
      subject: t.subject,
      channel: t.channel as Channel,
      status: categories.get(t.status) ?? 'open',
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      rating: ratings.get(t.id) ?? null,
    }));
  }

  async detail(who: PortalCustomer, reference: string): Promise<PortalTicketDetail> {
    const ticket = await this.owned(who, reference);
    const [categories, convs, rating, notRatable] = await Promise.all([
      this.categories(),
      this.conversations.listForTicket(ticket.id),
      this.csat.forTicket(ticket.id),
      this.csat.whyNotRatable(ticket),
    ]);
    const status = categories.get(ticket.status) ?? 'open';
    const messages: PortalMessage[] = convs
      .flatMap((c) => c.messages)
      // What the customer was sent or wrote: never drafts, and internal notes live elsewhere.
      .filter((m) => m.deliveryStatus !== 'draft' && m.deliveryStatus !== 'discarded')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({
        id: m.id,
        from: m.authorType === 'customer' ? 'you' : m.authorType === 'ai' ? 'assistant' : 'support',
        name: m.authorType === 'agent' ? (m.authorName?.split(' ')[0] ?? null) : null,
        body: m.body,
        channel: m.channel as Channel,
        createdAt: m.createdAt.toISOString(),
        attachments: m.attachments.map((a, index) => ({
          index,
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
      }));
    const last = messages.at(-1);
    return {
      reference: ticket.reference,
      subject: ticket.subject,
      channel: ticket.channel as Channel,
      status,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      messages,
      canReply: status !== 'closed',
      replying: aiIsAnswering({
        heldBy: ticket.handling,
        // The AI answers where the customer last wrote.
        mode: last ? await this.behaviour.modeFor(last.channel) : 'off',
        customerWroteLast: last?.from === 'you',
        settled: status === 'resolved' || status === 'closed',
      }),
      canRate: !notRatable,
      rating,
    };
  }

  /**
   * A reply typed in the portal. It joins the ticket as a customer message on
   * its email thread (one is started if the ticket has none), so the answer
   * reaches the customer by email and shows here too.
   */
  async reply(who: PortalCustomer, reference: string, body: string): Promise<PortalTicketDetail> {
    const ticket = await this.owned(who, reference);
    const { category } = await this.workflow.status(ticket.status);
    if (category === 'closed') {
      throw new ConflictException('This request is closed. Please submit a new request.');
    }
    await this.inbound.handle({
      channel: 'email',
      threadKey: `portal-${ticket.id}`,
      channelMessageId: `<portal-${randomUUID()}@portal>`,
      from: { identity: { type: 'email', value: who.email } },
      subject: ticket.subject,
      text: body,
      receivedAt: new Date().toISOString(),
      metadata: { via: 'portal' },
      ticket: { id: ticket.id },
    });
    return this.detail(who, reference);
  }

  async rate(who: PortalCustomer, reference: string, input: CsatSubmit): Promise<CsatView> {
    const ticket = await this.owned(who, reference);
    return this.csat.submit(ticket.id, input, 'portal');
  }

  async attachment(who: PortalCustomer, reference: string, messageId: string, index: number) {
    const ticket = await this.owned(who, reference);
    const { message, ticketId } = await this.conversations.getMessage(messageId);
    const file = message.attachments[index];
    const hidden = message.deliveryStatus === 'draft' || message.deliveryStatus === 'discarded';
    if (ticketId !== ticket.id || hidden || !file) {
      throw new NotFoundException('Attachment not found');
    }
    return { file, stream: await this.storage.get(file.key) };
  }

  /** The ticket, if it is this customer's. Otherwise it "doesn't exist". */
  private async owned(who: PortalCustomer, reference: string) {
    const ticket = await this.tickets.get(reference).catch(() => null);
    if (!ticket || ticket.customerId !== who.customerId) {
      throw new NotFoundException('Request not found');
    }
    return ticket;
  }

  private async categories(): Promise<Map<string, StatusCategory>> {
    const { statuses } = await this.workflow.load();
    return new Map(statuses.map((s) => [s.key, s.category as StatusCategory]));
  }

  /** Deletes sign-in links that expired before `before`. */
  async purgeLogins(before: Date): Promise<number> {
    const rows = await this.db
      .delete(portalLogins)
      .where(lt(portalLogins.expiresAt, before))
      .returning({ id: portalLogins.id });
    return rows.length;
  }
}
