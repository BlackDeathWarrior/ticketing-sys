import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { teams, timestamps, users } from './auth';
import { customers } from './customers';
import { integrations } from './integrations';
import { slaPolicies } from './operations';

export const ticketStatuses = pgTable('ticket_statuses', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  /** open | pending | resolved | closed */
  category: text('category').notNull(),
  sortOrder: integer('sort_order').notNull().default(100),
  isInitial: boolean('is_initial').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
});

export const workflowTransitions = pgTable(
  'workflow_transitions',
  {
    fromStatus: text('from_status')
      .notNull()
      .references(() => ticketStatuses.key, { onDelete: 'cascade' }),
    toStatus: text('to_status')
      .notNull()
      .references(() => ticketStatuses.key, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => categories.id, {
      onDelete: 'cascade',
    }),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('categories_parent_name_uq').on(
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
  ],
);

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Human-facing number, shown as TMS-<number>. */
    number: bigserial('number', { mode: 'number' }).notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    channel: text('channel').notNull(),
    subject: text('subject').notNull(),
    description: text('description'),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    subcategoryId: uuid('subcategory_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    priority: text('priority').notNull().default('normal'),
    status: text('status')
      .notNull()
      .references(() => ticketStatuses.key),
    /** The SLA policy whose timers run on this ticket (ADR 0014). */
    slaPolicyId: uuid('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    /** ok | at_risk | breached | paused | met: the most urgent timer, for the queue. */
    slaState: text('sla_state'),
    /** When the most urgent running timer is due. */
    slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
    /** none | ai | human | handed_over: who is answering right now. */
    handling: text('handling').notNull().default('none'),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    assigneeId: uuid('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    resolution: text('resolution'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** What the AI classifier suggested (category, priority, language, intent, sentiment). */
    aiClassification: jsonb('ai_classification').$type<Record<string, unknown>>(),
    /** The integration that raised the ticket through the API (ADR 0023). */
    integrationId: uuid('integration_id').references(() => integrations.id, {
      onDelete: 'set null',
    }),
    /** That system's id for what the ticket is about: an order, a listing, a job. */
    externalRef: text('external_ref'),
    /** Context it sent along, shown to agents and given to the AI as data. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('tickets_status_idx').on(t.status),
    index('tickets_assignee_idx').on(t.assigneeId),
    index('tickets_team_idx').on(t.teamId),
    index('tickets_customer_idx').on(t.customerId),
    index('tickets_created_idx').on(t.createdAt),
    index('tickets_sla_idx').on(t.slaState, t.slaDueAt),
    index('tickets_handling_idx').on(t.handling),
    index('tickets_resolved_idx').on(t.resolvedAt),
    index('tickets_tags_gin').using('gin', t.tags),
    index('tickets_subject_trgm').using('gin', sql`${t.subject} gin_trgm_ops`),
    index('tickets_integration_idx').on(t.integrationId, t.externalRef),
  ],
);

export const internalNotes = pgTable(
  'internal_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** user | ai | system */
    authorType: text('author_type').notNull().default('user'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('internal_notes_ticket_idx').on(t.ticketId)],
);
