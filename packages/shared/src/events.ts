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
  /** An MCP server was added, changed, synced or removed, or a tool's settings changed. */
  'tool.config_changed',
  /** A company-system tool ran (or was refused); the payload has status, never secrets. */
  'tool.called',
  /** A transactional tool call waits for a supervisor. */
  'approval.requested',
  /** A supervisor approved or rejected it; approved calls run next, then the AI follows up. */
  'approval.decided',
  /** Nobody decided in time. */
  'approval.expired',
  /** A person or the AI asked for a person; the context pack and routing follow. */
  'handover.requested',
  /** The context pack for a handover is written. */
  'handover.context_ready',
  /** Routing picked a team and possibly an agent. */
  'ticket.routed',
  /** A ticket's SLA timers started, paused, resumed or were met. */
  'sla.updated',
  /** 80% of an SLA target is used up. */
  'sla.at_risk',
  'sla.breached',
  /** Routing rules, skills or SLA settings changed. */
  'routing.config_changed',
  'sla.config_changed',
  /** An agent went online, away or offline, or changed capacity. */
  'presence.changed',
  'notification.created',
  /** A team lead escalated a ticket. */
  'ticket.escalated',
  /** A voice call started, changed hands or ended; the payload has the ticket once there is one. */
  'voice.call_started',
  'voice.call_updated',
  'voice.call_ended',
  /** A reply that was spoken on a call: stored as sent, never queued for delivery. */
  'message.spoken',
  /** An admin granted a role a permission, or took it back. */
  'role.permissions_changed',
  /** WhatsApp templates were synced from Meta, or Meta changed a template's status. */
  'whatsapp.templates_changed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

export type AggregateType =
  | 'ticket'
  | 'customer'
  | 'user'
  | 'role'
  | 'voice_call'
  | 'conversation'
  | 'team'
  | 'category'
  | 'workflow'
  | 'settings'
  | 'llm'
  | 'kb'
  | 'tool'
  | 'approval'
  | 'routing'
  | 'sla'
  | 'user_presence'
  | 'notification';

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
