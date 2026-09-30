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
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
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
  async findByMessageIds(tx: DbOrTx, channel: Channel, channelMessageIds: string[]) {
    if (!channelMessageIds.length) return null;
    const [row] = await tx
      .select({ conversation: conversations })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(eq(messages.channel, channel), inArray(messages.channelMessageId, channelMessageIds)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    return row?.conversation ?? null;
  }

  async findLatestForTicket(tx: DbOrTx, ticketId: string, channel: Channel) {
    const [row] = await tx
      .select()
      .from(conversations)
      .where(and(eq(conversations.ticketId, ticketId), eq(conversations.channel, channel)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row ?? null;
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
    const convs = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.ticketId, ticketId))
      .orderBy(asc(conversations.createdAt));
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

  /** What a chat visitor sees: every message on their session's conversations. */
  async chatHistory(sessionId: string, limit = 100): Promise<ChatMessageView[]> {
    const rows = await this.db
      .select({ message: messages, authorName: users.name })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(users, eq(users.id, messages.authorUserId))
      .where(
        and(eq(conversations.channel, 'webchat'), eq(conversations.externalThreadId, sessionId)),
      )
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse().map((r) => toChatView(r.message, r.authorName));
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

  /** Records the outcome of a delivery attempt. */
  async markDelivery(
    ctx: RequestCtx,
    messageId: string,
    ticketId: string,
    status: DeliveryStatus,
    error?: string,
  ) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(messages)
        .set({
          deliveryStatus: status,
          deliveryError: error ?? null,
          ...(status === 'sent' ? { sentAt: new Date() } : {}),
        })
        .where(eq(messages.id, messageId));
      const data = { messageId, status, ...(error ? { error } : {}) };
      await this.audit.record(tx, ctx, {
        action: `message.${status === 'failed' ? 'delivery_failed' : 'delivered'}`,
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
    });
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

export function toChatView(m: Message, authorName?: string | null): ChatMessageView {
  return {
    id: m.id,
    body: m.body,
    authorType: m.authorType as MessageAuthor,
    // Visitors see an agent's first name only.
    authorName: m.authorType === 'agent' ? (authorName?.split(' ')[0] ?? 'Support') : null,
    createdAt: m.createdAt.toISOString(),
  };
}
