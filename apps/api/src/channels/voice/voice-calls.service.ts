import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, users, voiceCalls } from '@tms/db';
import {
  type PhoneCallOutcome,
  type PhoneCallPurpose,
  type PhoneProviderId,
  VOICE_RECORDING_DAYS,
  type VoiceCallView,
  type VoiceEndReason,
  type VoiceState,
} from '@tms/shared';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { StorageService } from '../../storage/storage.service';

export type CallRow = typeof voiceCalls.$inferSelect;
/** A call's audio: a WAV from our own call engine or Sarvam, an MP3 from ElevenLabs. */
export interface CallRecording {
  audio: Buffer;
  type: 'audio/wav' | 'audio/mpeg';
}
const EXTENSIONS: Record<CallRecording['type'], string> = {
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
};
const DAY_MS = 86_400_000;
/** How long after the desk rang a number a tool request from it is taken to be that call. */
const ADOPT_MINUTES = 5;

/**
 * The record of voice calls: when, how long, who answered, and the
 * recording until it is deleted (ADR 0018). The live side of a call is
 * VoiceService; this service is also used by the worker's retention job.
 */
@Injectable()
export class VoiceCallsService {
  private readonly logger = new Logger(VoiceCallsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
  ) {}

  /** A call begins. The caller accepted the recording notice just now. */
  async begin(): Promise<CallRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(voiceCalls).values({ consentAt: new Date() }).returning();
      await this.changed(tx, SYSTEM_CTX, 'voice.call_started', row!, {});
      return row!;
    });
  }

  /** The caller spoke: the call now belongs to a ticket. */
  async attach(id: string, ticketId: string, conversationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ ticketId, conversationId })
        .where(eq(voiceCalls.id, id))
        .returning();
      if (row) await this.changed(tx, SYSTEM_CTX, 'voice.call_updated', row, { attached: true });
    });
  }

  async agentJoined(ctx: RequestCtx, id: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ agentUserId: userId })
        .where(eq(voiceCalls.id, id))
        .returning();
      if (row) await this.changed(tx, ctx, 'voice.call_updated', row, { agentJoined: userId });
    });
  }

  /** The call is over. The recording, if any, is stored first. */
  async finish(
    id: string,
    result: {
      reason: VoiceEndReason;
      seconds: number;
      language: string | null;
      answeredBy: 'ai' | 'human' | 'both' | null;
      /** A Buffer is a WAV from our own call engine. */
      recording: CallRecording | Buffer | null;
    },
  ): Promise<void> {
    const recording = Buffer.isBuffer(result.recording)
      ? ({ audio: result.recording, type: 'audio/wav' } as const)
      : result.recording;
    const recordingKey = recording ? await this.store(id, recording) : null;
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({
          status: 'ended',
          endedAt: new Date(),
          durationSeconds: result.seconds,
          endedReason: result.reason,
          language: result.language,
          answeredBy: result.answeredBy,
          // A call the desk placed: it connected if somebody spoke on it.
          outcome: sql`case when ${voiceCalls.direction} = 'outbound' then ${result.answeredBy ? 'connected' : 'no_answer'} else ${voiceCalls.outcome} end`,
          recordingKey,
          recordingBytes: recordingKey ? recording!.audio.length : null,
        })
        .where(and(eq(voiceCalls.id, id), eq(voiceCalls.status, 'active')))
        .returning();
      if (!row) return;
      await this.changed(tx, SYSTEM_CTX, 'voice.call_ended', row, {
        reason: result.reason,
        seconds: result.seconds,
        recorded: !!recordingKey,
      });
    });
  }

  /** Puts a call's audio in object storage. Null when storage is off or the upload failed. */
  private async store(id: string, recording: CallRecording): Promise<string | null> {
    if (!this.storage.enabled) return null;
    const now = new Date();
    const key = `recordings/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${EXTENSIONS[recording.type]}`;
    try {
      await this.storage.put(key, recording.audio, recording.type);
      return key;
    } catch (err) {
      this.logger.error(`recording of call ${id} was not stored: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A recording that arrived after the call was closed (a phone call's audio
   * is fetched from its provider and may be ready later than its transcript). Only
   * for a call that has none and whose recording was not already deleted.
   */
  async attachRecording(id: string, recording: CallRecording): Promise<boolean> {
    const call = await this.get(id);
    if (call.status !== 'ended' || call.recordingKey || call.recordingDeletedAt) return false;
    const recordingKey = await this.store(id, recording);
    if (!recordingKey) return false;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ recordingKey, recordingBytes: recording.audio.length })
        .where(and(eq(voiceCalls.id, id), isNull(voiceCalls.recordingKey)))
        .returning();
      if (!row) return false;
      await this.changed(tx, SYSTEM_CTX, 'voice.call_updated', row, { recorded: true });
      return true;
    });
  }

  // ---- Phone calls (ADR 0039): the call happens at Sarvam, we hear about it through hooks ----

  /**
   * The phone agent told us about a call (its start hook, or the first tool
   * it used). Asked again for the same call, this returns the same row, and
   * fills in the caller's number if it was not known yet.
   */
  async beginPhone(i: {
    provider: PhoneProviderId;
    interactionId: string;
    phone: string | null;
  }): Promise<CallRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(voiceCalls)
        .values({
          transport: 'phone',
          provider: i.provider,
          providerCallId: i.interactionId,
          callerPhone: i.phone,
          // The phone agent's greeting says the call is transcribed.
          consentAt: new Date(),
        })
        .onConflictDoNothing({ target: voiceCalls.providerCallId })
        .returning();
      if (created) {
        await this.changed(tx, SYSTEM_CTX, 'voice.call_started', created, { transport: 'phone' });
        return created;
      }
      const [existing] = await tx
        .select()
        .from(voiceCalls)
        .where(eq(voiceCalls.providerCallId, i.interactionId));
      if (i.phone && !existing!.callerPhone) {
        const [row] = await tx
          .update(voiceCalls)
          .set({ callerPhone: i.phone })
          .where(eq(voiceCalls.id, existing!.id))
          .returning();
        return row!;
      }
      return existing!;
    });
  }

  /**
   * The phone call this number is on right now, for a tool request that could
   * not say which call it belongs to: the newest one still open that began in
   * the last two hours.
   */
  async activeForCaller(phone: string, now = new Date()): Promise<CallRow | null> {
    const [row] = await this.db
      .select()
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.status, 'active'),
          eq(voiceCalls.transport, 'phone'),
          eq(voiceCalls.callerPhone, phone),
          gt(voiceCalls.startedAt, new Date(now.getTime() - 2 * 60 * 60_000)),
        ),
      )
      .orderBy(desc(voiceCalls.startedAt))
      .limit(1);
    return row ?? null;
  }

  async byProvider(interactionId: string): Promise<CallRow | null> {
    const [row] = await this.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.providerCallId, interactionId));
    return row ?? null;
  }

  /**
   * A tool call made before the call has a ticket; linked to it when the call
   * ends. Bookkeeping for that link, so it is not audited (the tool call is).
   */
  async noteToolCall(id: string, toolCallId: string): Promise<void> {
    await this.db
      .update(voiceCalls)
      .set({
        toolCallIds: sql`${voiceCalls.toolCallIds} || ${JSON.stringify([toolCallId])}::jsonb`,
      })
      .where(eq(voiceCalls.id, id));
  }

  /** The phone agent asked for a person; the handover is made when the call ends. */
  async markHandover(id: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ handoverReason: reason.slice(0, 500) })
        .where(eq(voiceCalls.id, id))
        .returning();
      if (row) await this.changed(tx, SYSTEM_CTX, 'voice.call_updated', row, { handover: true });
    });
  }

  /**
   * An action that needs approval, asked for on a call that has no ticket yet. Kept for the
   * job that writes the ticket. Bookkeeping: the approval itself is audited when it is made.
   */
  async notePendingApproval(id: string, entry: { toolId: string; args: string }): Promise<void> {
    await this.db
      .update(voiceCalls)
      .set({
        pendingApprovals: sql`${voiceCalls.pendingApprovals} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(eq(voiceCalls.id, id));
  }

  /** What is still to be asked for, after one request was. */
  async setPendingApprovals(
    id: string,
    left: Array<{ toolId: string; args: string }>,
  ): Promise<void> {
    await this.db.update(voiceCalls).set({ pendingApprovals: left }).where(eq(voiceCalls.id, id));
  }

  /** Whether this conversation is a phone call's (and not a call in the browser). */
  async isPhoneConversation(conversationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: voiceCalls.id })
      .from(voiceCalls)
      .where(and(eq(voiceCalls.conversationId, conversationId), eq(voiceCalls.transport, 'phone')))
      .limit(1);
    return !!row;
  }

  /** How far the transcript has been written to the ticket. A counter: not audited. */
  async importedUpTo(id: string, turns: number): Promise<void> {
    await this.db.update(voiceCalls).set({ importedTurns: turns }).where(eq(voiceCalls.id, id));
  }

  /** Phone calls still open long after they began: the "ended" trigger never came. */
  async stalePhoneCalls(
    olderThanMinutes: number,
    giveUpAfterMinutes: number,
    now = new Date(),
  ): Promise<CallRow[]> {
    return this.db
      .select()
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.status, 'active'),
          eq(voiceCalls.transport, 'phone'),
          lt(voiceCalls.startedAt, new Date(now.getTime() - olderThanMinutes * 60_000)),
          gt(voiceCalls.startedAt, new Date(now.getTime() - giveUpAfterMinutes * 60_000)),
        ),
      )
      .limit(100);
  }

  // ---- Calls the desk places (ADR 0040) ----

  /** A call is asked for. The worker places it; nothing has rung yet. */
  async requestOutbound(
    ctx: RequestCtx,
    i: {
      provider: PhoneProviderId;
      phone: string;
      customerId: string;
      ticketId: string | null;
      purpose: PhoneCallPurpose;
      requestedBy: string;
      about: string | null;
    },
  ): Promise<CallRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(voiceCalls)
        .values({
          transport: 'phone',
          direction: 'outbound',
          status: 'requested',
          provider: i.provider,
          callerPhone: i.phone,
          customerId: i.customerId,
          ticketId: i.ticketId,
          purpose: i.purpose,
          requestedBy: i.requestedBy,
          about: i.about,
          // The phone agent says the call is transcribed when it opens.
          consentAt: new Date(),
        })
        .returning();
      await this.changed(tx, ctx, 'voice.call_requested', row!, {
        purpose: i.purpose,
        provider: i.provider,
      });
      return row!;
    });
  }

  /** A call to this number that is asked for or under way, placed in the last two hours. */
  async outboundInProgress(phone: string, now = new Date()): Promise<boolean> {
    const [row] = await this.db
      .select({ id: voiceCalls.id })
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.direction, 'outbound'),
          inArray(voiceCalls.status, ['requested', 'active']),
          eq(voiceCalls.callerPhone, phone),
          gt(voiceCalls.startedAt, new Date(now.getTime() - 2 * 60 * 60_000)),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Takes a call that was asked for, just before it is dialled. Only one taker gets it: a
   * job that runs twice, or again after a failure, can never ring the customer twice.
   */
  async claimForPlacing(id: string): Promise<CallRow | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ status: 'active', startedAt: new Date() })
        .where(and(eq(voiceCalls.id, id), eq(voiceCalls.status, 'requested')))
        .returning();
      if (row) await this.changed(tx, SYSTEM_CTX, 'voice.call_updated', row, { placed: true });
      return row ?? null;
    });
  }

  /**
   * The provider's ids for a call it took: how its reports find this record. Bookkeeping,
   * so not audited. False when another record already holds the call's id.
   */
  async placedAs(
    id: string,
    ids: { providerCallId: string | null; attemptId: string | null },
  ): Promise<boolean> {
    if (ids.providerCallId && (await this.byProvider(ids.providerCallId))) return false;
    await this.db
      .update(voiceCalls)
      .set({ providerCallId: ids.providerCallId, providerAttemptId: ids.attemptId })
      .where(eq(voiceCalls.id, id));
    return true;
  }

  async byAttempt(attemptId: string): Promise<CallRow | null> {
    const [row] = await this.db
      .select()
      .from(voiceCalls)
      .where(eq(voiceCalls.providerAttemptId, attemptId));
    return row ?? null;
  }

  /**
   * Gives a call we placed the provider's own id for it, once that is known. False when
   * another record already holds the id. Bookkeeping, so not audited.
   */
  async linkProviderCall(id: string, providerCallId: string): Promise<boolean> {
    if (await this.byProvider(providerCallId)) return false;
    const rows = await this.db
      .update(voiceCalls)
      .set({ providerCallId })
      .where(and(eq(voiceCalls.id, id), isNull(voiceCalls.providerCallId)))
      .returning({ id: voiceCalls.id })
      .catch(() => []);
    return rows.length > 0;
  }

  /**
   * A tool request on a call we placed, before the provider told us the call's id: the
   * call under way to this number takes the id. Null when the id is already known or no
   * such call is under way.
   */
  async adoptOutbound(
    provider: PhoneProviderId,
    phone: string,
    providerCallId: string,
  ): Promise<CallRow | null> {
    if (await this.byProvider(providerCallId)) return null;
    const [waiting] = await this.db
      .select({ id: voiceCalls.id })
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.direction, 'outbound'),
          eq(voiceCalls.status, 'active'),
          eq(voiceCalls.provider, provider),
          eq(voiceCalls.callerPhone, phone),
          isNull(voiceCalls.providerCallId),
          // Only a call placed moments ago: later, the same person ringing in is another call.
          gt(voiceCalls.startedAt, new Date(Date.now() - ADOPT_MINUTES * 60_000)),
        ),
      )
      .orderBy(desc(voiceCalls.startedAt))
      .limit(1);
    if (!waiting || !(await this.linkProviderCall(waiting.id, providerCallId))) return null;
    return this.get(waiting.id);
  }

  /**
   * A call we placed is over without a transcript to write: nobody answered, the line was
   * busy, it failed, or another record carries it. False when it was already over.
   */
  async endOutbound(id: string, outcome: PhoneCallOutcome): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ status: 'ended', endedAt: new Date(), outcome, endedReason: 'provider_ended' })
        .where(and(eq(voiceCalls.id, id), inArray(voiceCalls.status, ['requested', 'active'])))
        .returning();
      if (!row) return false;
      await this.changed(tx, SYSTEM_CTX, 'voice.call_ended', row, { outcome });
      return true;
    });
  }

  /**
   * Calls we placed that nobody reported on: asked for more than ten minutes ago and never
   * dialled, dialled a quarter of an hour ago with no word from the provider, or still open
   * after a day whatever the provider said.
   */
  async staleOutbound(now = new Date()): Promise<CallRow[]> {
    const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
    return this.db
      .select()
      .from(voiceCalls)
      .where(
        and(
          eq(voiceCalls.direction, 'outbound'),
          or(
            and(eq(voiceCalls.status, 'requested'), lt(voiceCalls.startedAt, before(10))),
            and(
              eq(voiceCalls.status, 'active'),
              isNull(voiceCalls.providerCallId),
              lt(voiceCalls.startedAt, before(15)),
            ),
            and(eq(voiceCalls.status, 'active'), lt(voiceCalls.startedAt, before(24 * 60))),
          ),
        ),
      )
      .limit(100);
  }

  /**
   * Calls left "active" by a server that stopped without ending them. Phone
   * calls are not ours to end: they live at Sarvam and are closed by their own job.
   */
  async closeAbandoned(): Promise<number> {
    const rows = await this.db
      .select({ id: voiceCalls.id, startedAt: voiceCalls.startedAt })
      .from(voiceCalls)
      .where(and(eq(voiceCalls.status, 'active'), eq(voiceCalls.transport, 'browser')));
    for (const row of rows) {
      await this.finish(row.id, {
        reason: 'server_shutdown',
        seconds: Math.round((Date.now() - row.startedAt.getTime()) / 1000),
        language: null,
        answeredBy: null,
        recording: null,
      });
    }
    return rows.length;
  }

  async get(id: string): Promise<CallRow> {
    const [row] = await this.db.select().from(voiceCalls).where(eq(voiceCalls.id, id));
    if (!row) throw new NotFoundException('Call not found');
    return row;
  }

  /** A ticket's calls, newest first. `live` supplies the state of calls in progress here. */
  async forTicket(
    ticketId: string,
    live: (callId: string) => VoiceState | null,
  ): Promise<VoiceCallView[]> {
    const rows = await this.db
      .select({ call: voiceCalls, agentName: users.name })
      .from(voiceCalls)
      .leftJoin(users, eq(users.id, voiceCalls.agentUserId))
      .where(eq(voiceCalls.ticketId, ticketId))
      .orderBy(desc(voiceCalls.startedAt));
    return rows.map(({ call, agentName }) => ({
      id: call.id,
      ticketId: call.ticketId,
      conversationId: call.conversationId,
      status: call.status as VoiceCallView['status'],
      transport: call.transport as VoiceCallView['transport'],
      provider: call.provider as VoiceCallView['provider'],
      direction: call.direction as VoiceCallView['direction'],
      purpose: call.purpose as VoiceCallView['purpose'],
      outcome: call.outcome as VoiceCallView['outcome'],
      requestedBy: call.requestedBy,
      state: call.status === 'active' ? live(call.id) : null,
      startedAt: call.startedAt.toISOString(),
      endedAt: call.endedAt?.toISOString() ?? null,
      durationSeconds: call.durationSeconds,
      language: call.language,
      endedReason: call.endedReason as VoiceEndReason | null,
      answeredBy: call.answeredBy as VoiceCallView['answeredBy'],
      agent: call.agentUserId ? { id: call.agentUserId, name: agentName ?? 'Former user' } : null,
      recording:
        call.recordingKey && call.endedAt
          ? {
              bytes: call.recordingBytes ?? 0,
              expiresAt: new Date(
                call.endedAt.getTime() + VOICE_RECORDING_DAYS * DAY_MS,
              ).toISOString(),
            }
          : null,
    }));
  }

  /** The recording, for playback. Listening is audited. */
  async recording(
    ctx: RequestCtx,
    id: string,
  ): Promise<{ stream: Readable; bytes: number; type: CallRecording['type'] }> {
    const call = await this.get(id);
    if (!call.recordingKey) throw new NotFoundException('This call has no recording');
    const stream = await this.storage.get(call.recordingKey);
    await this.db.transaction((tx) =>
      this.changed(
        tx,
        ctx,
        'voice.call_updated',
        call,
        { recordingPlayed: true },
        'voice.recording_played',
      ),
    );
    return {
      stream,
      bytes: call.recordingBytes ?? 0,
      type: call.recordingKey.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
    };
  }

  /** Deletes recordings older than the retention period; the transcripts stay. */
  async purgeRecordings(days = VOICE_RECORDING_DAYS, now = new Date()): Promise<number> {
    const due = await this.db
      .select()
      .from(voiceCalls)
      .where(
        and(
          isNotNull(voiceCalls.recordingKey),
          lt(voiceCalls.endedAt, new Date(now.getTime() - days * DAY_MS)),
        ),
      )
      .limit(500);
    let purged = 0;
    for (const call of due) {
      try {
        await this.storage.delete(call.recordingKey!);
      } catch (err) {
        this.logger.warn(`recording ${call.recordingKey} not deleted: ${(err as Error).message}`);
        continue;
      }
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(voiceCalls)
          .set({ recordingKey: null, recordingDeletedAt: now })
          .where(eq(voiceCalls.id, call.id))
          .returning();
        await this.changed(
          tx,
          SYSTEM_CTX,
          'voice.call_updated',
          row!,
          { recordingDeleted: true, afterDays: days },
          'voice.recording_deleted',
        );
      });
      purged++;
    }
    return purged;
  }

  private async changed(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    ctx: RequestCtx,
    type: 'voice.call_requested' | 'voice.call_started' | 'voice.call_updated' | 'voice.call_ended',
    call: CallRow,
    data: Record<string, unknown>,
    action: string = type,
  ) {
    const payload = { callId: call.id, ticketId: call.ticketId, ...data };
    await this.audit.record(tx, ctx, {
      action,
      targetType: call.ticketId ? 'ticket' : 'voice_call',
      targetId: call.ticketId ?? call.id,
      data: payload,
    });
    await this.outbox.publish(tx, ctx, {
      type,
      aggregateType: 'voice_call',
      aggregateId: call.id,
      payload,
    });
  }
}
