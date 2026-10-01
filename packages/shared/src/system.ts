import { z } from 'zod';

/**
 * Housekeeping an admin can see and steer (ADR 0021): how long operational
 * data is kept, and background jobs that failed for good.
 */

export const RETENTION_KEY = 'retention';

const days = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

export const retentionSchema = z.object({
  /** The log of model calls behind usage and cost figures. */
  llmCallsDays: days(7, 3650, 90),
  /** Agents' notifications, read or not. */
  notificationsDays: days(7, 3650, 90),
  /** Delivered internal events (the outbox). Undelivered ones are never deleted. */
  eventsDays: days(1, 365, 30),
  /** Used and expired portal sign-in links. */
  signInLinksDays: days(1, 90, 7),
  /** The log of webhook deliveries to integrations. */
  webhookDeliveriesDays: days(1, 365, 30),
});
export type Retention = z.output<typeof retentionSchema>;
export const DEFAULT_RETENTION: Retention = retentionSchema.parse({});

/** What one retention run deleted. */
export interface RetentionCounts {
  llmCalls: number;
  notifications: number;
  events: number;
  signInLinks: number;
  recordings: number;
  webhookDeliveries: number;
}

export interface RetentionView {
  settings: Retention;
  /** Fixed, because the call page promises it to callers. */
  recordingsDays: number;
  lastRun: { at: string; deleted: RetentionCounts } | null;
}

/** A background job that used up its retries. */
export interface FailedJobView {
  id: string;
  name: string;
  /** What it was about, without customer content: an event type and a record id. */
  about: string | null;
  reason: string;
  attempts: number;
  failedAt: string | null;
}

export interface QueueView {
  name: string;
  label: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  /** The most recent failures, newest first. */
  jobs: FailedJobView[];
}

/** Queues the worker runs, with names an admin recognises. */
export const QUEUE_LABELS: Record<string, string> = {
  'domain-events': 'Follow-up work after a change (delivery, notifications, routing, SLA)',
  'ai-turns': 'AI answers',
  'kb-ingest': 'Knowledge base indexing',
  'whatsapp-webhooks': 'WhatsApp messages from Meta',
  approvals: 'Approved actions',
  sla: 'SLA checks',
  'channel-health': 'Channel connection checks',
  'ai-auto-resolve': 'Resolving tickets the AI answered',
  retention: 'Deleting old operational data and call recordings',
  'webhook-deliveries': 'Webhooks to integrations',
};
