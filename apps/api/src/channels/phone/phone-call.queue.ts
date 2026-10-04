import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { PhoneProviderId } from '@tms/shared';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { currentTrace, SpanKind, withSpan } from '../../telemetry/tracing';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { PhoneCallCloser, type PhoneCallHint } from './phone-call-closer.service';
import { PhoneOutboundService } from './phone-outbound.service';

export const PHONE_CALL_QUEUE = 'phone-calls';
/** Sarvam needs a moment after a call before its transcript can be fetched. */
const ATTEMPTS = 8;
/** A call no hook told us about may be nobody's call at all: asked about a few times only. */
const ATTEMPTS_UNKNOWN = 4;
const BACKOFF_MS = 15_000;
/** Dialled once: a second try could ring a customer whose first call did go through. */
const PLACE_ATTEMPTS = 1;
const SWEEP_MS = 5 * 60_000;
/**
 * A call with no "ended" trigger is closed this long after it began: longer than a call
 * lasts, so a call still in progress is not closed under the caller. After a day it is
 * given up on.
 */
const STALE_MINUTES = 60;
const GIVE_UP_MINUTES = 24 * 60;

type CloseJob =
  | {
      kind: 'close';
      /** Whose call it is. A job queued before there were two providers has none: Sarvam's. */
      provider?: PhoneProviderId;
      interactionId: string;
      hint: PhoneCallHint;
      trace?: string | null;
      /** The ticket is written; this run only fetches a recording that was not ready. */
      recording?: boolean;
    }
  | { kind: 'place'; callId: string; trace?: string | null }
  | { kind: 'sweep' };

/** Sarvam's recording can take minutes: asked for at 1, 2, 4, 8 and 16 minutes, then left. */
const RECORDING_FOLLOW_UPS = 5;
const RECORDING_FOLLOW_UP_MS = 60_000;

const closeOptions = (provider: PhoneProviderId, interactionId: string, known = true) => ({
  // One waiting job per call: a trigger that arrives twice is closed once. Sarvam's ids keep
  // the form they had before there was a second provider.
  jobId: `phone-${provider === 'sarvam' ? '' : `${provider}-`}${interactionId.replace(/[^\w-]/g, '_')}`,
  attempts: known ? ATTEMPTS : ATTEMPTS_UNKNOWN,
  backoff: { type: 'exponential' as const, delay: BACKOFF_MS },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 1_000 },
});

async function addClose(
  queue: Queue<CloseJob>,
  provider: PhoneProviderId,
  interactionId: string,
  hint: PhoneCallHint,
  known: boolean,
): Promise<void> {
  const options = closeOptions(provider, interactionId, known);
  // A finished job keeps its id for a while, and an id that exists is not added again: clear
  // it, or this call could not be tried again. A failed one is retried after a fix or a late
  // trigger; a completed one is asked once more for a recording that was not ready.
  const earlier = await queue.getJob(options.jobId);
  if (earlier && ((await earlier.isFailed()) || (await earlier.isCompleted()))) {
    await earlier.remove();
  }
  await queue.add(
    'close',
    { kind: 'close', provider, interactionId, hint, trace: currentTrace() },
    options,
  );
}

/** API side: the "ended" route answers the provider at once and leaves the ticket to the worker. */
@Injectable()
export class PhoneCallQueue implements BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue<CloseJob>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** `known`: a token-protected hook already told us about this call. */
  async add(
    provider: PhoneProviderId,
    interactionId: string,
    hint: PhoneCallHint,
    known: boolean,
  ): Promise<void> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue ??= new Queue<CloseJob>(PHONE_CALL_QUEUE, { connection: this.connection });
    await addClose(this.queue, provider, interactionId, hint, known);
  }

  /** A call the desk asked for: the worker hands it to the provider. */
  async place(callId: string): Promise<void> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue ??= new Queue<CloseJob>(PHONE_CALL_QUEUE, { connection: this.connection });
    await this.queue.add(
      'place',
      { kind: 'place', callId, trace: currentTrace() },
      {
        jobId: `place-${callId}`,
        attempts: PLACE_ATTEMPTS,
        backoff: { type: 'exponential', delay: BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: { age: 7 * 86_400, count: 1_000 },
      },
    );
  }

  async beforeApplicationShutdown() {
    await this.queue?.close();
    await this.connection?.quit().catch(() => undefined);
  }
}

