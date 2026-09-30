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
