import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { categories, tickets } from './tickets';

/**
 * What a rating says about the AI's work on one ticket (ADR 0020): the
 * rating, the topic, and the knowledge base documents the AI's answers
 * cited. Written when the rating arrives, so later re-indexing of a document
 * or re-categorising of the ticket doesn't change what was learned.
 */
export const aiFeedback = pgTable(
  'ai_feedback',
  {
    ticketId: uuid('ticket_id')
      .primaryKey()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** 1 to 5. */
    rating: integer('rating').notNull(),
    /** ai | ai_then_human: who had the ticket when it was rated. */
    handledBy: text('handled_by').notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    /** Knowledge base documents the AI's sent answers cited. */
    documentIds: uuid('document_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    ratedAt: timestamp('rated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_feedback_rated_idx').on(t.ratedAt)],
);

/** Guidance a person wrote for the AI after reading feedback. Active lessons go into its prompt. */
export const aiLessons = pgTable('ai_lessons', {
  id: uuid('id').primaryKey().defaultRandom(),
  body: text('body').notNull(),
  /** Null: applies to every ticket. */
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
  sourceTicketId: uuid('source_ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A rated ticket waiting for someone to decide what the AI should learn from it. */
export const learningReviews = pgTable(
  'learning_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .unique()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    /** low_rating | good_answer */
    kind: text('kind').notNull(),
    /** open | done | dismissed */
    status: text('status').notNull().default('open'),
    /** lesson | kb | none */
    outcome: text('outcome'),
    rating: integer('rating').notNull(),
    lessonId: uuid('lesson_id').references(() => aiLessons.id, { onDelete: 'set null' }),
    /** The knowledge base draft created from it. */
    documentId: uuid('document_id'),
    closedBy: uuid('closed_by').references(() => users.id, { onDelete: 'set null' }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('learning_reviews_status_idx').on(t.status, t.createdAt)],
);
