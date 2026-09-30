import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUSES,
  DEFAULT_TRANSITIONS,
  PERMISSIONS,
  SYSTEM_ROLES,
  formatTicketNumber,
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
