import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { conversations } from './conversations';
import { tickets } from './tickets';

/**
 * One voice call (ADR 0018). The transcript lives in `messages` on the call's
 * conversation; this row holds what is about the call itself: when, how
 * long, who answered, and where the recording is until it is deleted.
 */
export const voiceCalls = pgTable(
  'voice_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Set when the caller first says something; a call with no speech has no ticket. */
    ticketId: uuid('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    /** active | ended */
    status: text('status').notNull().default('active'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    /** The caller's language as detected, e.g. hi. */
    language: text('language'),
    /** caller_hung_up | agent_ended | time_limit | error | server_shutdown */
    endedReason: text('ended_reason'),
    /** ai | human | both */
    answeredBy: text('answered_by'),
    agentUserId: uuid('agent_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** When the caller accepted the recording notice. */
    consentAt: timestamp('consent_at', { withTimezone: true }).notNull(),
    /** Object-storage key of the stereo WAV; null once deleted or when nothing was recorded. */
    recordingKey: text('recording_key'),
    recordingBytes: integer('recording_bytes'),
    recordingDeletedAt: timestamp('recording_deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('voice_calls_ticket_idx').on(t.ticketId),
    index('voice_calls_status_idx').on(t.status, t.startedAt),
  ],
);
