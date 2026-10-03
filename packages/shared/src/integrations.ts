import { z } from 'zod';
import { customerTitleSchema, normalizeIdentity } from './customers';
import type { Permission } from './permissions';
import {
  externalRefSchema,
  type Priority,
  prioritySchema,
  STATUS_CATEGORIES,
  type StatusCategory,
  ticketMetadataSchema,
  ticketTagSchema,
} from './tickets';

/**
 * Integrations (ADR 0022): an outside app that connects to TMS. Its API keys,
 * and later its webhooks and chat settings, belong to the integration.
 */

/** What a key may be allowed to do. Each one is a permission, checked like a staff permission. */
export const API_KEY_SCOPES = [
  'integration:ticket',
  'integration:event',
  'integration:customer',
  'kb:read',
] as const satisfies readonly Permission[];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'integration:ticket': 'Create and read its own tickets and messages',
  'integration:event': 'Report incidents and recoveries',
  'integration:customer': "Prove a customer's phone number",
  'kb:read': 'Search the knowledge base',
};

/** The secret an integration's site signs chat identity tokens with (ADR 0026). */
export const chatIdentitySecretKey = (slug: string) => `integration.${slug}.chat_identity`;

/** Where the chat widget is served from, for the snippet shown in Settings. */
export interface WidgetHost {
  origin: string;
}

/** The answer to generating a chat identity secret: the only time it is returned. */
export interface ChatIdentitySecret {
  secret: string;
}

/** Every key starts with this, so a leaked one is easy to recognise. */
export const API_KEY_PREFIX = 'tms_sk_';

export const DEFAULT_KEY_RATE_LIMIT = 120;

export const integrationSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Lowercase letters, digits and dashes, starting with a letter');

export const createIntegrationSchema = z.object({
  /** Names the integration in keys, secrets and the widget; it cannot change later. */
  slug: integrationSlugSchema,
  name: z.string().trim().min(2).max(80),
});
export type CreateIntegrationInput = z.output<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    /** Off: every key of the integration is refused. */
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateIntegrationInput = z.output<typeof updateIntegrationSchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, 'Choose at least one scope')
    .transform((s) => [...new Set(s)]),
  /** Requests per minute across the whole key. */
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(DEFAULT_KEY_RATE_LIMIT),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type CreateApiKeyInput = z.output<typeof createApiKeySchema>;

export interface IntegrationView {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  /** Keys that still work. */
  activeKeys: number;
  /** Last four characters of the secret its site signs chat identities with, when one is set. */
  chatIdentityLast4: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export interface ApiKeyView {
  id: string;
  integrationId: string;
  name: string;
  /** The start of the key, enough to tell two keys apart. Never the whole key. */
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  status: ApiKeyStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Accurate to about a minute. */
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

/** The answer to creating a key: the only time the key itself is returned. */
export interface CreatedApiKey extends ApiKeyView {
  key: string;
}

/** What `GET /integration` tells a key about itself. */
export interface IntegrationIdentity {
  integration: { slug: string; name: string };
  key: { name: string; prefix: string; scopes: ApiKeyScope[]; rateLimitPerMinute: number };
}

// ---- The integration API: tickets (ADR 0023) ----

/** Who the ticket is for, as the integration knows them. At least one of the two ids. */
export const integrationCustomerSchema = z
  .object({
    /** The app's own id for the person: the same id always finds the same customer. */
    externalId: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().email().max(320).optional(),
    name: z.string().trim().min(1).max(200).optional(),
  })
  .refine((c) => !!c.externalId || !!c.email, {
    message: 'Give the customer an externalId or an email',
  });
export type IntegrationCustomerInput = z.output<typeof integrationCustomerSchema>;

export const createIntegrationTicketSchema = z.object({
  customer: integrationCustomerSchema,
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20_000),
  /** A top-level category by name, as set up in Settings → Tickets. */
  category: z.string().trim().min(1).max(100).optional(),
  priority: prioritySchema.default('normal'),
  tags: z.array(ticketTagSchema).max(20).default([]),
  externalRef: externalRefSchema.optional(),
  metadata: ticketMetadataSchema.default({}),
  /** `off`: people only; the AI does not answer this ticket. */
  ai: z.enum(['default', 'off']).default('default'),
});
export type CreateIntegrationTicketInput = z.output<typeof createIntegrationTicketSchema>;

export const integrationMessageSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
});
export type IntegrationMessageInput = z.output<typeof integrationMessageSchema>;

/** Sent as the `Idempotency-Key` header: a retry with the same key creates nothing new. */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{8,200}$/, 'Use 8 to 200 printable characters without spaces');

