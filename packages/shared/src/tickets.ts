import { z } from 'zod';

export const CHANNELS = ['email', 'whatsapp', 'webchat', 'voice', 'agent'] as const;
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
  ['resolved', 'closed'],
];

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

const tag = z.string().trim().min(1).max(50);

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
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTicketsQuery = z.infer<typeof listTicketsQuerySchema>;