/**
 * Worker side (ADR 0039): writes each finished call onto its ticket, one at a
 * time. A sweep every five minutes closes calls whose trigger never came.
 */
@Injectable()
export class PhoneCallWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(PhoneCallWorker.name);
  private readonly connection: Redis;
  private readonly queue: Queue<CloseJob>;
  private worker?: Worker<CloseJob>;

  constructor(
    @Inject(ENV) env: Env,
    private readonly closer: PhoneCallCloser,
    private readonly calls: VoiceCallsService,
    private readonly outbound: PhoneOutboundService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<CloseJob>(PHONE_CALL_QUEUE, { connection: this.connection });
  }

  async onApplicationBootstrap() {
    this.worker = new Worker<CloseJob>(PHONE_CALL_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: 1,
    });
    this.worker.on('failed', (job, err) => {
      // A recording that never came is not an error: recording may be off at Sarvam.
      if (job?.data.kind === 'close' && job.data.recording) return;
      if (job?.data.kind === 'place') {
        // Every try was refused: the call is on record as failed, with the provider's reason.
        if (job.attemptsMade >= (job.opts.attempts ?? PLACE_ATTEMPTS)) {
          void this.outbound
            .failed(job.data.callId, err.message)
            .catch((e: Error) => this.logger.warn(`call ${job.id}: ${e.message}`));
        }
        return;
      }
      if (job && job.attemptsMade >= (job.opts.attempts ?? ATTEMPTS)) {
        this.logger.error(`phone call ${job.id} was not written to a ticket: ${err.message}`);
      }
    });
    await this.queue.upsertJobScheduler(
      'phone-calls-sweep',
      { every: SWEEP_MS },
      { name: 'sweep', data: { kind: 'sweep' }, opts: { removeOnComplete: 20, removeOnFail: 50 } },
    );
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  private async process(job: Job<CloseJob>) {
    const d = job.data;
    if (d.kind === 'sweep') {
      for (const call of await this.calls.stalePhoneCalls(STALE_MINUTES, GIVE_UP_MINUTES)) {
        if (!call.providerCallId) continue;
        await addClose(
          this.queue,
          (call.provider as PhoneProviderId | null) ?? 'sarvam',
          call.providerCallId,
          { phone: null, seconds: null },
          true,
        );
      }
      for (const call of await this.calls.staleOutbound()) {
        await this.outbound.failed(call.id, 'The provider never reported on this call.');
      }
      return;
    }
    if (d.kind === 'place') {
      return withSpan('phone call place', { parent: d.trace, kind: SpanKind.CONSUMER }, () =>
        this.outbound.place(d.callId),
      );
    }
    return withSpan('phone call close', { parent: d.trace, kind: SpanKind.CONSUMER }, async () => {
      // The first try waits for the recording; after that the ticket is written without it.
      const provider = d.provider ?? 'sarvam';
      const outcome = await this.closer.close(provider, d.interactionId, d.hint, {
        waitForRecording: job.attemptsMade === 0 && !d.recording,
        recordingFollowUp: !!d.recording,
      });
      this.logger.debug(`phone call ${job.id}: ${outcome}`);
      if (outcome !== 'closed') return;
      const call = await this.calls.byProvider(d.interactionId);
      if (!call?.ticketId || call.recordingKey) return;
      // Written without its recording: ask the provider again later, a few times.
      await this.queue.add(
        'close',
        { ...d, recording: true },
        {
          jobId: `${closeOptions(provider, d.interactionId).jobId}-recording`,
          delay: RECORDING_FOLLOW_UP_MS,
          attempts: RECORDING_FOLLOW_UPS,
          backoff: { type: 'exponential', delay: RECORDING_FOLLOW_UP_MS },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });
  }
}
