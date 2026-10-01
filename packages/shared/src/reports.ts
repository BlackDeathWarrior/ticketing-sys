import { z } from 'zod';
import { type Channel, channelSchema, type Priority, type StatusCategory } from './tickets';

/** One day of ticket flow; `date` is YYYY-MM-DD in UTC. */
export interface DailyVolume {
  date: string;
  created: number;
  resolved: number;
}

export interface ActivityEvent {
  id: number;
  occurredAt: string;
  action: string;
  actor: { type: string; id: string | null; name: string | null };
  ticket: { id: string; reference: string; subject: string } | null;
  data: Record<string, unknown>;
}

/** `GET /reports/overview`: the dashboard's aggregate view of the queue. */
export interface OverviewReport {
  generatedAt: string;
  /** Tickets whose status is in the open or pending category. */
  open: number;
  unassigned: number;
  resolvedToday: number;
  resolvedLast7Days: number;
  /** Median minutes from creation to resolution for tickets resolved in the last 7 days. */
  medianResolutionMinutes: number | null;
  /** Median minutes to the first agent reply for tickets created in the last 7 days. */
  medianFirstResponseMinutes: number | null;
  byStatus: Array<{ status: string; name: string; category: StatusCategory; count: number }>;
  /** Open tickets only. */
  byChannel: Array<{ channel: Channel; count: number }>;
  /** Open tickets only. */
  byPriority: Array<{ priority: Priority; count: number }>;
  /** Oldest first, `days` entries ending today. */
  volume: DailyVolume[];
  /** Open tickets per assignee, busiest first. */
  byAssignee: Array<{ id: string; name: string; open: number }>;
  activity: ActivityEvent[];
}

export const OVERVIEW_VOLUME_DAYS = 14;

/** Median of a list of numbers, or null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The last `days` UTC dates ending with `today`, oldest first, as YYYY-MM-DD. */
export function lastDays(today: Date, days: number): string[] {
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: days }, (_, i) =>
    new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

// ---- Performance report: the AI and the team, side by side (ADR 0019) ----

/**
 * Who handled a ticket:
 * - `ai`: the AI is (or was, when it was resolved) the one answering;
 * - `ai_then_human`: the AI worked on it, and a person has it now;
 * - `human`: the AI never took a turn on it.
 */
export const HANDLED_BY = ['ai', 'ai_then_human', 'human'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];

export const HANDLED_BY_LABELS: Record<HandledBy, string> = {
  ai: 'AI',
  ai_then_human: 'AI, then a person',
  human: 'A person',
};

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-01')
  // Date.parse would quietly turn 30 February into 2 March.
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, 'Not a real date');

/** A period (UTC days, both ends included) and the tickets to look at. */
export const reportQuerySchema = z
  .object({
    /** Used when `from` is not given: this many days, ending today. */
    days: z.coerce.number().int().min(1).max(366).default(30),
    from: day.optional(),
    to: day.optional(),
    channel: channelSchema.optional(),
    teamId: z.string().uuid().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The first day must not be after the last day',
    path: ['from'],
  });
export type ReportQuery = z.output<typeof reportQuerySchema>;

export const ticketReportQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(366).default(30),
    from: day.optional(),
    to: day.optional(),
    channel: channelSchema.optional(),
    teamId: z.string().uuid().optional(),
    handledBy: z.enum(HANDLED_BY).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The first day must not be after the last day',
    path: ['from'],
  });
export type TicketReportQuery = z.output<typeof ticketReportQuerySchema>;

