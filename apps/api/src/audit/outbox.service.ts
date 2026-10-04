import { Injectable } from '@nestjs/common';
import { type DbOrTx, outboxEvents } from '@tms/db';
import { and, isNotNull, lt } from 'drizzle-orm';
import type { AggregateType, DomainEventType } from '@tms/shared';
import type { RequestCtx } from '../common/request-context';
import { currentTrace } from '../telemetry/tracing';

export interface OutboxEntry {
  type: DomainEventType;
  aggregateType: AggregateType;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * Writes domain events to the transactional outbox. The worker relays them to
 * BullMQ, so an event is published if and only if its transaction commits.
 */
@Injectable()
export class OutboxService {
  async publish(tx: DbOrTx, ctx: RequestCtx, entry: OutboxEntry): Promise<void> {
    await tx.insert(outboxEvents).values({
      type: entry.type,
      aggregateType: entry.aggregateType,
      aggregateId: entry.aggregateId,
      payload: entry.payload,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id ?? null,
      traceContext: currentTrace(),
    });
  }

  /** Deletes events that were delivered before `before`. Undelivered ones always stay. */
  async purgePublished(db: DbOrTx, before: Date): Promise<number> {
    const rows = await db
      .delete(outboxEvents)
      .where(and(isNotNull(outboxEvents.publishedAt), lt(outboxEvents.publishedAt, before)))
      .returning({ id: outboxEvents.id });
    return rows.length;
  }
}
