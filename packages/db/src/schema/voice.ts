import {
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
    /** browser | phone. A phone call is answered by the phone agent at Sarvam (ADR 0034). */
    transport: text('transport').notNull().default('browser'),
    /** inbound | outbound */
    direction: text('direction').notNull().default('inbound'),
    /** Phone calls: the telephony side's id for the call (Sarvam's interaction id). */
    providerCallId: text('provider_call_id'),
    /** Phone calls: the caller's number as digits, set only by the token-protected hooks. */
    callerPhone: text('caller_phone'),
    /** Phone calls: why the phone agent asked for a person; applied when the call ends. */
    handoverReason: text('handover_reason'),
    /** Phone calls: tool calls made before the ticket existed, linked to it when the call ends. */
    toolCallIds: jsonb('tool_call_ids').$type<string[]>().notNull().default([]),
    /** Phone calls: how many transcript turns are on the ticket, so a retry never repeats one. */
    importedTurns: integer('imported_turns').notNull().default(0),
  },
  (t) => [
    index('voice_calls_ticket_idx').on(t.ticketId),
    index('voice_calls_status_idx').on(t.status, t.startedAt),
    uniqueIndex('voice_calls_provider_call_idx').on(t.providerCallId),
  ],
);
