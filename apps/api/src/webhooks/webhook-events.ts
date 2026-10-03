import type { DomainEvent, DomainEventType, WebhookEvent } from '@tms/shared';

/**
 * What a delivery is about: ids the body is built from when it is sent, and
 * status keys. Never customer text (it is stored in the delivery log).
 */
export interface WebhookRefs {
  ticketId?: string;
  messageId?: string;
  incidentId?: string;
  approvalId?: string;
  /** The integration an incident belongs to. */
  integrationId?: string;
  from?: string;
  to?: string;
  /** Names of the ticket fields that changed. */
  changed?: string[];
  decision?: string;
}

export interface MappedEvent {
  type: WebhookEvent;
  refs: WebhookRefs;
}

const TICKET_EVENTS: Partial<Record<DomainEventType, WebhookEvent>> = {
  'ticket.created': 'ticket.created',
  'ticket.updated': 'ticket.updated',
  'ticket.status_changed': 'ticket.status_changed',
  'ticket.assigned': 'ticket.assigned',
  'csat.submitted': 'csat.submitted',
};

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/**
 * The public webhook event for a domain event, or null when integrations are
 * not told about it. Drafts, internal notes, AI runs and settings changes
 * never leave: only what a customer or the integration itself could see.
 */
export function toWebhookEvent(event: DomainEvent): MappedEvent | null {
  const p = event.payload;
  const ticketEvent = TICKET_EVENTS[event.type];
  if (ticketEvent) {
    const refs: WebhookRefs = { ticketId: event.aggregateId };
    if (event.type === 'ticket.status_changed') {
      refs.from = str(p.from);
      refs.to = str(p.to);
    }
    if (event.type === 'ticket.updated' && p.changes && typeof p.changes === 'object') {
      refs.changed = Object.keys(p.changes as object);
    }
    return { type: ticketEvent, refs };
  }

  switch (event.type) {
    // A customer's message, or a reply queued for them. A draft is `message.drafted`: never sent.
    case 'message.received':
    case 'message.outbound': {
      // A reply sent again as text (ConversationsService.requeueWithoutCards) is not a new message.
      if (p.requeued === true) return null;
      const messageId = str(p.messageId);
      return messageId
        ? { type: 'message.created', refs: { ticketId: event.aggregateId, messageId } }
        : null;
    }
    case 'incident.opened':
    case 'incident.updated':
    case 'incident.resolved':
      return {
        type: event.type,
        refs: {
          incidentId: event.aggregateId,
          integrationId: str(p.integrationId),
          ticketId: str(p.ticketId),
        },
      };
    case 'approval.requested':
    case 'approval.decided':
      return {
        type: event.type,
        refs: {
          approvalId: event.aggregateId,
          ticketId: str(p.ticketId),
          decision: str(p.decision),
        },
      };
    default:
      return null;
  }
}

/** Domain events that may become a delivery, for `handles()`. */
export function isWebhookSource(type: DomainEventType): boolean {
  return (
    type in TICKET_EVENTS ||
    type === 'message.received' ||
    type === 'message.outbound' ||
    type.startsWith('incident.') ||
    type === 'approval.requested' ||
    type === 'approval.decided'
  );
}
