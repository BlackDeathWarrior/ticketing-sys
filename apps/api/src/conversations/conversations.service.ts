import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  conversations,
  type Database,
  type DbOrTx,
  type MessageAttachment,
  messages,
  users,
} from '@tms/db';
import type {
  Channel,
  ChatMessageView,
  ConversationController,
  DeliveryStatus,
  MessageAuthor,
} from '@tms/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { DB } from '../infra/tokens';

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;

export interface NewMessage {
  conversationId: string;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  authorType: MessageAuthor;
  authorUserId?: string | null;
  body: string;
  attachments?: MessageAttachment[];
  channelMessageId?: string | null;
  deliveryStatus?: DeliveryStatus | null;
  metadata?: Record<string, unknown>;
}

/** Owns the conversations and messages tables. */
@Injectable()
export class ConversationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async lock(tx: DbOrTx, id: string): Promise<Conversation> {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .for('update');
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  async get(id: string): Promise<Conversation> {
    const [row] = await this.db.select().from(conversations).where(eq(conversations.id, id));
    if (!row) throw new NotFoundException('Conversation not found');
    return row;
  }

  /** Most recent conversation for a channel thread key (chat session, email thread root). */
  async findByThread(tx: DbOrTx, channel: Channel, threadKey: string) {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.channel, channel), eq(conversations.externalThreadId, threadKey)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The conversation that contains the newest of the given provider message ids. */
  async findByMessageIds(tx: DbOrTx, channels: Channel[], channelMessageIds: string[]) {
    if (!channelMessageIds.length) return null;
    const [row] = await tx
      .select({ conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          inArray(messages.channel, channels),
          inArray(messages.channelMessageId, channelMessageIds),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row?.conversation ?? null;
  }

  async findLatestForTicket(tx: DbOrTx, ticketId: string, channels: Channel[]) {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.ticketId, ticketId), inArray(conversations.channel, channels)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** A customer's most recent conversation on a channel (WhatsApp has one thread per person). */
  async findLatestForCustomer(tx: DbOrTx, channel: Channel, customerId: string) {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.channel, channel), eq(conversations.customerId, customerId)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** When this number last wrote to us on WhatsApp, newest across its conversations. */
  async lastWhatsappInboundAt(phone: string): Promise<string | null> {
    const lastInbound = sql<string>`${conversations.metadata}->>'lastInboundAt'`;
    const [row] = await this.db
      .select({ at: lastInbound })
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, 'whatsapp'),
          // Digits to digits: a number stored with a leading + still matches.
          sql`regexp_replace(${conversations.metadata}->>'waPhone', '[^0-9]', '', 'g') = ${phone}`,
          sql`${lastInbound} is not null`,
        ),
      )
      .orderBy(sql`(${lastInbound})::timestamptz desc`)
      .limit(1);
    return row?.at ?? null;
  }

  /** Adds channel details to a conversation's metadata; undefined values are left alone. */
  async mergeMetadata(tx: DbOrTx, id: string, patch: Record<string, unknown>) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(defined).length) return;
    await tx
      .update(conversations)
      .set({ metadata: sql`${conversations.metadata} || ${JSON.stringify(defined)}::jsonb` })
      .where(eq(conversations.id, id));
  }

  /** Returns the existing message and its ticket if this provider id was already stored. */
  async findMessageByChannelId(tx: DbOrTx, channel: Channel, channelMessageId: string) {
    const [row] = await tx
      .select({ message: messages, ticketId: conversations.ticketId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.channel, channel), eq(messages.channelMessageId, channelMessageId)));
    return row ?? null;
  }

  /** Whether a provider message id is already stored (a redelivered webhook). */
  async hasChannelMessage(channel: Channel, channelMessageId: string): Promise<boolean> {
    return !!(await this.findMessageByChannelId(this.db, channel, channelMessageId));
  }

  async create(
    tx: DbOrTx,
    ctx: RequestCtx,
    input: {
      ticketId: string;
      customerId: string;
      channel: Channel;
      externalThreadId: string | null;
      controller?: ConversationController;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Conversation> {
    const [row] = await tx
      .insert(conversations)
      .values({
        ticketId: input.ticketId,
        customerId: input.customerId,
        channel: input.channel,
        externalThreadId: input.externalThreadId,
        controller: input.controller ?? 'none',
        metadata: input.metadata ?? {},
      })
      .returning();
    const data = { conversationId: row!.id, channel: row!.channel };
    await this.audit.record(tx, ctx, {
      action: 'conversation.created',
      targetType: 'ticket',
      targetId: input.ticketId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'conversation.created',
      aggregateType: 'ticket',
      aggregateId: input.ticketId,
      payload: data,
    });
    return row!;
  }

  async setThreadKey(tx: DbOrTx, id: string, threadKey: string) {
    await tx
      .update(conversations)
      .set({ externalThreadId: threadKey })
      .where(eq(conversations.id, id));
  }

  /** Inserts a message and bumps the conversation's last activity. Audit and events are the caller's. */
  async addMessage(tx: DbOrTx, input: NewMessage): Promise<Message> {
    const [row] = await tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        channel: input.channel,
        direction: input.direction,
        authorType: input.authorType,
        authorUserId: input.authorUserId ?? null,
        body: input.body,
        attachments: input.attachments ?? [],
        channelMessageId: input.channelMessageId ?? null,
        deliveryStatus: input.deliveryStatus ?? null,
        metadata: input.metadata ?? {},
        // The clock, not the transaction's start time (the column default): two
        // messages written in one transaction keep the order they were written in.
        createdAt: sql`clock_timestamp()`,
      })
      .returning();
    await tx
      .update(conversations)
      .set({ lastMessageAt: row!.createdAt })
      .where(eq(conversations.id, input.conversationId));
    return row!;
  }

  async setController(
    tx: DbOrTx,
    ctx: RequestCtx,
    conv: Conversation,
    controller: ConversationController,
    userId: string | null,
  ) {
    if (conv.controller === controller && conv.controllerUserId === userId) return;
    await tx
      .update(conversations)
      .set({ controller, controllerUserId: userId })
      .where(eq(conversations.id, conv.id));
    const data = { conversationId: conv.id, from: conv.controller, to: controller, userId };
    await this.audit.record(tx, ctx, {
      action: 'conversation.controller_changed',
      targetType: 'ticket',
      targetId: conv.ticketId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'conversation.controller_changed',
      aggregateType: 'ticket',
      aggregateId: conv.ticketId,
      payload: data,
    });
  }

  /** Provider ids of the email messages in a conversation, oldest first (for References). */
  async emailMessageIds(tx: DbOrTx, conversationId: string) {
    const rows = await tx
      .select({ id: messages.channelMessageId, direction: messages.direction })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.channelMessageId)))
      .orderBy(asc(messages.createdAt));
    return rows.filter((r): r is { id: string; direction: string } => !!r.id);
  }

  /** Conversations of a ticket with their messages and author names, oldest first. */
  async listForTicket(ticketId: string) {
    const convRows = await this.db
      .select({ conv: conversations, controllerName: users.name })
      .from(conversations)
      .leftJoin(users, eq(users.id, conversations.controllerUserId))
      .where(eq(conversations.ticketId, ticketId))
      .orderBy(asc(conversations.createdAt));
    // Who is answering, by name, so everyone (not only people who list users) sees it.
    const convs = convRows.map((r) => ({ ...r.conv, controllerName: r.controllerName }));
    if (!convs.length) return [];
    const rows = await this.db
      .select({ message: messages, authorName: users.name })
      .from(messages)
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(
        inArray(
          messages.conversationId,
          convs.map((c) => c.id),
        ),
      )
      .orderBy(asc(messages.createdAt));
    return convs.map((c) => ({
      ...c,
      messages: rows
        .filter((r) => r.message.conversationId === c.id)
        .map((r) => ({ ...r.message, authorName: r.authorName })),
    }));
  }

  /** For each ticket, the last message the customer could see, across its conversations. */
  async lastVisibleMessages(
    ticketIds: string[],
  ): Promise<
    Map<string, { conversationId: string; direction: string; authorType: string; createdAt: Date }>
  > {
    if (!ticketIds.length) return new Map();
    const rows = await this.db
      .selectDistinctOn([conversations.ticketId], {
        ticketId: conversations.ticketId,
        conversationId: conversations.id,
        direction: messages.direction,
        authorType: messages.authorType,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(inArray(conversations.ticketId, ticketIds), visibleToCustomer))
      .orderBy(conversations.ticketId, desc(messages.createdAt));
    return new Map(rows.map(({ ticketId, ...m }) => [ticketId, m]));
  }

  /** The tickets a chat session's conversations belong to, oldest first. */
  async ticketIdsForChatSession(sessionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ ticketId: conversations.ticketId })
      .from(conversations)
      .where(
        and(eq(conversations.channel, 'webchat'), eq(conversations.externalThreadId, sessionId)),
      )
      .orderBy(asc(conversations.createdAt));
    return [...new Set(rows.map((r) => r.ticketId))];
  }

  /** What a chat visitor sees: every message on their session's conversations. */
  async chatHistory(sessionId: string, limit = 100): Promise<ChatMessageView[]> {
    const rows = await this.db
      .select({ message: messages, authorName: users.name })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(
        and(
          eq(conversations.channel, 'webchat'),
          eq(conversations.externalThreadId, sessionId),
          visibleToCustomer,
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse().map((r) => toChatView(r.message, r.authorName));
  }

  /**
   * The conversation as the customer saw it (no drafts or discarded drafts),
   * oldest first, at most `limit` recent messages. Used as AI context.
   */
  async transcript(conversationId: string, limit = 30) {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), visibleToCustomer))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  /** The AI's rolling summary and the conversation's language. */
  async updateAiState(
    tx: DbOrTx,
    id: string,
    state: {
      summary?: string | null;
      language?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    const [current] = await tx.select().from(conversations).where(eq(conversations.id, id));
    if (!current) return;
    await tx
      .update(conversations)
      .set({
        ...(state.summary !== undefined ? { summary: state.summary } : {}),
        ...(state.language !== undefined ? { language: state.language } : {}),
        ...(state.metadata ? { metadata: { ...current.metadata, ...state.metadata } } : {}),
      })
      .where(eq(conversations.id, id));
  }

  /** Ids of AI drafts still waiting for review on a conversation. */
  async pendingDraftIds(tx: DbOrTx, conversationId: string): Promise<string[]> {
    const rows = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(eq(messages.conversationId, conversationId), eq(messages.deliveryStatus, 'draft')),
      );
    return rows.map((r) => r.id);
  }

  /** Locks a message row, for draft review. */
  async lockMessage(tx: DbOrTx, id: string): Promise<Message> {
    const [row] = await tx.select().from(messages).where(eq(messages.id, id)).for('update');
    if (!row) throw new NotFoundException('Message not found');
    return row;
  }

  /** Marks a draft approved (optionally with edited text) or discarded. Audit and events are the caller's. */
  async reviewDraft(
    tx: DbOrTx,
    id: string,
    review: { status: 'pending' | 'discarded'; body?: string; reviewedBy: string | null },
  ) {
    const current = await this.lockMessage(tx, id);
    await tx
      .update(messages)
      .set({
        deliveryStatus: review.status,
        ...(review.body !== undefined ? { body: review.body } : {}),
        metadata: {
          ...current.metadata,
          reviewedBy: review.reviewedBy,
          reviewedAt: new Date().toISOString(),
          ...(review.body !== undefined && review.body !== current.body ? { edited: true } : {}),
        },
      })
      .where(eq(messages.id, id));
  }

  async getMessage(id: string) {
    const [row] = await this.db
      .select({ message: messages, ticketId: conversations.ticketId })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, id));
    if (!row) throw new NotFoundException('Message not found');
    return row;
  }

  /** Everything a channel sender needs to deliver an outbound message. */
  async getForDelivery(messageId: string) {
    const [row] = await this.db
      .select({
        message: messages,
        conversation: conversations,
        authorName: users.name,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(eq(messages.id, messageId));
    return row ?? null;
  }

  /**
   * Records the outcome of a delivery attempt. `channelMessageId` is the id
   * the provider gave the message, so later status reports can find it.
   */
  async markDelivery(
    ctx: RequestCtx,
    messageId: string,
    ticketId: string,
    status: DeliveryStatus,
    error?: string,
    channelMessageId?: string,
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          deliveryStatus: status,
          deliveryError: error ?? null,
          ...(status === 'sent' ? { sentAt: new Date() } : {}),
          ...(channelMessageId ? { channelMessageId } : {}),
        })
        .where(eq(messages.id, messageId));
      await this.recordDelivery(tx, ctx, messageId, ticketId, status, error);
    });
  }

  /**
   * A provider's report on a message we sent (WhatsApp: sent, delivered, read,
   * failed). Reports can arrive late or out of order, so a status only ever
   * moves forward. Returns `unknown` when no message has that provider id.
   */
  async applyProviderStatus(
    channel: Channel,
    channelMessageId: string,
    status: 'sent' | 'delivered' | 'read' | 'failed',
    opts: { at: Date; error?: string },
  ): Promise<'applied' | 'ignored' | 'unknown'> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ message: messages, ticketId: conversations.ticketId })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.channel, channel),
            eq(messages.channelMessageId, channelMessageId),
            eq(messages.direction, 'outbound'),
          ),
        )
        .for('update', { of: messages });
      if (!row) return 'unknown';
      if (!statusAdvances(row.message.deliveryStatus, status)) return 'ignored';
      const stamp = status === 'delivered' ? 'deliveredAt' : status === 'read' ? 'readAt' : null;
      await tx
        .update(messages)
        .set({
          deliveryStatus: status,
          deliveryError: status === 'failed' ? (opts.error ?? 'Delivery failed') : null,
          ...(row.message.sentAt || status === 'failed' ? {} : { sentAt: opts.at }),
          ...(stamp
            ? { metadata: { ...row.message.metadata, [stamp]: opts.at.toISOString() } }
            : {}),
        })
        .where(eq(messages.id, row.message.id));
      await this.recordDelivery(
        tx,
        SYSTEM_CTX,
        row.message.id,
        row.ticketId,
        status,
        status === 'failed' ? opts.error : undefined,
      );
      return 'applied';
    });
  }

  private async recordDelivery(
    tx: DbOrTx,
    ctx: RequestCtx,
    messageId: string,
    ticketId: string,
    status: DeliveryStatus,
    error?: string,
  ) {
    const data = { messageId, status, ...(error ? { error } : {}) };
    await this.audit.record(tx, ctx, {
      action:
        status === 'failed'
          ? 'message.delivery_failed'
          : status === 'read'
            ? 'message.read'
            : 'message.delivered',
      targetType: 'ticket',
      targetId: ticketId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'message.delivery_updated',
      aggregateType: 'ticket',
      aggregateId: ticketId,
      payload: data,
    });
  }

  /**
   * Per channel: when a customer last wrote, when we last got a message out,
   * and what failed in the last 24 hours. For the channel status lights.
   */
  async channelActivity(): Promise<
    Record<
      string,
      {
        lastInboundAt: string | null;
        lastOutboundAt: string | null;
        failed24h: number;
        lastFailure: { at: string; reason: string } | null;
      }
    >
  > {
    const totals = await this.db
      .select({
        channel: messages.channel,
        lastInboundAt: sql<Date | null>`max(${messages.createdAt}) filter (where ${messages.direction} = 'inbound')`,
        lastOutboundAt: sql<Date | null>`max(${messages.sentAt}) filter (where ${messages.direction} = 'outbound')`,
        failed24h: sql<number>`(count(*) filter (where ${messages.deliveryStatus} = 'failed' and ${messages.createdAt} > now() - interval '24 hours'))::int`,
      })
      .from(messages)
      .where(sql`${messages.createdAt} > now() - interval '30 days'`)
      .groupBy(messages.channel);
    const failures = await this.db
      .selectDistinctOn([messages.channel], {
        channel: messages.channel,
        at: messages.createdAt,
        reason: messages.deliveryError,
      })
      .from(messages)
      .where(
        and(
          eq(messages.deliveryStatus, 'failed'),
          sql`${messages.createdAt} > now() - interval '24 hours'`,
        ),
      )
      .orderBy(messages.channel, desc(messages.createdAt));
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    return Object.fromEntries(
      totals.map((t) => {
        const failure = failures.find((f) => f.channel === t.channel);
        return [
          t.channel,
          {
            lastInboundAt: iso(t.lastInboundAt),
            lastOutboundAt: iso(t.lastOutboundAt),
            failed24h: t.failed24h,
            lastFailure: failure
              ? { at: failure.at.toISOString(), reason: failure.reason ?? 'Delivery failed' }
              : null,
          },
        ];
      }),
    );
  }

  /** Counts, for tests and health: messages still waiting to be delivered. */
  async pendingDeliveries(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.deliveryStatus, 'pending'));
    return row?.n ?? 0;
  }
}

