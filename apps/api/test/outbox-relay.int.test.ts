import { createDb, type DbHandle, outboxEvents, runMigrations } from '@tms/db';
import { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { relayOutboxBatch } from '../src/worker/outbox-relay';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tms:tms@localhost:5432/tms_test';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
const QUEUE = `test-domain-events-${Date.now()}`;

let h: DbHandle;
let connection: Redis;
let queue: Queue;

beforeAll(async () => {
  // Idempotent: a no-op when the API suite has already migrated this database.
  await runMigrations(DB_URL);
  h = createDb(DB_URL, { max: 4 });
  connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE, { connection });
  // Earlier suites may have left unpublished rows; publish them to a throwaway queue.
  while ((await relayOutboxBatch(h.db, queue, 500)) > 0);
  await queue.obliterate({ force: true });
});

afterAll(async () => {
  await queue?.obliterate({ force: true });
  await queue?.close();
  await connection?.quit();
  await h?.close();
});

async function insertEvents(n: number) {
  const rows = await h.db
    .insert(outboxEvents)
    .values(
      Array.from({ length: n }, (_, i) => ({
        type: 'ticket.created',
        aggregateType: 'ticket',
        aggregateId: `agg-${i}`,
        payload: { i },
        actorType: 'system',
      })),
    )
    .returning();
  return rows;
}

describe('relayOutboxBatch', () => {
  it('publishes pending events in order and marks them published', async () => {
    const rows = await insertEvents(3);
    const n = await relayOutboxBatch(h.db, queue, 100);
    expect(n).toBe(3);

    const jobs = await queue.getJobs(['waiting']);
    const ours = jobs.filter((j) => rows.some((r) => r.eventId === j.id));
    expect(ours).toHaveLength(3);
    expect(ours[0]!.data).toMatchObject({ type: 'ticket.created', aggregateType: 'ticket' });

    const after = await h.db
      .select()
      .from(outboxEvents)
      .where(
        inArray(
          outboxEvents.id,
          rows.map((r) => r.id),
        ),
      );
    expect(after.every((r) => r.publishedAt !== null)).toBe(true);
  });

  it('does not publish twice', async () => {
    await insertEvents(1);
    expect(await relayOutboxBatch(h.db, queue, 100)).toBe(1);
    expect(await relayOutboxBatch(h.db, queue, 100)).toBe(0);
  });

  it('lets concurrent relays split the work without duplicates', async () => {
    const rows = await insertEvents(40);
    const [a, b] = await Promise.all([
      relayOutboxBatch(h.db, queue, 25),
      relayOutboxBatch(h.db, queue, 25),
    ]);
    const rest = await relayOutboxBatch(h.db, queue, 100);
    expect(a + b + rest).toBe(40);
    const ids = new Set(rows.map((r) => r.eventId));
    const jobs = (await queue.getJobs(['waiting'])).filter((j) => ids.has(j.id!));
    expect(jobs).toHaveLength(40);
  });

  it('records the error and keeps the row pending when the queue is unavailable', async () => {
    const [row] = await insertEvents(1);
    const broken = { add: async () => Promise.reject(new Error('redis down')) } as unknown as Queue;
    expect(await relayOutboxBatch(h.db, broken, 10)).toBe(0);
    const [after] = await h.db.select().from(outboxEvents).where(eq(outboxEvents.id, row!.id));
    expect(after!.publishedAt).toBeNull();
    expect(after!.lastError).toBe('redis down');
    expect(after!.attempts).toBe(1);
    // Recovers on the next tick.
    expect(await relayOutboxBatch(h.db, queue, 10)).toBe(1);
  });
});
