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
/** A call with no "ended" trigger is closed this long after it began. */
const STALE_MINUTES = 15;

type CloseJob =
  | { kind: 'close'; interactionId: string; hint: PhoneCallHint; trace?: string | null }
  | { kind: 'sweep' };

const closeOptions = (interactionId: string, known = true) => ({
  // One waiting job per call: a trigger that arrives twice is closed once.
  jobId: `phone-${interactionId.replace(/[^\w-]/g, '_')}`,
  attempts: known ? ATTEMPTS : ATTEMPTS_UNKNOWN,
  backoff: { type: 'exponential' as const, delay: BACKOFF_MS },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 86_400, count: 1_000 },
});

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
    await this.queue.add(
      'close',
      { kind: 'close', interactionId, hint, trace: currentTrace() },
      closeOptions(interactionId, known),
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
      for (const call of await this.calls.stalePhoneCalls(STALE_MINUTES)) {
        if (!call.providerCallId) continue;
        await this.queue.add(
          'close',
          {
            kind: 'close',
            interactionId: call.providerCallId,
            hint: { phone: null, seconds: null },
          },
          closeOptions(call.providerCallId),
        );
      }
      return;
    }
    return withSpan('phone call close', { parent: d.trace, kind: SpanKind.CONSUMER }, async () => {
      const outcome = await this.closer.close(d.interactionId, d.hint);
      this.logger.debug(`phone call ${job.id}: ${outcome}`);
    });
  }
}
