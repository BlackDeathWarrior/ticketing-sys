import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, users, voiceCalls } from '@tms/db';
import {
  VOICE_RECORDING_DAYS,
  type VoiceCallView,
  type VoiceEndReason,
  type VoiceState,
} from '@tms/shared';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { StorageService } from '../../storage/storage.service';

type CallRow = typeof voiceCalls.$inferSelect;
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
    let recordingKey: string | null = null;
    if (result.recording && this.storage.enabled) {
      const now = new Date();
      recordingKey = `recordings/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.wav`;
      try {
        await this.storage.put(recordingKey, result.recording, 'audio/wav');
      } catch (err) {
        this.logger.error(`recording of call ${id} was not stored: ${(err as Error).message}`);
        recordingKey = null;
      }
    }
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

  /** Calls left "active" by a server that stopped without ending them. */
  async closeAbandoned(): Promise<number> {
    const rows = await this.db
      .select({ id: voiceCalls.id, startedAt: voiceCalls.startedAt })
      .from(voiceCalls)
      .where(eq(voiceCalls.status, 'active'));
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
