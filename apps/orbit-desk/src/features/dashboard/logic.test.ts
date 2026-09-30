import type { ActivityEvent, OverviewReport } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { toTicket } from '../../data/adapters';
import { apiTicket, workflow } from '../../test/fixtures';
import {
  byUrgency,
  chartScale,
  describeActivity,
  inTab,
  kpis,
  shortDate,
  triage,
  triageSummary,
} from './logic';

const ticket = (o: Parameters<typeof apiTicket>[0]) => toTicket(apiTicket(o), workflow);

describe('status tabs', () => {
  it('group categories', () => {
    expect(inTab('open', 'any')).toBe(true);
    expect(inTab('pending', 'pending')).toBe(true);
    expect(inTab('pending', 'open')).toBe(false);
    expect(inTab('closed', 'done')).toBe(true);
    expect(inTab('resolved', 'done')).toBe(true);
  });
});

describe('queue order', () => {
  it('puts unfinished work first, then priority, then most recent', () => {
    const done = ticket({ subject: 'done', status: 'resolved', priority: 'urgent' });
    const low = ticket({ subject: 'low', priority: 'low' });
    const highOld = ticket({
      subject: 'highOld',
      priority: 'high',
      updatedAt: '2026-09-01T00:00:00Z',
    });
    const highNew = ticket({
      subject: 'highNew',
      priority: 'high',
      updatedAt: '2026-09-29T00:00:00Z',
    });
    expect([done, low, highOld, highNew].sort(byUrgency).map((t) => t.subject)).toEqual([
      'highNew',
      'highOld',
      'low',
      'done',
    ]);
  });
});

describe('triage', () => {
  it('picks open urgent then high tickets, oldest first, at most three', () => {
    const picks = triage([
      ticket({ subject: 'normal', priority: 'normal' }),
      ticket({ subject: 'high', priority: 'high', createdAt: '2026-09-01T00:00:00Z' }),
      ticket({ subject: 'urgent-new', priority: 'urgent', createdAt: '2026-09-29T00:00:00Z' }),
      ticket({ subject: 'urgent-old', priority: 'urgent', createdAt: '2026-09-02T00:00:00Z' }),
      ticket({ subject: 'urgent-done', priority: 'urgent', status: 'resolved' }),
      ticket({ subject: 'high-2', priority: 'high', createdAt: '2026-09-10T00:00:00Z' }),
    ]);
    expect(picks.map((t) => t.subject)).toEqual(['urgent-old', 'urgent-new', 'high']);
  });

  it('summarises counts in plain words', () => {
    expect(triageSummary(0, 0, 0)).toMatch(/calm/);
    expect(triageSummary(1, 0, 1)).toBe(
      '1 urgent ticket is open. 1 open ticket has no assignee yet.',
    );
    expect(triageSummary(2, 3, 0)).toBe(
      '2 urgent and 3 high-priority tickets are open. Every open ticket has an owner.',
    );
  });
});

describe('kpis', () => {
  const overview = {
    open: 20,
    unassigned: 5,
    resolvedToday: 2,
    resolvedLast7Days: 9,
    medianResolutionMinutes: 150,
    medianFirstResponseMinutes: null,
    volume: [
      { date: '2026-09-29', created: 3, resolved: 1 },
      { date: '2026-09-30', created: 4, resolved: 2 },
    ],
  } as OverviewReport;

  it('derives the four tiles from the overview', () => {
    const [open, unassigned, resolved, median] = kpis(overview);
    expect(open).toMatchObject({ value: '20', context: '4 created today', series: [3, 4] });
    expect(unassigned).toMatchObject({ value: '5', context: '25% of open tickets' });
    expect(resolved).toMatchObject({ value: '9', context: '2 resolved today', series: [1, 2] });
    expect(median).toMatchObject({ value: '2h 30m', context: 'No first responses this week' });
  });

  it('shows a dash when nothing was resolved', () => {
    expect(kpis({ ...overview, medianResolutionMinutes: null })[3]!.value).toBe('—');
  });
});

describe('activity wording', () => {
  const event = (
    action: string,
    data: Record<string, unknown> = {},
    name: string | null = 'Aiko Tanaka',
  ) =>
    ({
      id: 1,
      occurredAt: '',
      action,
      actor: { type: name ? 'user' : 'system', id: null, name },
      ticket: null,
      data,
    }) as ActivityEvent;

  it('describes common ticket events', () => {
    expect(describeActivity(event('ticket.created'))).toEqual({
      actor: 'Aiko Tanaka',
      action: 'opened',
    });
    expect(
      describeActivity(event('ticket.status_changed', { to: 'pending_customer' })).action,
    ).toBe('moved to pending customer');
    expect(describeActivity(event('ticket.assigned', { assigneeId: null })).action).toBe(
      'unassigned',
    );
    expect(describeActivity(event('ticket.note_added', {}, null))).toEqual({
      actor: 'System',
      action: 'added a note on',
    });
  });
});

describe('chart scale', () => {
  it('uses four even integer steps that cover the peak', () => {
    expect(chartScale([0, 0])).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(chartScale([3, 14, 7])).toEqual({ max: 16, ticks: [0, 4, 8, 12, 16] });
  });

  it('formats UTC dates as short labels', () => {
    expect(shortDate('2026-09-17')).toBe('Sep 17');
  });
});
