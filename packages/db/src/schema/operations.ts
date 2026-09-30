import {
  boolean,
  date,
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
import { teams, users } from './auth';
import { conversations } from './conversations';
import { tickets } from './tickets';

/**
 * Handover, routing, SLA and notifications (Phase 7, ADR 0014).
 */

/** Each time a conversation was passed to people, with the context pack written for them. */
export const handovers = pgTable(
  'handovers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** ai | agent | customer */
    source: text('source').notNull(),
    reason: text('reason').notNull(),
    rules: text('rules').array().notNull().default([]),
    pack: jsonb('pack').$type<Record<string, unknown>>(),
    /** pending | ready | failed */
    packStatus: text('pack_status').notNull().default('pending'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    routedTeamId: uuid('routed_team_id').references(() => teams.id, { onDelete: 'set null' }),
    routedUserId: uuid('routed_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('handovers_ticket_idx').on(t.ticketId, t.createdAt)],
);

/** Ordered rules: the first enabled rule whose conditions match picks the team. */
export const routingRules = pgTable('routing_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
  teamId: uuid('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  /** least_loaded | round_robin | team_queue */
  strategy: text('strategy').notNull().default('least_loaded'),
  requiredSkill: text('required_skill'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userSkills = pgTable(
  'user_skills',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    skill: text('skill').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.skill] })],
);

export const agentPresence = pgTable('agent_presence', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** online | away | offline */
  status: text('status').notNull().default('offline'),
  /** Open assigned tickets before routing skips them. */
  capacity: integer('capacity').notNull().default(5),
  /** When routing last gave them a ticket (round robin order). */
  lastRoutedAt: timestamp('last_routed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const businessHours = pgTable('business_hours', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  schedule: jsonb('schedule')
    .$type<Array<{ day: number; start: string; end: string }>>()
    .notNull()
    .default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const holidays = pgTable(
  'holidays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessHoursId: uuid('business_hours_id')
      .notNull()
      .references(() => businessHours.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('holidays_day_idx').on(t.businessHoursId, t.date)],
);

export const slaPolicies = pgTable('sla_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priority: text('priority'),
  customerType: text('customer_type'),
  firstResponseMinutes: integer('first_response_minutes').notNull(),
  resolutionMinutes: integer('resolution_minutes').notNull(),
  businessHoursId: uuid('business_hours_id').references(() => businessHours.id, {
    onDelete: 'set null',
  }),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One timer per ticket and kind. `dueAt` is in wall-clock time, computed from
 * the business minutes left; while paused it is null and `consumedMinutes`
 * holds the business minutes already used.
 */
export const slaTimers = pgTable(
  'sla_timers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
    /** first_response | resolution */
    kind: text('kind').notNull(),
    /** running | paused | met | breached */
    state: text('state').notNull(),
    targetMinutes: integer('target_minutes').notNull(),
    consumedMinutes: integer('consumed_minutes').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    /** When the current running stretch began (after a pause). */
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    atRiskAt: timestamp('at_risk_at', { withTimezone: true }),
    atRiskNotified: boolean('at_risk_notified').notNull().default(false),
    metAt: timestamp('met_at', { withTimezone: true }),
    breachedAt: timestamp('breached_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sla_timers_ticket_kind_idx').on(t.ticketId, t.kind),
    index('sla_timers_due_idx').on(t.state, t.dueAt),
  ],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
    /** Dedupes repeated events (e.g. one breach notice per timer per user). */
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_idx').on(t.userId, t.createdAt),
    uniqueIndex('notifications_dedupe_idx').on(t.userId, t.dedupeKey),
  ],
);
