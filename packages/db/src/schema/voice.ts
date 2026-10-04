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
import { customers } from './customers';
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
    /** requested | active | ended. `requested`: a call the desk is about to place. */
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
    /** browser | phone. A phone call is answered by the phone agent at Sarvam (ADR 0039). */
    transport: text('transport').notNull().default('browser'),
    /** Phone calls: sarvam | elevenlabs, whose voice agent took the call (ADR 0040). */
    provider: text('provider'),
    /** inbound | outbound */
    direction: text('direction').notNull().default('inbound'),
    /** Phone calls: the telephony side's id for the call (Sarvam's interaction id). */
    providerCallId: text('provider_call_id'),
    /** Calls the desk placed: Sarvam's id for the attempt, until the call's own id is known. */
    providerAttemptId: text('provider_attempt_id'),
    /** Calls the desk placed: a staff user's id, `customer` (asked on the shop) or `system`. */
    requestedBy: text('requested_by'),
    /** Calls the desk placed: connected | no_answer | busy | failed. */
    outcome: text('outcome'),
    /** Calls the desk placed: ticket | call_me | approval. */
    purpose: text('purpose'),
    /** Calls the desk placed: what the agent is to say the call is about. */
    about: text('about'),
    /** Calls the desk placed: who is being rung. Tools on that call act for this customer. */
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    /**
     * Phone calls: the other party's number as digits. On a call that came in, set only by
     * the token-protected hooks; on a call the desk placed, the number it rang.
     */
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
    index('voice_calls_attempt_idx').on(t.providerAttemptId),
  ],
);
