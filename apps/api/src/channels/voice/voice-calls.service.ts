import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, users, voiceCalls } from '@tms/db';
import {
  type PhoneProviderId,
  VOICE_RECORDING_DAYS,
  type VoiceCallView,
  type VoiceEndReason,
  type VoiceState,
} from '@tms/shared';
import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { StorageService } from '../../storage/storage.service';

export type CallRow = typeof voiceCalls.$inferSelect;
const DAY_MS = 86_400_000;

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
      recording: Buffer | null;
    },
  ): Promise<void> {
    const recordingKey = result.recording ? await this.store(id, result.recording) : null;
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
          recordingKey,
          recordingBytes: recordingKey ? result.recording!.length : null,
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

  /** Puts a call's WAV in object storage. Null when storage is off or the upload failed. */
  private async store(id: string, wav: Buffer): Promise<string | null> {
    if (!this.storage.enabled) return null;
    const now = new Date();
    const key = `recordings/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.wav`;
    try {
      await this.storage.put(key, wav, 'audio/wav');
      return key;
    } catch (err) {
      this.logger.error(`recording of call ${id} was not stored: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * A recording that arrived after the call was closed (a phone call's audio
   * is fetched from Sarvam and may be ready later than its transcript). Only
   * for a call that has none and whose recording was not already deleted.
   */
  async attachRecording(id: string, wav: Buffer): Promise<boolean> {
    const call = await this.get(id);
    if (call.status !== 'ended' || call.recordingKey || call.recordingDeletedAt) return false;
    const recordingKey = await this.store(id, wav);
    if (!recordingKey) return false;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(voiceCalls)
        .set({ recordingKey, recordingBytes: wav.length })
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
      status: call.status as 'active' | 'ended',
      transport: call.transport as VoiceCallView['transport'],
      provider: call.provider as VoiceCallView['provider'],
      direction: call.direction as VoiceCallView['direction'],
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
  async recording(ctx: RequestCtx, id: string): Promise<{ stream: Readable; bytes: number }> {
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
    return { stream, bytes: call.recordingBytes ?? 0 };
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
    type: 'voice.call_started' | 'voice.call_updated' | 'voice.call_ended',
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
