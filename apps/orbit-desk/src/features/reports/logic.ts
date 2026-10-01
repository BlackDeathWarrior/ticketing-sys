import type { HandledBy, PerformanceReport } from '@tms/shared';
import { duration } from '../../lib/format';

export type RangePreset = '7' | '30' | '90' | 'custom';

export interface ReportFilters {
  range: RangePreset;
  from: string;
  to: string;
  channel: string;
  teamId: string;
}

export const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom dates' },
];

/** The query both report endpoints take, or null while custom dates are incomplete. */
export function reportParams(f: ReportFilters): Record<string, string | undefined> | null {
  const scope = { channel: f.channel || undefined, teamId: f.teamId || undefined };
  if (f.range !== 'custom') return { days: f.range, ...scope };
  if (!f.from || !f.to || f.from > f.to) return null;
  return { from: f.from, to: f.to, ...scope };
}

/** "42%"; an em dash when there was nothing to measure. */
export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

/** "12m", "3h 5m"; an em dash for no data. */
export function minutesText(value: number | null): string {
  if (value === null) return '—';
  return value < 1 ? 'under 1m' : duration(Math.round(value));
}

/** Time saved, in the unit a person would say it in. */
export function savedText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} h`;
}

export function ratingText(average: number | null): string {
  return average === null ? '—' : `${average.toFixed(1)} / 5`;
}

export function usd(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** "1 Oct – 30 Oct 2026". */
export function periodText(from: string, to: string): string {
  const fmt = (iso: string, year: boolean) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: year ? 'numeric' : undefined,
      timeZone: 'UTC',
    });
  return from === to
    ? fmt(to, true)
    : `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}

export interface Segment {
  key: HandledBy;
  label: string;
  count: number;
  /** Share of the whole, 0 to 1. */
  share: number;
}

/** Who resolved the period's tickets, as parts of one bar. Empty parts are left out. */
export function resolvedSegments(resolved: PerformanceReport['resolved']): Segment[] {
  const parts: Array<[HandledBy, string]> = [
    ['ai', 'The AI alone'],
    ['ai_then_human', 'The AI, then a person'],
    ['human', 'A person'],
  ];
  return parts
    .map(([key, label]) => ({
      key,
      label,
      count: resolved[key],
      share: resolved.total ? resolved[key] / resolved.total : 0,
    }))
    .filter((s) => s.count > 0);
}

export interface CompareRow {
  metric: string;
  ai: string;
  human: string;
  /** What the number counts, in a few words. */
  note: string;
}

/** The AI and people on the same measures; a table, because the reader compares exact values. */
export function compareRows(r: PerformanceReport): CompareRow[] {
  const sla = r.sla.overall;
  return [
    {
      metric: 'First reply',
      ai: minutesText(r.medianFirstResponseMinutes.ai),
      human: minutesText(r.medianFirstResponseMinutes.human),
      note: 'Median time to the first reply',
    },
    {
      metric: 'Time to final answer',
      ai: minutesText(r.medianResolutionMinutes.ai),
      human: minutesText(r.medianResolutionMinutes.human),
      note: 'Median, from opened to the last reply before it was solved',
    },
    {
      metric: 'SLA targets met',
      ai: slaText(sla.ai),
      human: slaText(sla.human),
      note: 'First-reply and resolution targets',
    },
    {
      metric: 'Customer rating',
      ai: ratingText(r.csat.ai.average),
      human: ratingText(r.csat.human.average),
      note: `${r.csat.ai.responses} and ${r.csat.human.responses} ratings`,
    },
    {
      metric: 'Happy customers',
      ai: percent(r.csat.ai.satisfied),
      human: percent(r.csat.human.satisfied),
      note: 'Rated 4 or 5 out of 5',
    },
  ];
}

function slaText(c: { met: number; breached: number; compliance: number | null }): string {
  return c.compliance === null
    ? '—'
    : `${percent(c.compliance)} (${c.met} of ${c.met + c.breached})`;
}

export interface Kpi {
  id: string;
  label: string;
  value: string;
  context: string;
}

export function reportKpis(r: PerformanceReport): Kpi[] {
  return [
    {
      id: 'ai-resolved',
      label: 'Resolved by the AI alone',
      value: percent(r.aiResolutionRate),
      context: `${r.resolved.ai} of ${r.resolved.total} resolved tickets`,
    },
    {
      id: 'handover',
      label: 'AI tickets passed to a person',
      value: percent(r.aiWorked.handoverRate),
      context: `${r.aiWorked.toPerson} of ${r.aiWorked.total} tickets the AI worked on`,
    },
    {
      id: 'time-saved',
      label: 'Agent time saved (estimate)',
      value: savedText(r.timeSaved.minutes),
      context: `${r.resolved.ai} tickets × ${r.timeSaved.minutesPerTicket} min each`,
    },
    {
      id: 'csat',
      label: 'Customer rating',
      value: ratingText(r.csat.all.average),
      context: r.csat.all.responses
        ? `${r.csat.all.responses} ratings · ${percent(r.csat.all.satisfied)} happy`
        : 'No ratings in this period',
    },
  ];
}
