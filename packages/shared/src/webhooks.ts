import { z } from 'zod';

/**
 * Outbound webhooks (ADR 0025): TMS tells an integration's own server when
 * something happens, with a signed HTTP POST. The event names here are the
 * public contract; they are mapped from the internal domain events and stay
 * stable when those change.
 */
export const WEBHOOK_EVENTS = [
  'ticket.created',
  'ticket.updated',
  'ticket.status_changed',
  'ticket.assigned',
  'message.created',
  'incident.opened',
  'incident.updated',
  'incident.resolved',
  'approval.requested',
  'approval.decided',
  'csat.submitted',
] as const;
export const webhookEventSchema = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Sent by "Send a test" in Settings; never by itself. */
export const WEBHOOK_PING = 'ping';
export type WebhookEventType = WebhookEvent | typeof WEBHOOK_PING;

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  'ticket.created': 'A ticket was created',
  'ticket.updated': 'A ticket’s subject, priority, category or tags changed',
  'ticket.status_changed': 'A ticket changed status',
  'ticket.assigned': 'A ticket was assigned',
  'message.created': 'A message the customer can see was added',
  'incident.opened': 'An incident was opened',
  'incident.updated': 'An incident got worse or kept happening',
  'incident.resolved': 'An incident was resolved',
  'approval.requested': 'An action is waiting for a supervisor',
  'approval.decided': 'A supervisor approved or rejected an action',
  'csat.submitted': 'A customer rated a ticket',
};

/**
 * `own`: only what concerns the integration's own tickets and incidents.
 * `all`: every ticket in the workspace, whatever channel it came from.
 */
export const WEBHOOK_SCOPES = ['own', 'all'] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

export const WEBHOOK_SIGNATURE_HEADER = 'x-tms-signature';
export const WEBHOOK_EVENT_HEADER = 'x-tms-event';
export const WEBHOOK_DELIVERY_HEADER = 'x-tms-delivery';
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** How far a signature's timestamp may be from the receiver's clock, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** The secret that signs a subscription's deliveries, in the secret store. */
export const webhookSecretKey = (subscriptionId: string) =>
  `integration.wh-${subscriptionId}.secret`;

const url = z
  .string()
  .trim()
  .min(8)
  .max(500)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'Use an http or https address' });

const fields = {
  url,
  events: z
    .array(webhookEventSchema)
    .min(1, 'Choose at least one event')
    .transform((e) => [...new Set(e)]),
  scope: z.enum(WEBHOOK_SCOPES).default('own'),
  description: z.string().trim().max(200).default(''),
};

export const createWebhookSchema = z.object(fields);
export type CreateWebhookInput = z.output<typeof createWebhookSchema>;

export const updateWebhookSchema = z
  .object({
    url,
    events: fields.events,
    scope: z.enum(WEBHOOK_SCOPES),
    description: z.string().trim().max(200),
    /** Switching a subscription back on forgets its earlier failures. */
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateWebhookInput = z.output<typeof updateWebhookSchema>;

export interface WebhookView {
  id: string;
  integrationId: string;
  url: string;
  description: string;
  events: WebhookEvent[];
  scope: WebhookScope;
  isActive: boolean;
  /** Why TMS switched it off by itself, when it did. */
  disabledReason: string | null;
  /** Deliveries in a row that failed for good. */
  consecutiveFailures: number;
  secretLast4: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** The answer to creating a subscription or rotating its secret: the only time the secret is returned. */
export interface WebhookWithSecret extends WebhookView {
  secret: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed';

/** One delivery in the log. Identifiers and outcomes only: what was sent is never stored. */
export interface WebhookDeliveryView {
  id: string;
  eventType: WebhookEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  /** Set when this delivery repeats an earlier one on request. */
  redeliveryOf: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookTestResult {
  ok: boolean;
  httpStatus: number | null;
  durationMs: number;
  error: string | null;
}

/** The JSON body of every delivery. `id` equals the `X-TMS-Delivery` header. */
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  /** When the event happened, not when it was sent. */
  createdAt: string;
  /** The integration the subscription belongs to. */
  integration: string;
  data: T;
}

export const listDeliveriesQuerySchema = z.object({
  status: z.enum(['pending', 'delivered', 'failed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListDeliveriesQuery = z.output<typeof listDeliveriesQuerySchema>;
