import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { conversations } from './conversations';
import { tickets } from './tickets';

/**
 * MCP servers that expose company systems (orders, payments, CRM) as tools.
 * The token lives in `secrets` under `tool.<slug>.token`, never here.
 */
export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  url: text('url').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** Header carrying the token (`Authorization` sends `Bearer <token>`). */
  authHeader: text('auth_header'),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A tool as last listed by its server, with the admin's settings. New tools start disabled. */
export const tools = pgTable(
  'tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    title: text('title'),
    description: text('description').notNull().default(''),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull().default({}),
    /** Hints the server gave (readOnlyHint, destructiveHint, ...). */
    annotations: jsonb('annotations').$type<Record<string, unknown>>().notNull().default({}),
    enabled: boolean('enabled').notNull().default(false),
    /** read | write | transactional */
    tier: text('tier').notNull().default('read'),
    timeoutMs: integer('timeout_ms').notNull().default(8000),
    /** Argument filled with the ticket customer's email and hidden from the model. */
    customerArg: text('customer_arg'),
    /** Gone from the server at the last sync; kept for history, never offered. */
    missing: boolean('missing').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('tools_server_name_idx').on(t.serverId, t.name)],
);

/** Every tool invocation, by the AI or by an admin's test, with its outcome. */
export const toolCalls = pgTable(
  'tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolId: uuid('tool_id')
      .notNull()
      .references(() => tools.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** ai | user */
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    /** Arguments as sent, including the injected customer argument. */
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default({}),
    /** ok | error | denied | awaiting_approval | approved | rejected | expired */
    status: text('status').notNull(),
    result: jsonb('result'),
    error: text('error'),
    latencyMs: integer('latency_ms'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('tool_calls_ticket_idx').on(t.ticketId, t.createdAt)],
);

/** A transactional tool call waiting for (or decided by) a supervisor. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toolCallId: uuid('tool_call_id')
      .notNull()
      .unique()
      .references(() => toolCalls.id, { onDelete: 'cascade' }),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** pending | approved | rejected | expired */
    status: text('status').notNull().default('pending'),
    summary: text('summary').notNull(),
    reasoning: text('reasoning'),
    evidence: text('evidence'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('approvals_status_idx').on(t.status, t.createdAt),
    index('approvals_ticket_idx').on(t.ticketId),
  ],
);
