import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { type Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { SYSTEM_CTX } from '../common/request-context';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import type { DomainEventHandler } from '../worker/domain-events';
import { KbIndexerService } from './kb-indexer.service';
import { KbService } from './kb.service';

export const KB_INGEST_QUEUE = 'kb-ingest';
const ATTEMPTS = 3;

interface IngestJob {
  documentId: string;
  /** null: re-index whatever the current version is. */
  version: number | null;
}

/**
 * Indexing runs on its own queue, so slow files and embedding calls don't
 * hold up delivery or realtime events, and concurrency stays bounded
 * (KB_INGEST_CONCURRENCY). Jobs are de-duplicated per document version.
 */
@Injectable()
export class KbIngestWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(KbIngestWorker.name);
  private readonly connection: Redis;
  readonly queue: Queue<IngestJob>;
  private worker?: Worker<IngestJob>;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly indexer: KbIndexerService,
  ) {
    this.connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.queue = new Queue<IngestJob>(KB_INGEST_QUEUE, { connection: this.connection });
  }

  onApplicationBootstrap() {
    this.worker = new Worker<IngestJob>(KB_INGEST_QUEUE, (job) => this.process(job), {
      connection: this.connection.duplicate(),
      concurrency: this.env.KB_INGEST_CONCURRENCY,
    });
    this.worker.on('failed', (job, err) => {
      if (!job) return;
      this.logger.warn(
        `indexing ${job.data.documentId} failed (attempt ${job.attemptsMade}/${ATTEMPTS}): ${err.message}`,
      );
      if (job.attemptsMade >= ATTEMPTS)
        void this.indexer.markFailed(job.data.documentId, err.message);
    });
  }

  async beforeApplicationShutdown() {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }

  async enqueue(documentId: string, version: number | null, dedupeKey: string) {
    await this.queue.add(
      'index',
      { documentId, version },
      {
        jobId: `${documentId}--${dedupeKey}`, // BullMQ ids may not contain ":"
        attempts: ATTEMPTS,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    );
  }

  private process(job: Job<IngestJob>) {
    return this.indexer.index(job.data.documentId, job.data.version);
  }
}

/** Turns KB events (and an embedding-model change) into indexing jobs. */
@Injectable()
export class KbIngestHandler implements DomainEventHandler {
  readonly name = 'kb-ingest';

  constructor(
    private readonly ingest: KbIngestWorker,
    private readonly kb: KbService,
  ) {}

  handles(type: DomainEventType): boolean {
    return (
      type === 'kb.document_changed' ||
      type === 'kb.reindex_requested' ||
      type === 'llm.config_changed'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as {
      documentId?: string | null;
      version?: number;
      action?: string;
      targetType?: string;
    };
    if (event.type === 'kb.document_changed' && p.documentId) {
      await this.ingest.enqueue(p.documentId, p.version ?? null, `v${p.version}`);
      return;
    }
    if (event.type === 'kb.reindex_requested') {
      const docs = p.documentId ? [{ id: p.documentId }] : await this.kb.allIds();
      for (const d of docs) await this.ingest.enqueue(d.id, null, `reindex-${event.id}`);
      return;
    }
    // A different embedding model means different vectors: re-embed everything.
    if (
      event.type === 'llm.config_changed' &&
      p.targetType === 'llm_role' &&
      event.aggregateId === 'embedding'
    ) {
      await this.kb.requestReindex(SYSTEM_CTX);
    }
  }
}
