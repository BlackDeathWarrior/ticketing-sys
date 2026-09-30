import { createDb } from '@tms/db';
import { DOMAIN_EVENTS_QUEUE, type DomainEvent, WORKER_HEARTBEAT_KEY } from '@tms/shared';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { loadEnv } from './env';
import { relayOutboxBatch } from './outbox-relay';

const HEARTBEAT_MS = 10_000;

async function main() {
  const env = loadEnv();
  const log = pino({
    name: 'worker',
    level: env.LOG_LEVEL,
    transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
  });

  const { db, close: closeDb } = createDb(env.DATABASE_URL, { max: 5 });
  // BullMQ needs maxRetriesPerRequest: null on the connections it blocks on.
  const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const redis = new Redis(env.REDIS_URL);
  const eventsQueue = new Queue(DOMAIN_EVENTS_QUEUE, { connection });

  // Placeholder consumer. Notifications, SLA, reporting and the AI agent
  // subscribe to domain events here in later phases.
  const eventsWorker = new Worker<DomainEvent>(
    DOMAIN_EVENTS_QUEUE,
    async (job) => {
      log.debug({ type: job.data.type, aggregateId: job.data.aggregateId }, 'domain event');
    },
    { connection, concurrency: 10 },
  );
  eventsWorker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err }, 'event handler failed'),
  );

  let stopping = false;

  const relayLoop = async () => {
    while (!stopping) {
      try {
        const n = await relayOutboxBatch(db, eventsQueue, env.OUTBOX_BATCH_SIZE);
        if (n > 0) log.debug({ n }, 'relayed outbox events');
        // A full batch means there is likely more waiting: go again at once.
        if (n < env.OUTBOX_BATCH_SIZE) await sleep(env.OUTBOX_POLL_MS);
      } catch (err) {
        log.error({ err }, 'outbox relay failed');
        await sleep(env.OUTBOX_POLL_MS * 4);
      }
    }
  };

  const beat = () =>
    redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 120).catch(() => undefined);
  await beat();
  const heartbeat = setInterval(beat, HEARTBEAT_MS);
  const relay = relayLoop();
  log.info('worker started');

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    clearInterval(heartbeat);
    await relay;
    await eventsWorker.close();
    await eventsQueue.close();
    await Promise.allSettled([connection.quit(), redis.quit(), closeDb()]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
