import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUSES,
  DEFAULT_TRANSITIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  formatTicketNumber,
  lastDays,
  median,
  normalizeIdentity,
  parseTicketNumber,
} from './index';

describe('default workflow', () => {
  const keys = new Set(DEFAULT_STATUSES.map((s) => s.key));

  it('has exactly one initial status', () => {
    expect(DEFAULT_STATUSES.filter((s) => s.isInitial)).toHaveLength(1);
  });

  it('only references defined statuses', () => {
    for (const [from, to] of DEFAULT_TRANSITIONS) {
      expect(keys.has(from), from).toBe(true);
      expect(keys.has(to), to).toBe(true);
    }
  });

  it('can reach closed from new', () => {
    const next = new Map<string, string[]>();
    for (const [f, t] of DEFAULT_TRANSITIONS) next.set(f, [...(next.get(f) ?? []), t]);
    const seen = new Set(['new']);
    const queue = ['new'];
    while (queue.length) {
      for (const n of next.get(queue.shift()!) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect([...keys].every((k) => seen.has(k))).toBe(true);
  });
});

describe('roles', () => {
  it('only grant known permissions', () => {
    for (const role of Object.values(SYSTEM_ROLES)) {
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
    }
  });

  it('admin has everything', () => {
    expect([...SYSTEM_ROLES.admin.permissions].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('agents cannot approve or manage users', () => {
    expect(SYSTEM_ROLES.agent.permissions).not.toContain('approval:approve');
    expect(SYSTEM_ROLES.agent.permissions).not.toContain('user:manage');
  });
});

describe('normalizeIdentity', () => {
  it('lowercases emails', () => {
    expect(normalizeIdentity('email', '  Priya@Example.COM ')).toBe('priya@example.com');
  });

  it('reduces phone numbers to digits', () => {
    expect(normalizeIdentity('whatsapp', '+91 98300-12345')).toBe('919830012345');
    expect(normalizeIdentity('phone', '(919) 830 012345')).toBe('919830012345');
  });
});

describe('ticket numbers', () => {
  it('round-trips', () => {
    expect(formatTicketNumber(1042)).toBe('TMS-1042');
    expect(parseTicketNumber('TMS-1042')).toBe(1042);
    expect(parseTicketNumber('tms-7')).toBe(7);
    expect(parseTicketNumber('1042')).toBe(1042);
    expect(parseTicketNumber('ABC-1')).toBeNull();
  });
});

describe('report helpers', () => {
  it('median handles empty, odd and even lists', () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('lastDays returns UTC dates ending today, oldest first', () => {
    const days = lastDays(new Date('2026-03-02T23:30:00Z'), 4);
    expect(days).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });
});