export const listIntegrationTicketsQuerySchema = z.object({
  externalRef: externalRefSchema.optional(),
  /** Your own id for a person (`customer.externalId`): only the tickets of that person. */
  customer: z.string().trim().min(1).max(200).optional(),
  /** Where the ticket is in its life, whatever the workflow's statuses are called. */
  state: z.enum(STATUS_CATEGORIES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListIntegrationTicketsQuery = z.output<typeof listIntegrationTicketsQuerySchema>;

export const integrationMessagesQuerySchema = z.object({
  /** Only messages created after this moment: pass the last `createdAt` you have seen. */
  after: z.string().datetime().optional(),
});

export interface IntegrationTicketView {
  /** How the ticket is addressed in this API and shown to people, e.g. `TMS-1042`. */
  reference: string;
  subject: string;
  status: { key: string; name: string; state: StatusCategory };
  priority: Priority;
  category: string | null;
  tags: string[];
  externalRef: string | null;
  metadata: Record<string, unknown>;
  /**
   * `externalId` is your own id for the person, when the ticket's customer is
   * known by one (a ticket you raised with it, or a chat with a signed identity).
   */
  customer: { name: string; email: string | null; externalId: string | null };
  /** Whether a person, the AI or nobody yet is answering. */
  handling: string;
  /**
   * The assistant is writing an answer that it will send by itself: the
   * customer wrote last and the AI answers this channel without review. Show a
   * typing indicator while it is true; it turns false when the answer (or a
   * message saying a person will reply) arrives.
   */
  replying: boolean;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

/** A message the customer wrote or was sent. Drafts and internal notes never appear. */
export interface IntegrationMessageView {
  id: string;
  from: 'customer' | 'assistant' | 'support' | 'system';
  /** First name of the agent who wrote it, when a person did. */
  name: string | null;
  body: string;
  createdAt: string;
}

export interface IntegrationTicketList {
  items: IntegrationTicketView[];
  total: number;
}

/**
 * The `external_id` identity of an integration's customer. Namespaced by the
 * integration, so two apps that both have a user "42" get two customers.
 */
export const integrationExternalId = (slug: string, externalId: string) => `${slug}:${externalId}`;

// ---- The integration API: incidents (ADR 0024) ----

/**
 * How bad a problem the app reports is. It sets the ticket's priority:
 * critical → urgent, error → high, warning → normal, info → low.
 */
export const INCIDENT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const INCIDENT_PRIORITY: Record<IncidentSeverity, Priority> = {
  critical: 'urgent',
  error: 'high',
  warning: 'normal',
  info: 'low',
};

/** `metadata.kind` of a ticket that tracks an incident. Such tickets are not classified by the AI. */
export const INCIDENT_TICKET_KIND = 'incident';
export const INCIDENT_TAG = 'incident';

/** Occurrence counts at which a repeat is noted on the ticket. */
export const INCIDENT_NOTE_AT = [2, 10, 100, 1000] as const;

export const reportEventSchema = z
  .object({
    /**
     * What makes two reports "the same problem", chosen by the app, e.g.
     * `scraper.source_failed:myntra`. Reports with one fingerprint share one ticket.
     */
    fingerprint: z
      .string()
      .trim()
      .regex(/^[\x21-\x7e]{1,200}$/, 'Use 1 to 200 printable characters without spaces'),
    /** `firing`: it is happening. `resolved`: it has recovered. */
    status: z.enum(['firing', 'resolved']).default('firing'),
    /** One line saying what is wrong; the ticket's subject. Needed when firing. */
    title: z.string().trim().min(1).max(300).optional(),
    severity: incidentSeveritySchema.default('error'),
    /** The part of the app that reported it, e.g. `scraper/myntra`. */
    source: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(5000).optional(),
    /** Extra facts for whoever picks it up; kept on the ticket's metadata. */
    details: ticketMetadataSchema.default({}),
  })
  .refine((e) => e.status === 'resolved' || !!e.title, {
    message: 'A firing event needs a title',
    path: ['title'],
  });
export type ReportEventInput = z.output<typeof reportEventSchema>;

export type IncidentStatus = 'open' | 'resolved';

export interface IncidentView {
  id: string;
  fingerprint: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  title: string;
  source: string | null;
  /** How many times it was reported while open. */
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  /** The ticket that tracks it. */
  ticket: string | null;
}

/**
 * What a report did. `opened`: a new incident and ticket (or a reopened
 * ticket). `updated`: counted on the open incident. `resolved`: the incident
 * is closed. `ignored`: a recovery for something that was not open.
 */
export type EventAction = 'opened' | 'updated' | 'resolved' | 'ignored';

export interface ReportEventResult {
  action: EventAction;
  incident: IncidentView | null;
}

export const listIncidentsQuerySchema = z.object({
  status: z.enum(['open', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ListIncidentsQuery = z.output<typeof listIncidentsQuerySchema>;

// ---- The integration API: proving a customer's phone number ----

/** How long a code works, and how many wrong tries it allows before it is spent. */
export const PHONE_CODE_TTL_MINUTES = 10;
export const PHONE_CODE_MAX_ATTEMPTS = 5;

/** Why a check failed. The app shows its own words for each. */
export const PHONE_CODE_FAILURES = [
  'wrong-code',
  'expired',
  'too-many-attempts',
  'no-code',
] as const;
export type PhoneCodeFailure = (typeof PHONE_CODE_FAILURES)[number];

/** The person the number belongs to, as the app knows them. Only the app's own id is required. */
const phoneCustomerSchema = z.object({
  externalId: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  /** How the person chose to be addressed; the AI then uses it with their name. */
  title: customerTitleSchema.optional(),
});

/** Digits only, country code included: "+91 98300-12345" and "919830012345" are the same number. */
const phoneNumberSchema = z
  .string()
  .transform((v) => normalizeIdentity('phone', v))
  .refine((v) => /^\d{8,15}$/.test(v), {
    message: 'Give the full international number, 8 to 15 digits',
  });

export const startPhoneVerificationSchema = z.object({
  customer: phoneCustomerSchema,
  phone: phoneNumberSchema,
});
export type StartPhoneVerificationInput = z.output<typeof startPhoneVerificationSchema>;

export const checkPhoneVerificationSchema = z.object({
  customer: phoneCustomerSchema,
  phone: phoneNumberSchema,
  code: z.string().regex(/^\d{6}$/, 'The code is 6 digits'),
});
export type CheckPhoneVerificationInput = z.output<typeof checkPhoneVerificationSchema>;

/** `sentVia`: `template` whenever an approved authentication template exists, `text` only when none does and the number wrote in the last 24 hours. */
export interface PhoneVerificationStarted {
  expiresAt: string;
  sentVia: 'template' | 'text';
}

export interface PhoneVerificationChecked {
  verified: true;
  phone: string;
}
