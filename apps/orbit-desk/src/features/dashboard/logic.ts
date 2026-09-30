import type { ActivityEvent, OverviewReport } from '@tms/shared';
import { isOpenCategory } from '../../data/adapters';
import type { Priority, StatusCategory, Ticket } from '../../data/types';
import { duration } from '../../lib/format';

export type StatusTab = 'any' | 'open' | 'pending' | 'done';

export const statusTabs: Array<{ value: StatusTab; label: string }> = [
  { value: 'any', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'pending', label: 'Pending' },
  { value: 'done', label: 'Resolved' },
];

export function inTab(category: StatusCategory, tab: StatusTab): boolean {
  if (tab === 'any') return true;
  if (tab === 'done') return category === 'resolved' || category === 'closed';
  return category === tab;
}

const priorityRank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Work first: unfinished before finished, then priority, then most recently updated. */
export function byUrgency(a: Ticket, b: Ticket): number {
  const doneA = isOpenCategory(a.status.category) ? 0 : 1;
  const doneB = isOpenCategory(b.status.category) ? 0 : 1;
  if (doneA !== doneB) return doneA - doneB;
  if (a.priority !== b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

/** Open urgent/high tickets, urgent first and oldest first within a priority. */
export function triage(tickets: Ticket[], limit = 3): Ticket[] {
  return tickets
    .filter(
      (t) =>
        isOpenCategory(t.status.category) && (t.priority === 'urgent' || t.priority === 'high'),
    )
    .sort(
      (a, b) =>
        priorityRank[a.priority] - priorityRank[b.priority] ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    )
    .slice(0, limit);
}

export function triageSummary(urgent: number, high: number, unassigned: number): string {
  if (urgent + high === 0) return 'No urgent or high-priority tickets are open. The queue is calm.';
  const parts = [urgent ? `${urgent} urgent` : null, high ? `${high} high-priority` : null].filter(
    Boolean,
  );
  const who =
    unassigned === 0
      ? 'Every open ticket has an owner.'
      : `${unassigned} open ${unassigned === 1 ? 'ticket has' : 'tickets have'} no assignee yet.`;
  return `${parts.join(' and ')} ${urgent + high === 1 ? 'ticket is' : 'tickets are'} open. ${who}`;
}

export interface Kpi {
  id: string;
  label: string;
  value: string;
  context: string;
  series?: number[];
  seriesLabel?: string;
}

export function kpis(o: OverviewReport): Kpi[] {
  const today = o.volume.at(-1);
  const share = o.open ? Math.round((o.unassigned / o.open) * 100) : 0;
  return [
    {
      id: 'open',
      label: 'Open tickets',
      value: String(o.open),
      context: `${today?.created ?? 0} created today`,
      series: o.volume.map((d) => d.created),
      seriesLabel: 'Tickets created per day, last 14 days',
    },
    {
      id: 'unassigned',
      label: 'Unassigned',
      value: String(o.unassigned),
      context: `${share}% of open tickets`,
    },
    {
      id: 'resolved',
      label: 'Resolved, 7 days',
      value: String(o.resolvedLast7Days),
      context: `${o.resolvedToday} resolved today`,
      series: o.volume.map((d) => d.resolved),
      seriesLabel: 'Tickets resolved per day, last 14 days',
    },
    {
      id: 'resolution',
      label: 'Median resolution',
      value:
        o.medianResolutionMinutes === null ? '—' : duration(Math.round(o.medianResolutionMinutes)),
      context:
        o.medianFirstResponseMinutes === null
          ? 'No first responses this week'
          : `First response ${duration(Math.round(o.medianFirstResponseMinutes))} (median)`,
    },
  ];
}

/** "Maya Lindqvist moved to Resolved" style wording for an audit event. */
export function describeActivity(e: ActivityEvent): { actor: string; action: string } {
  const actor =
    e.actor.name ??
    (e.actor.type === 'customer' ? 'Customer' : e.actor.type === 'ai' ? 'AI agent' : 'System');
  const d = e.data as Record<string, unknown>;
  switch (e.action) {
    case 'ticket.created':
      return { actor, action: 'opened' };
    case 'ticket.assigned':
      return { actor, action: d.assigneeId === null ? 'unassigned' : 'assigned' };
    case 'ticket.status_changed':
      return { actor, action: `moved to ${String(d.to ?? 'a new status').replace(/_/g, ' ')}` };
    case 'ticket.note_added':
      return { actor, action: 'added a note on' };
    case 'ticket.updated':
      return { actor, action: 'updated' };
    default:
      return { actor, action: e.action.replace(/^ticket\./, '').replace(/_/g, ' ') };
  }
}

/** A y-axis maximum and ticks for small integer counts: 4 even steps. */
export function chartScale(values: number[]): { max: number; ticks: number[] } {
  const peak = Math.max(0, ...values);
  const step = Math.max(1, Math.ceil(peak / 4));
  const max = step * 4;
  return { max, ticks: [0, step, step * 2, step * 3, max] };
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
