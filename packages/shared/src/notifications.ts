import { z } from 'zod';

/** In-app notifications for agents (ADR 0014); some are also emailed. */
export const NOTIFICATION_KINDS = [
  'ticket.assigned',
  'handover.requested',
  'sla.at_risk',
  'sla.breached',
  'approval.requested',
  'ticket.escalated',
  'llm.budget_warning',
  /** A channel that was working stopped working (to people who manage channels). */
  'channel.down',
  /** A customer rated a ticket 1 or 2 out of 5. */
  'csat.low',
  /** A webhook kept failing and was switched off (to people who manage integrations). */
  'webhook.disabled',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Kinds that are also sent by email (when the email channel is on). */
export const EMAILED_NOTIFICATIONS: NotificationKind[] = ['sla.breached', 'approval.requested'];

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  ticket: { id: string; reference: string } | null;
  readAt: string | null;
  createdAt: string;
}

export const listNotificationsQuerySchema = z.object({
  unread: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
