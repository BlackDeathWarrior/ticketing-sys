/**
 * What the TMS integration API takes and returns. These mirror the contracts
 * in @tms/shared (a test keeps the two in step); they are repeated here so
 * the SDK has no runtime dependencies.
 */

export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export type TicketState = 'open' | 'pending' | 'resolved' | 'closed';

export interface Customer {
  /** Your own id for the person: the same id always finds the same customer. */
  externalId?: string;
  email?: string;
  name?: string;
}

export interface CreateTicket {
  /** Give at least `externalId` or `email`. */
  customer: Customer;
  subject: string;
  body: string;
  /** A top-level category by name, as set up in Settings → Tickets. */
  category?: string;
  priority?: Priority;
  tags?: string[];
  /** Your id for what the ticket is about: an order, a listing, a job. */
  externalRef?: string;
  /** Context for agents and the AI: a small JSON object (at most 8 KB). */
  metadata?: Record<string, unknown>;
  /** `off`: people only; the AI does not answer this ticket. */
  ai?: 'default' | 'off';
}

export interface Ticket {
  reference: string;
  subject: string;
  status: { key: string; name: string; state: TicketState };
  priority: Priority;
  category: string | null;
  tags: string[];
  externalRef: string | null;
  metadata: Record<string, unknown>;
  customer: { name: string; email: string | null };
  handling: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

/** A message the customer wrote or was sent. Drafts and internal notes never appear. */
export interface Message {
  id: string;
  from: 'customer' | 'assistant' | 'support' | 'system';
  name: string | null;
  body: string;
  createdAt: string;
}

export interface TicketList {
  items: Ticket[];
  total: number;
}

export interface Rating {
  rating: number;
  comment: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export type Severity = 'info' | 'warning' | 'error' | 'critical';

export interface ReportEvent {
  /** What makes two reports the same problem, e.g. `scraper.source_failed:myntra`. */
  fingerprint: string;
  /** One line saying what is wrong; the ticket's subject. */
  title: string;
  severity?: Severity;
  /** The part of your app that reported it. */
  source?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface Incident {
  id: string;
  fingerprint: string;
  status: 'open' | 'resolved';
  severity: Severity;
  title: string;
  source: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  ticket: string | null;
}

export interface EventResult {
  action: 'opened' | 'updated' | 'resolved' | 'ignored';
  incident: Incident | null;
}

export interface Identity {
  integration: { slug: string; name: string };
  key: { name: string; prefix: string; scopes: string[]; rateLimitPerMinute: number };
}

export type WebhookEventType =
  | 'ticket.created'
  | 'ticket.updated'
  | 'ticket.status_changed'
  | 'ticket.assigned'
  | 'message.created'
  | 'incident.opened'
  | 'incident.updated'
  | 'incident.resolved'
  | 'approval.requested'
  | 'approval.decided'
  | 'csat.submitted'
  | 'ping';

/** The JSON body of every webhook. `id` equals the `X-TMS-Delivery` header. */
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  integration: string;
  data: T;
}
