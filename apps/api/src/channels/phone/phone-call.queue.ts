import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { currentTrace, SpanKind, withSpan } from '../../telemetry/tracing';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { PhoneCallCloser, type PhoneCallHint } from './phone-call-closer.service';

export const PHONE_CALL_QUEUE = 'phone-calls';
/** Sarvam needs a moment after a call before its transcript can be fetched. */
const ATTEMPTS = 8;
/** A call no hook told us about may be nobody's call at all: asked about a few times only. */
const ATTEMPTS_UNKNOWN = 4;
const BACKOFF_MS = 15_000;
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
      interactionId: string;
      hint: PhoneCallHint;
      trace?: string | null;
      /** The ticket is written; this run only fetches a recording that was not ready. */
      recording?: boolean;
    }
  | { kind: 'sweep' };

/** Sarvam's recording can take minutes: asked for at 1, 2, 4, 8 and 16 minutes, then left. */
const RECORDING_FOLLOW_UPS = 5;
const RECORDING_FOLLOW_UP_MS = 60_000;

const closeOptions = (interactionId: string, known = true) => ({
  // One waiting job per call: a trigger that arrives twice is closed once.
  jobId: `phone-${interactionId.replace(/[^\w-]/g, '_')}`,
  attempts: known ? ATTEMPTS : ATTEMPTS_UNKNOWN,
  backoff: { type: 'exponential' as const, delay: BACKOFF_MS },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 1_000 },
});

async function addClose(
  queue: Queue<CloseJob>,
  interactionId: string,
  hint: PhoneCallHint,
  known: boolean,
): Promise<void> {
  const options = closeOptions(interactionId, known);
  // A finished job keeps its id for a while, and an id that exists is not added again: clear
  // it, or this call could not be tried again. A failed one is retried after a fix or a late
  // trigger; a completed one is asked once more for a recording that was not ready.
  const earlier = await queue.getJob(options.jobId);
  if (earlier && ((await earlier.isFailed()) || (await earlier.isCompleted()))) {
    await earlier.remove();
  }
  await queue.add('close', { kind: 'close', interactionId, hint, trace: currentTrace() }, options);
}

/** API side: the "ended" route answers Sarvam at once and leaves the ticket to the worker. */
@Injectable()
export class PhoneCallQueue implements BeforeApplicationShutdown {
  private connection?: Redis;
  private queue?: Queue<CloseJob>;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** `known`: a token-protected hook already told us about this call. */
  async add(interactionId: string, hint: PhoneCallHint, known: boolean): Promise<void> {
    this.connection ??= new Redis(this.env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue ??= new Queue<CloseJob>(PHONE_CALL_QUEUE, { connection: this.connection });
    await addClose(this.queue, interactionId, hint, known);
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
        await addClose(this.queue, call.providerCallId, { phone: null, seconds: null }, true);
      }
      return;
    }
    return withSpan('phone call close', { parent: d.trace, kind: SpanKind.CONSUMER }, async () => {
      // The first try waits for the recording; after that the ticket is written without it.
      const outcome = await this.closer.close(d.interactionId, d.hint, {
        waitForRecording: job.attemptsMade === 0 && !d.recording,
        recordingFollowUp: !!d.recording,
      });
      this.logger.debug(`phone call ${job.id}: ${outcome}`);
      if (outcome !== 'closed') return;
      const call = await this.calls.byProvider(d.interactionId);
      if (!call?.ticketId || call.recordingKey) return;
      // Written without its recording: ask Sarvam again later, a few times.
      await this.queue.add(
        'close',
        { ...d, recording: true },
        {
          jobId: `${closeOptions(d.interactionId).jobId}-recording`,
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
