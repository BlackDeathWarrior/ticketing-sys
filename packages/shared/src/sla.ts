import { z } from 'zod';
import { prioritySchema } from './tickets';

/**
 * SLA (ADR 0014). A policy gives a first-response and a resolution target in
 * business minutes. Timers run in the policy's business hours, pause while
 * the ticket waits on the customer, and are "at risk" at 80% of the target.
 */
export const SLA_KINDS = ['first_response', 'resolution'] as const;
export type SlaKind = (typeof SLA_KINDS)[number];

export const SLA_TIMER_STATES = ['running', 'paused', 'met', 'breached'] as const;
export type SlaTimerState = (typeof SLA_TIMER_STATES)[number];

/** The ticket-level summary shown in the queue: the most urgent running timer. */
export const SLA_STATES = ['ok', 'at_risk', 'breached', 'paused', 'met'] as const;
export type SlaState = (typeof SLA_STATES)[number];

export const SLA_AT_RISK_SHARE = 0.8;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');

export const businessHoursSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z
    .string()
    .min(1)
    .max(60)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone'),
  /** Open windows per weekday (0 = Sunday). Empty means always open. */
  schedule: z
    .array(z.object({ day: z.number().int().min(0).max(6), start: time, end: time }))
    .max(21)
    .refine((w) => w.every((x) => x.start < x.end), 'Each window must end after it starts'),
  holidays: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        name: z.string().trim().min(1).max(80),
      }),
    )
    .max(100)
    .default([]),
});
export type BusinessHoursInput = z.input<typeof businessHoursSchema>;
export type BusinessHours = z.output<typeof businessHoursSchema>;

export const slaPolicySchema = z.object({
  name: z.string().trim().min(2).max(80),
  /** Applies to this priority only; null = any. */
  priority: prioritySchema.nullable().default(null),
  /** Applies to this customer type only (e.g. vip); null = any. */
  customerType: z.string().trim().max(40).nullable().default(null),
  firstResponseMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30),
  resolutionMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 90),
  businessHoursId: z.string().uuid().nullable().default(null),
  enabled: z.boolean().default(true),
});
export type SlaPolicyInput = z.input<typeof slaPolicySchema>;

export interface BusinessHoursView extends BusinessHours {
  id: string;
}

export interface SlaPolicyView {
  id: string;
  name: string;
  priority: string | null;
  customerType: string | null;
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: { id: string; name: string; timezone: string } | null;
  enabled: boolean;
}

export interface SlaTimerView {
  kind: SlaKind;
  state: SlaTimerState;
  targetMinutes: number;
  dueAt: string | null;
  atRisk: boolean;
  startedAt: string;
  metAt: string | null;
  breachedAt: string | null;
}

export interface TicketSlaView {
  policy: { id: string; name: string } | null;
  state: SlaState | null;
  dueAt: string | null;
  timers: SlaTimerView[];
}

/** Picks the most specific enabled policy: priority and customer type, then either, then neither. */
export function pickPolicy<
  P extends { priority: string | null; customerType: string | null; enabled: boolean },
>(policies: P[], ticket: { priority: string; customerType: string | null }): P | null {
  const fits = policies.filter(
    (p) =>
      p.enabled &&
      (!p.priority || p.priority === ticket.priority) &&
      (!p.customerType || p.customerType === ticket.customerType),
  );
  const score = (p: P) => (p.priority ? 2 : 0) + (p.customerType ? 1 : 0);
  return fits.sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Minutes until due (negative when overdue), for the queue's countdown. */
export const minutesUntil = (dueAt: string | Date | null, now = new Date()) =>
  dueAt === null ? null : Math.round((new Date(dueAt).getTime() - now.getTime()) / 60_000);
