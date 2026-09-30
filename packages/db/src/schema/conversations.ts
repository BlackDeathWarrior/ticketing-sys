import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamps, users } from './auth';
import { customers } from './customers';
import { tickets } from './tickets';

/**
 * A live thread on one channel. `controller` decides who replies to the next
 * inbound message: the AI agent, a named human, or nobody (email queue).
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    channel: text('channel').notNull(),
    /** Channel-side thread key: email Message-ID root, WhatsApp number, chat session id. */
    externalThreadId: text('external_thread_id'),
    controller: text('controller').notNull().default('none'),
    controllerUserId: uuid('controller_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    state: text('state').notNull().default('open'),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('conversations_ticket_idx').on(t.ticketId),
    index('conversations_thread_idx').on(t.channel, t.externalThreadId),
  ],
);

export interface MessageAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    direction: text('direction').notNull(),
    /** customer | ai | agent | system */
    authorType: text('author_type').notNull(),
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull().default(''),
    attachments: jsonb('attachments').$type<MessageAttachment[]>().notNull().default([]),
    /** Provider message id; unique per channel so webhook retries are idempotent. */
    channelMessageId: text('channel_message_id'),
    deliveryStatus: text('delivery_status'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_channel_msg_uq').on(t.channel, t.channelMessageId),
  ],
);
