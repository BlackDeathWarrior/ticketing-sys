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
  /** `externalId` is your own id for the person, when the customer is known by one. */
  customer: { name: string; email: string | null; externalId: string | null };
  handling: string;
  /** The assistant is writing an answer it will send by itself: show a typing indicator. */
  replying: boolean;
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

/** The person a phone number belongs to. Only your own id is required. */
export interface PhoneCustomer {
  /** Your own id for the person: the same id your other calls use. */
  externalId: string;
  email?: string;
  name?: string;
  /** How the person chose to be addressed; the support AI then uses it with their name. */
  title?: 'Mr.' | 'Ms.' | 'Mrs.' | 'Mx.' | 'Dr.';
}

export interface StartPhoneVerification {
  customer: PhoneCustomer;
  /** The full international number; spaces, dashes and a leading + are ignored. */
  phone: string;
}

export interface CheckPhoneVerification extends StartPhoneVerification {
  /** The 6 digits the customer received on WhatsApp. */
  code: string;
}

/** `sentVia`: `template` whenever an approved authentication template exists, `text` only when none does and the number wrote in the last 24 hours. */
export interface PhoneVerificationStarted {
  expiresAt: string;
  sentVia: 'template' | 'text';
}

/** `phone` is the number as TMS keeps it: digits only, country code included. */
export interface PhoneVerificationChecked {
  verified: true;
  phone: string;
}

export interface CustomerNotice {
  /** Your own id for the person; only a customer you have named before can be reached. */
  customer: { externalId: string };
  /** Your sentence for them, sent as it is. Up to 600 characters. */
  text: string;
  /** What it is about, in a few words, for the desk's record. */
  about?: string;
}

/** `sent: false` is an answer, not an error: `reason` says why nothing went out. */
export interface CustomerNoticeResult {
  sent: boolean;
  via: 'whatsapp' | null;
  reason?: string;
}

/** Why a check was refused (`body.reason` of a 400 `TmsApiError`). */
export type PhoneCodeFailure = 'wrong-code' | 'expired' | 'too-many-attempts' | 'no-code';

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
