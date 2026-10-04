import { sql } from 'drizzle-orm';
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
import { timestamps, users } from './auth';
import { integrations } from './integrations';

/**
 * Where an integration wants to be told about events (ADR 0025). The signing
 * secret lives in `secrets` under `integration.wh-<id>.secret`, never here.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    description: text('description').notNull().default(''),
    /** Public event names from WEBHOOK_EVENTS. */
    events: text('events').array().notNull(),
    /** own | all */
    scope: text('scope').notNull().default('own'),
    isActive: boolean('is_active').notNull().default(true),
    /** Set when TMS switched it off after too many failures. */
    disabledReason: text('disabled_reason'),
    /** Deliveries in a row that failed for good; a success resets it. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastDeliveryAt: timestamp('last_delivery_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('webhook_subscriptions_integration_idx').on(t.integrationId)],
);

/**
 * The delivery log: one row per event per subscription. It holds identifiers
 * and outcomes, never the body that was sent: the body is built from current
 * data each time it is sent. A log, not audited per row (ADR 0025).
 */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
    /** The domain event this delivery is for; a test or a redelivery gets a fresh id. */
    eventId: uuid('event_id').notNull(),
    /** The public event name. */
    eventType: text('event_type').notNull(),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    /** Ids the body is built from (ticket, message, incident, approval) and status keys. */
    refs: jsonb('refs').$type<Record<string, unknown>>().notNull().default({}),
    /** pending | delivered | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    httpStatus: integer('http_status'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    redeliveryOf: uuid('redelivery_of'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    // An event is queued once per subscription, however often its handler is retried.
    uniqueIndex('webhook_deliveries_event_uq').on(t.subscriptionId, t.eventId),
    index('webhook_deliveries_subscription_idx').on(t.subscriptionId, t.createdAt),
    index('webhook_deliveries_created_idx').on(t.createdAt),
    index('webhook_deliveries_pending_idx')
      .on(t.createdAt)
      .where(sql`status = 'pending'`),
  ],
);
