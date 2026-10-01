import type { PerformanceReport } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  compareRows,
  minutesText,
  percent,
  periodText,
  ratingText,
  reportKpis,
  reportParams,
  resolvedSegments,
  savedText,
  usd,
} from './logic';

const sla = (met: number, breached: number) => ({
  met,
  breached,
  compliance: met + breached ? met / (met + breached) : null,
});

const report = (over: Partial<PerformanceReport> = {}): PerformanceReport => ({
  generatedAt: '2026-10-15T09:00:00Z',
  from: '2026-09-16',
  to: '2026-10-15',
  filters: { channel: null, teamId: null },
  created: 60,
  resolved: { total: 40, ai: 18, ai_then_human: 6, human: 16 },
  aiResolutionRate: 0.45,
  aiWorked: {
    total: 30,
    deflected: 18,
    toPerson: 9,
    open: 3,
    deflectionRate: 0.6,
    handoverRate: 0.3,
  },
  medianFirstResponseMinutes: { ai: 0, human: 42 },
  medianResolutionMinutes: { ai: 4, human: 380 },
  timeSaved: { minutes: 180, minutesPerTicket: 10 },
  sla: {
    firstResponse: { ai: sla(18, 0), human: sla(12, 4) },
    resolution: { ai: sla(18, 0), human: sla(10, 6) },
    overall: { ai: sla(36, 0), human: sla(22, 10), all: sla(58, 10) },
  },
  csat: {
    all: { responses: 12, average: 4.25, satisfied: 0.75 },
    ai: { responses: 5, average: 4.6, satisfied: 0.8 },
    human: { responses: 7, average: 4, satisfied: 5 / 7 },
    asked: 30,
  },
  cost: { totalUsd: 1.234, calls: 210, byProvider: [], perAiResolvedUsd: 0.0686 },
  daily: [],
  byChannel: [],
  ...over,
});

describe('report filters', () => {
  const base = { range: '30' as const, from: '', to: '', channel: '', teamId: '' };

  it('sends a number of days for a preset, and dates for a custom period', () => {
    expect(reportParams(base)).toEqual({ days: '30', channel: undefined, teamId: undefined });
    expect(reportParams({ ...base, channel: 'webchat', teamId: 't1' })).toMatchObject({
      channel: 'webchat',
      teamId: 't1',
    });
    expect(
      reportParams({ ...base, range: 'custom', from: '2026-10-01', to: '2026-10-07' }),
    ).toEqual({ from: '2026-10-01', to: '2026-10-07', channel: undefined, teamId: undefined });
  });

  it('waits until a custom period is complete and in order', () => {
    expect(reportParams({ ...base, range: 'custom' })).toBeNull();
    expect(reportParams({ ...base, range: 'custom', from: '2026-10-01' })).toBeNull();
    expect(
      reportParams({ ...base, range: 'custom', from: '2026-10-08', to: '2026-10-07' }),
    ).toBeNull();
  });
});

describe('report formatting', () => {
  it('shows a dash when there was nothing to measure', () => {
    expect([percent(null), minutesText(null), ratingText(null), usd(null)]).toEqual([
      '—',
      '—',
      '—',
      '—',
    ]);
  });

  it('formats rates, times, ratings and money', () => {
    expect(percent(0.456)).toBe('46%');
    expect(minutesText(0)).toBe('under 1m');
    expect(minutesText(380)).toBe('6h 20m');
    expect(ratingText(4.25)).toBe('4.3 / 5');
    expect(usd(0)).toBe('$0');
    expect(usd(0.0041)).toBe('$0.0041');
    expect(usd(1.234)).toBe('$1.23');
    expect(savedText(45)).toBe('45 min');
    expect(savedText(180)).toBe('3 h');
    expect(savedText(95)).toBe('1.6 h');
    expect(savedText(1230)).toBe('21 h');
  });

  it('writes the period for people', () => {
    expect(periodText('2026-09-16', '2026-10-15')).toMatch(/^16 Sept? – 15 Oct 2026$/);
    expect(periodText('2026-10-15', '2026-10-15')).toBe('15 Oct 2026');
    expect(periodText('2025-12-20', '2026-01-10')).toBe('20 Dec 2025 – 10 Jan 2026');
  });
});

describe('report content', () => {
  it('builds the four key figures with what they count', () => {
    const kpis = reportKpis(report());
    expect(kpis.map((k) => [k.id, k.value])).toEqual([
      ['ai-resolved', '45%'],
      ['handover', '30%'],
      ['time-saved', '3 h'],
      ['csat', '4.3 / 5'],
    ]);
    expect(kpis[0]!.context).toBe('18 of 40 resolved tickets');
    expect(kpis[2]!.context).toBe('18 tickets × 10 min each');
    expect(kpis[3]!.context).toBe('12 ratings · 75% happy');
    const empty = reportKpis(
      report({ csat: { ...report().csat, all: { responses: 0, average: null, satisfied: null } } }),
    );
    expect(empty[3]).toMatchObject({ value: '—', context: 'No ratings in this period' });
  });

  it('splits resolved tickets three ways and leaves out empty parts', () => {
    const parts = resolvedSegments(report().resolved);
    expect(parts.map((p) => [p.key, p.count])).toEqual([
      ['ai', 18],
      ['ai_then_human', 6],
      ['human', 16],
    ]);
    expect(parts.reduce((sum, p) => sum + p.share, 0)).toBeCloseTo(1);
    expect(
      resolvedSegments({ total: 3, ai: 0, ai_then_human: 0, human: 3 }).map((p) => p.key),
    ).toEqual(['human']);
    expect(resolvedSegments({ total: 0, ai: 0, ai_then_human: 0, human: 0 })).toEqual([]);
  });

  it('puts the AI and people side by side on the same measures', () => {
    const rows = compareRows(report());
    expect(rows.map((r) => [r.metric, r.ai, r.human])).toEqual([
      ['First reply', 'under 1m', '42m'],
      ['Time to final answer', '4m', '6h 20m'],
      ['SLA targets met', '100% (36 of 36)', '69% (22 of 32)'],
      ['Customer rating', '4.6 / 5', '4.0 / 5'],
      ['Happy customers', '80%', '71%'],
    ]);
  });
});
