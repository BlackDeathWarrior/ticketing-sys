import { pickPolicy, ruleMatches } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_OPEN,
  addBusinessMinutes,
  businessMinutesBetween,
  type Hours,
  zonedToUtc,
} from './business-time';

// Mon–Fri 09:00–17:00 in India (UTC+5:30, no DST).
const india: Hours = {
  timezone: 'Asia/Kolkata',
  schedule: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
  holidays: new Set(['2026-10-02']), // Gandhi Jayanti, a Friday
};
const ist = (iso: string) => new Date(`${iso}+05:30`);

describe('business time', () => {
  it('is plain minutes when always open', () => {
    const start = new Date('2026-09-30T10:00:00Z');
    expect(addBusinessMinutes(start, 90, ALWAYS_OPEN).toISOString()).toBe(
      '2026-09-30T11:30:00.000Z',
    );
    expect(businessMinutesBetween(start, new Date('2026-10-01T10:00:00Z'), ALWAYS_OPEN)).toBe(1440);
  });

  it('carries over nights, weekends and holidays', () => {
    // Thursday 16:00 + 2 h: 1 h on Thursday, Friday is a holiday, weekend closed → Monday 10:00.
    expect(addBusinessMinutes(ist('2026-10-01T16:00:00'), 120, india).toISOString()).toBe(
      ist('2026-10-05T10:00:00').toISOString(),
    );
    // Starting outside hours counts from the next opening.
    expect(addBusinessMinutes(ist('2026-09-30T20:00:00'), 30, india).toISOString()).toBe(
      ist('2026-10-01T09:30:00').toISOString(),
    );
    expect(
      businessMinutesBetween(ist('2026-10-01T16:00:00'), ist('2026-10-05T10:00:00'), india),
    ).toBe(120);
  });

  it('agrees with itself: minutes between start and start + n is n', () => {
    const start = ist('2026-09-28T11:17:00');
    for (const n of [1, 59, 480, 1000, 5000]) {
      const due = addBusinessMinutes(start, n, india);
      expect(businessMinutesBetween(start, due, india)).toBe(n);
    }
  });

  it('keeps local opening hours across a DST change', () => {
    const berlin: Hours = {
      timezone: 'Europe/Berlin',
      schedule: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '09:00', end: '10:00' })),
      holidays: new Set(),
    };
    // Clocks go back on 25 October 2026: 09:00 is 07:00Z before, 08:00Z after.
    expect(zonedToUtc(2026, 10, 24, 9, 0, 'Europe/Berlin')).toBe(
      Date.parse('2026-10-24T07:00:00Z'),
    );
    expect(zonedToUtc(2026, 10, 26, 9, 0, 'Europe/Berlin')).toBe(
      Date.parse('2026-10-26T08:00:00Z'),
    );
    const due = addBusinessMinutes(new Date('2026-10-24T09:00:00Z'), 90, berlin);
    // 24th 09:00–10:00 is already over at 09:00Z (11:00 local); 25th gives 60, 26th the last 30.
    expect(due.toISOString()).toBe('2026-10-26T08:30:00.000Z');
  });
});

describe('policy and routing rule matching', () => {
  const policies = [
    { id: 'std', priority: null, customerType: null, enabled: true },
    { id: 'urgent', priority: 'urgent', customerType: null, enabled: true },
    { id: 'vip', priority: null, customerType: 'vip', enabled: true },
    { id: 'vip-urgent', priority: 'urgent', customerType: 'vip', enabled: true },
    { id: 'off', priority: 'low', customerType: null, enabled: false },
  ];

  it('picks the most specific enabled policy', () => {
    expect(pickPolicy(policies, { priority: 'urgent', customerType: 'vip' })?.id).toBe(
      'vip-urgent',
    );
    expect(pickPolicy(policies, { priority: 'urgent', customerType: null })?.id).toBe('urgent');
    expect(pickPolicy(policies, { priority: 'normal', customerType: 'vip' })?.id).toBe('vip');
    expect(pickPolicy(policies, { priority: 'low', customerType: null })?.id).toBe('std');
    expect(pickPolicy([], { priority: 'low', customerType: null })).toBeNull();
  });

  it('matches routing conditions', () => {
    const t = {
      channel: 'webchat',
      priority: 'high',
      categoryId: 'c1',
      subcategoryId: 'c1a',
      language: 'hi',
      customerType: 'vip',
    };
    expect(ruleMatches({}, t)).toBe(true);
    expect(ruleMatches({ language: 'hi', channel: 'webchat' }, t)).toBe(true);
    expect(ruleMatches({ categoryId: 'c1a' }, t)).toBe(true);
    expect(ruleMatches({ language: 'en' }, t)).toBe(false);
    expect(ruleMatches({ priority: 'urgent' }, t)).toBe(false);
    // A tag condition matches a ticket that carries the tag, among others.
    expect(ruleMatches({ tag: 'incident' }, t)).toBe(false);
    expect(ruleMatches({ tag: 'incident' }, { ...t, tags: ['scraper', 'incident'] })).toBe(true);
    expect(ruleMatches({ tag: 'incident', channel: 'email' }, { ...t, tags: ['incident'] })).toBe(
      false,
    );
  });
});
