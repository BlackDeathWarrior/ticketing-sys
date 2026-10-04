import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { integrations } from './integrations';
import { tickets } from './tickets';

/**
 * A problem an integration reported about itself (ADR 0024): a failed job, a
 * blocked source, stale data. Reports with the same fingerprint are counted
 * on one open incident, which one ticket tracks.
 */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** Chosen by the app: what makes two reports the same problem. */
    fingerprint: text('fingerprint').notNull(),
    /** open | resolved */
    status: text('status').notNull().default('open'),
    /** info | warning | error | critical: the worst reported while open. */
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    source: text('source'),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    /** Reports received while open. A counter, not audited per report. */
    occurrences: integer('occurrences').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    // At most one open incident per fingerprint.
    uniqueIndex('incidents_open_uq')
      .on(t.integrationId, t.fingerprint)
      .where(sql`status = 'open'`),
    index('incidents_integration_idx').on(t.integrationId, t.lastSeenAt),
    index('incidents_ticket_idx').on(t.ticketId),
  ],
);
