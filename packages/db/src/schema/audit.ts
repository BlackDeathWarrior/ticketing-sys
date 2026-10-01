import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Append-only record of who did what. A database trigger rejects UPDATE and
 * DELETE (see the audit_log_append_only migration).
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** user | system | ai | customer */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    requestId: text('request_id'),
    ip: text('ip'),
  },
  (t) => [
    index('audit_target_idx').on(t.targetType, t.targetId, t.id),
    index('audit_actor_idx').on(t.actorId, t.id),
    index('audit_occurred_idx').on(t.occurredAt),
  ],
);

/** Transactional outbox. Rows are written with the change and relayed by the worker. */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').notNull().unique().defaultRandom(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** W3C traceparent of the request that wrote the event, so the worker continues its trace. */
    traceContext: text('trace_context'),
  },
  (t) => [
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`published_at IS NULL`),
  ],
);
