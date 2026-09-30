import { Injectable } from '@nestjs/common';
import { type DbOrTx, outboxEvents } from '@tms/db';
import type { AggregateType, DomainEventType } from '@tms/shared';
import type { RequestCtx } from '../common/request-context';

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
    });
  }
}
