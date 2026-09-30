/**
 * Domain events written to the outbox in the same transaction as the change
 * that caused them, then relayed by the worker to the `domain-events` queue.
 * Consumers (notifications, reporting, SLA, AI) subscribe to these types.
 */
export const DOMAIN_EVENT_TYPES = [
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.assigned',
  'ticket.note_added',
  'customer.created',
  'customer.updated',
  'customer.identity_added',
  'customer.merged',
  'user.created',
  'user.updated',
  'conversation.created',
  'conversation.controller_changed',
  'message.received',
  'message.outbound',
  'message.delivery_updated',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type AggregateType = 'ticket' | 'customer' | 'user' | 'conversation';

export interface DomainEvent<P = Record<string, unknown>> {
  id: string;
  type: DomainEventType;
  aggregateType: AggregateType;
  aggregateId: string;
  occurredAt: string;
  actor: Actor;
  payload: P;
}

export type ActorType = 'user' | 'system' | 'ai' | 'customer';

export interface Actor {
  type: ActorType;
  id?: string | null;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

/** Redis key the worker refreshes; the API's readiness check reports its age. */
export const WORKER_HEARTBEAT_KEY = 'tms:worker:heartbeat';