/** The first and last day of a report, from a query. Dates are YYYY-MM-DD in UTC. */
export function reportPeriod(
  q: { days: number; from?: string; to?: string },
  now = new Date(),
): { from: string; to: string } {
  const to = q.to ?? now.toISOString().slice(0, 10);
  if (q.from) return { from: q.from, to: q.from > to ? q.from : to };
  const end = Date.parse(`${to}T00:00:00Z`);
  return { from: new Date(end - (q.days - 1) * 86_400_000).toISOString().slice(0, 10), to };
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** `part / whole` as a number from 0 to 1, or null when there is nothing to divide. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export interface AiHuman<T> {
  ai: T;
  human: T;
}

export interface CsatSummary {
  responses: number;
  /** Mean rating, 1 to 5. */
  average: number | null;
  /** Share of ratings that are 4 or 5. */
  satisfied: number | null;
}

export interface SlaCount {
  met: number;
  breached: number;
  /** met / (met + breached). */
  compliance: number | null;
}

export interface PerformanceReport {
  generatedAt: string;
  from: string;
  to: string;
  filters: { channel: Channel | null; teamId: string | null };
  /** Tickets created in the period. */
  created: number;
  /** Tickets resolved in the period, by who handled them. */
  resolved: { total: number } & Record<HandledBy, number>;
  /** Share of resolved tickets the AI resolved without a person. */
  aiResolutionRate: number | null;
  /** Tickets created in the period that the AI took at least one turn on. */
  aiWorked: {
    total: number;
    /** Resolved without ever going to a person. */
    deflected: number;
    /** Went to a person (handed over, or taken over). */
    toPerson: number;
    /** Still with the AI and open. */
    open: number;
    deflectionRate: number | null;
    handoverRate: number | null;
  };
  /** Minutes from creation to the first reply, by who wrote that reply. */
  medianFirstResponseMinutes: AiHuman<number | null>;
  /**
   * Minutes from creation to the last reply before the ticket was resolved
   * (to the resolution itself when nobody replied). Waiting for the customer
   * to confirm doesn't count. `human` includes "AI, then a person".
   */
  medianResolutionMinutes: AiHuman<number | null>;
  timeSaved: {
    /** Tickets the AI resolved alone, times `minutesPerTicket`. */
    minutes: number;
    /** The assumption behind the estimate (Settings → Customers). */
    minutesPerTicket: number;
  };
  sla: {
    firstResponse: AiHuman<SlaCount>;
    resolution: AiHuman<SlaCount>;
    /** Both targets together. */
    overall: AiHuman<SlaCount> & { all: SlaCount };
  };
  csat: AiHuman<CsatSummary> & {
    all: CsatSummary;
    /** Surveys sent or shown in the period. */
    asked: number;
  };
  cost: {
    totalUsd: number;
    calls: number;
    byProvider: Array<{ provider: string; usd: number; calls: number }>;
    /** Total cost divided by tickets the AI resolved alone. */
    perAiResolvedUsd: number | null;
  };
  /** One entry per day, oldest first. */
  daily: Array<{ date: string; created: number; resolvedAi: number; resolvedHuman: number }>;
  byChannel: Array<{
    channel: Channel;
    created: number;
    resolved: number;
    resolvedAi: number;
    csatAverage: number | null;
    csatResponses: number;
  }>;
}

export interface TicketReportRow {
  id: string;
  reference: string;
  subject: string;
  channel: Channel;
  status: string;
  priority: Priority;
  team: string | null;
  assignee: string | null;
  customer: string;
  handledBy: HandledBy;
  createdAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  firstResponseMinutes: number | null;
  resolutionMinutes: number | null;
  slaState: string | null;
  rating: number | null;
}

export interface TicketReport {
  from: string;
  to: string;
  total: number;
  items: TicketReportRow[];
}

/** Most rows one CSV export holds. */
export const REPORT_EXPORT_MAX_ROWS = 10_000;

export const TICKET_REPORT_COLUMNS: Array<{ key: keyof TicketReportRow; label: string }> = [
  { key: 'reference', label: 'Ticket' },
  { key: 'subject', label: 'Subject' },
  { key: 'channel', label: 'Channel' },
  { key: 'status', label: 'Status' },
  { key: 'priority', label: 'Priority' },
  { key: 'team', label: 'Team' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'customer', label: 'Customer' },
  { key: 'handledBy', label: 'Handled by' },
  { key: 'createdAt', label: 'Created' },
  { key: 'firstResponseAt', label: 'First response' },
  { key: 'resolvedAt', label: 'Resolved' },
  { key: 'firstResponseMinutes', label: 'First response (minutes)' },
  { key: 'resolutionMinutes', label: 'Resolution (minutes)' },
  { key: 'slaState', label: 'SLA' },
  { key: 'rating', label: 'Rating' },
];

/**
 * One CSV cell. Quotes when needed, and defuses values a spreadsheet would
 * run as a formula (a customer can put anything in a subject).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function ticketReportCsv(rows: TicketReportRow[]): string {
  const lines = [TICKET_REPORT_COLUMNS.map((c) => csvCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(
      TICKET_REPORT_COLUMNS.map((c) =>
        csvCell(c.key === 'handledBy' ? HANDLED_BY_LABELS[row.handledBy] : row[c.key]),
      ).join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
