import { type Database, outboxEvents } from '@tms/db';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';

type OutboxRow = typeof outboxEvents.$inferSelect;

export function toDomainEvent(row: OutboxRow): DomainEvent {
  return {
    id: row.eventId,
    type: row.type as DomainEventType,
    aggregateType: row.aggregateType as DomainEvent['aggregateType'],
    aggregateId: row.aggregateId,
    occurredAt: row.createdAt.toISOString(),
    actor: { type: row.actorType as DomainEvent['actor']['type'], id: row.actorId },
    payload: row.payload,
  };
}

/**
 * Moves one batch of unpublished outbox rows onto the queue.
 *
 * Rows are locked with SKIP LOCKED so several workers can relay in parallel.
 * The job id is the event id, so if the DB update fails after the enqueue the
 * retry is de-duplicated by BullMQ and consumers see the event once.
 *
 * Returns the number of events published.
 */
export async function relayOutboxBatch(db: Database, queue: Queue, limit: number): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(sql`${outboxEvents.publishedAt} IS NULL`)
      .orderBy(outboxEvents.id)
      .limit(limit)
      .for('update', { skipLocked: true });

    let published = 0;
    for (const row of rows) {
      try {
        const event = toDomainEvent(row);
        await queue.add(event.type, event, {
          jobId: event.id,
          removeOnComplete: { count: 10_000 },
          removeOnFail: { count: 10_000 },
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
        });
        await tx
          .update(outboxEvents)
          .set({ publishedAt: new Date(), attempts: row.attempts + 1 })
          .where(eq(outboxEvents.id, row.id));
        published++;
      } catch (err) {
        await tx
          .update(outboxEvents)
          .set({
            attempts: row.attempts + 1,
            lastError: err instanceof Error ? err.message : String(err),
          })
          .where(eq(outboxEvents.id, row.id));
        // Keep order per batch: stop at the first failure and retry next tick.
        break;
      }
    }
    return published;
  });
}
