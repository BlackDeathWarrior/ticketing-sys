import type { Channel, Priority, StatusCategory } from './tickets';

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
