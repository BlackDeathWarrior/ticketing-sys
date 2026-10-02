import { z } from 'zod';

/** `api`: tickets an integration creates through the API (ADR 0023). */
export const CHANNELS = [
  'email',
  'whatsapp',
  'webchat',
  'voice',
  'web_form',
  'agent',
  'api',
] as const;
export const channelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof channelSchema>;

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export const prioritySchema = z.enum(PRIORITIES);
export type Priority = z.infer<typeof prioritySchema>;

/** Where a status sits in the lifecycle; SLA and reporting key off this, not the status name. */
export const STATUS_CATEGORIES = ['open', 'pending', 'resolved', 'closed'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export interface StatusDefinition {
  key: string;
  name: string;
  category: StatusCategory;
  sortOrder: number;
  isInitial?: boolean;
}

/** Default workflow from the requirements brief (§7). Admins can change it at runtime. */
export const DEFAULT_STATUSES: StatusDefinition[] = [
  { key: 'new', name: 'New', category: 'open', sortOrder: 10, isInitial: true },
  { key: 'ai_handling', name: 'AI Handling', category: 'open', sortOrder: 20 },
  { key: 'human_assigned', name: 'Human Assigned', category: 'open', sortOrder: 30 },
  { key: 'in_progress', name: 'In Progress', category: 'open', sortOrder: 40 },
  { key: 'pending_customer', name: 'Pending Customer', category: 'pending', sortOrder: 50 },
  { key: 'resolved', name: 'Resolved', category: 'resolved', sortOrder: 60 },
  { key: 'closed', name: 'Closed', category: 'closed', sortOrder: 70 },
];

export const DEFAULT_TRANSITIONS: Array<[from: string, to: string]> = [
  ['new', 'ai_handling'],
  ['new', 'human_assigned'],
  ['new', 'in_progress'],
  ['new', 'resolved'],
  ['new', 'closed'],
  ['ai_handling', 'human_assigned'],
  ['ai_handling', 'pending_customer'],
  ['ai_handling', 'resolved'],
  ['human_assigned', 'in_progress'],
  ['human_assigned', 'ai_handling'],
  ['human_assigned', 'pending_customer'],
  ['human_assigned', 'resolved'],
  ['in_progress', 'human_assigned'],
  ['in_progress', 'pending_customer'],
  ['in_progress', 'resolved'],
  ['pending_customer', 'in_progress'],
  ['pending_customer', 'ai_handling'],
  ['pending_customer', 'resolved'],
  ['pending_customer', 'closed'],
  ['resolved', 'in_progress'],
  // A customer who writes again after the AI closed their request gets the AI again.
  ['resolved', 'ai_handling'],
  // The AI ends a conversation for misuse without calling it solved.
  ['ai_handling', 'closed'],
  ['resolved', 'closed'],
];

/**
 * Why the AI resolved a ticket by itself (`tickets.ai_closure`); null when a
 * person did, or it is not resolved.
 */
export const AI_CLOSURES = [
  'customer_confirmed',
  'no_reply',
  // Closed for conduct (ADR 0029): closed for good at once, and never asked for a rating.
  'jailbreak',
  'abuse',
  'spam',
  'off_topic',
] as const;
export type AiClosure = (typeof AI_CLOSURES)[number];

export const AI_CLOSURE_LABELS: Record<AiClosure, string> = {
  customer_confirmed: 'Closed by the AI: the customer needed nothing else',
  no_reply: 'Closed by the AI: no reply from the customer',
  jailbreak: 'Closed by the AI: an attempt to override its instructions',
  abuse: 'Closed by the AI: abusive language',
  spam: 'Closed by the AI: spam',
  off_topic: 'Closed by the AI: nothing to do with the company, after a warning',
};

/** The closures that are for conduct: the conversation was ended, not finished. */
export const CONDUCT_CLOSURES: AiClosure[] = ['jailbreak', 'abuse', 'spam', 'off_topic'];

/** Statuses that assignment moves a ticket out of, into `human_assigned`. */
export const UNASSIGNED_STATUSES = ['new', 'ai_handling'] as const;

export const TICKET_NUMBER_PREFIX = 'TMS-';

export function formatTicketNumber(n: number): string {
  return `${TICKET_NUMBER_PREFIX}${n}`;
}

export function parseTicketNumber(ref: string): number | null {
  const m = /^(?:TMS-)?(\d+)$/i.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

// ---- API contracts ----

export const ticketTagSchema = z.string().trim().min(1).max(50);
const tag = ticketTagSchema;

/** The other system's id for what the ticket is about (an order, a listing, a job). */
export const externalRefSchema = z.string().trim().min(1).max(200);

export const TICKET_METADATA_MAX_BYTES = 8192;
/** Context from the system that raised the ticket: a small JSON object, shown to agents. */
export const ticketMetadataSchema = z
  .record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= TICKET_METADATA_MAX_BYTES, {
    message: `Metadata must be at most ${TICKET_METADATA_MAX_BYTES} bytes of JSON`,
  });

export const createTicketSchema = z.object({
  customerId: z.string().uuid(),
  channel: channelSchema.default('agent'),
  subject: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  categoryId: z.string().uuid().optional(),
  subcategoryId: z.string().uuid().optional(),
  priority: prioritySchema.default('normal'),
  teamId: z.string().uuid().optional(),
  tags: z.array(tag).max(20).default([]),
  externalRef: externalRefSchema.optional(),
  metadata: ticketMetadataSchema.optional(),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(300),
    description: z.string().max(20_000).nullable(),
    categoryId: z.string().uuid().nullable(),
    subcategoryId: z.string().uuid().nullable(),
    priority: prioritySchema,
    resolution: z.string().max(20_000).nullable(),
    tags: z.array(tag).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const transitionTicketSchema = z.object({
  status: z.string().min(1),
  resolution: z.string().max(20_000).optional(),
});
export type TransitionTicketInput = z.infer<typeof transitionTicketSchema>;

export const assignTicketSchema = z
  .object({
    assigneeId: z.string().uuid().nullable().optional(),
    teamId: z.string().uuid().nullable().optional(),
  })
  .refine((v) => v.assigneeId !== undefined || v.teamId !== undefined, {
    message: 'Provide assigneeId and/or teamId',
  });
export type AssignTicketInput = z.infer<typeof assignTicketSchema>;

export const addNoteSchema = z.object({ body: z.string().trim().min(1).max(20_000) });

export const listTicketsQuerySchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  priority: prioritySchema.optional(),
  channel: channelSchema.optional(),
  assigneeId: z.union([z.string().uuid(), z.literal('me'), z.literal('none')]).optional(),
  teamId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  tag: z.string().optional(),
  q: z.string().trim().max(200).optional(),
  /** Who is answering: none | ai | human | handed_over (comma-separated for several). */
  handling: z.string().max(60).optional(),
  /** `at_risk` also includes breached tickets; `breached` only breached ones. */
  sla: z.enum(['at_risk', 'breached']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;