const STATUS_ORDER: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3 };

/** Whether a provider's status report moves a message forward. Exported for tests. */
export function statusAdvances(current: string | null, incoming: string): boolean {
  // Failed is final, and drafts were never sent: neither takes reports.
  if (current === null || !(current in STATUS_ORDER)) return false;
  // A message that reached the phone can't fail afterwards.
  if (incoming === 'failed') return STATUS_ORDER[current]! < STATUS_ORDER.delivered!;
  return incoming in STATUS_ORDER && STATUS_ORDER[incoming]! > STATUS_ORDER[current]!;
}

/** Drafts and discarded drafts never reach the customer. */
const visibleToCustomer = or(
  isNull(messages.deliveryStatus),
  notInArray(messages.deliveryStatus, ['draft', 'discarded']),
);

export function toChatView(m: Message, authorName?: string | null): ChatMessageView {
  return {
    id: m.id,
    body: m.body,
    authorType: m.authorType as MessageAuthor,
    // Visitors see an agent's first name only, and plainly when it's the AI.
    authorName:
      m.authorType === 'agent'
        ? (authorName?.split(' ')[0] ?? 'Support')
        : m.authorType === 'ai'
          ? 'AI assistant'
          : null,
    createdAt: m.createdAt.toISOString(),
  };
}
