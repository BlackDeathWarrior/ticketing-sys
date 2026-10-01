import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { customers } from './customers';
import { tickets } from './tickets';

/**
 * One rating per ticket (ADR 0019). `handling` and `assigneeId` are copied
 * from the ticket when the rating is given, so a report on last month doesn't
 * change when the ticket is reassigned later.
 */
export const csatResponses = pgTable(
  'csat_responses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .unique()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** 1 to 5. */
    rating: integer('rating').notNull(),
    comment: text('comment'),
    /** email | chat | portal */
    source: text('source').notNull(),
    /** ai | ai_then_human | human: who handled the ticket when it was rated. */
    handling: text('handling').notNull(),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('csat_responses_created_idx').on(t.createdAt)],
);

/** A survey that was sent or shown: at most one per ticket, so nobody is asked twice. */
export const csatRequests = pgTable(
  'csat_requests',
  {
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** email | chat */
    channel: text('channel').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('csat_requests_requested_idx').on(t.requestedAt)],
);

/**
 * A sign-in link to the customer portal. The link's secret is derived from
 * this row's id with a server key, so it is never stored. A link works once.
 */
export const portalLogins = pgTable(
  'portal_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('portal_logins_expires_idx').on(t.expiresAt)],
);
