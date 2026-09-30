import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { conversations } from './conversations';
import { tickets } from './tickets';

/**
 * One row per AI step the agent took: a conversation turn or a ticket
 * classification. Everything needed to explain what the AI did and why:
 * model, prompt version, tools called, knowledge chunks used, confidence,
 * the rules that capped it, and the decision.
 */
export const aiRuns = pgTable(
  'ai_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** turn | classify */
    kind: text('kind').notNull(),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    triggerMessageId: uuid('trigger_message_id'),
    /** sent | drafted | handover | skipped | error */
    decision: text('decision').notNull(),
    confidence: doublePrecision('confidence'),
    /** What the model said about itself, before rules. */
    selfConfidence: doublePrecision('self_confidence'),
    rules: text('rules').array().notNull().default([]),
    model: text('model'),
    promptVersion: text('prompt_version').notNull(),
    tools: jsonb('tools').$type<Array<{ name: string; summary: string }>>().notNull().default([]),
    sources: jsonb('sources')
      .$type<Array<{ chunkId: string; label: string }>>()
      .notNull()
      .default([]),
    replyMessageId: uuid('reply_message_id'),
    language: text('language'),
    intent: text('intent'),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ai_runs_ticket_idx').on(t.ticketId, t.createdAt),
    index('ai_runs_conversation_idx').on(t.conversationId, t.createdAt),
  ],
);
