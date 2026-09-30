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
  'team.created',
  'category.created',
  'workflow.status_upserted',
  'workflow.status_deactivated',
  'workflow.transitions_replaced',
  /** A secret was created, rotated or deleted. The payload names the key, never the value. */
  'settings.secret_changed',
  /** Non-secret settings changed, such as a channel's host or an AI option. */
  'settings.updated',
  /** LLM providers, models or roles changed. */
  'llm.config_changed',
  /** A KB document was created or its content, visibility or status changed; indexing follows. */
  'kb.document_changed',
  'kb.document_deleted',
  /** Indexing finished (or failed). */
  'kb.document_indexed',
  /** Re-embed everything, e.g. after the embedding model changed. */
  'kb.reindex_requested',
  /** An AI turn finished (sent, drafted, handed over or failed). */
  'ai.turn_completed',
  /** The AI handed the conversation to humans. */
  'ai.handover',
  /** The classifier set category, priority, language, intent and sentiment. */
  'ticket.classified',
  /** An AI reply was stored as a draft for a human to approve. */
  'message.drafted',
  /** A draft was approved (and queued for delivery) or discarded. */
  'message.draft_reviewed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type AggregateType =
  | 'ticket'
  | 'customer'
  | 'user'
  | 'conversation'
  | 'team'
  | 'category'
  | 'workflow'
  | 'settings'
  | 'llm'
  | 'kb';

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
