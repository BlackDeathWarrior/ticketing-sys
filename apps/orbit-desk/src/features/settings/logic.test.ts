import type { Permission } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  canOpenSettings,
  formatPerMTok,
  formatUsd,
  maskedKey,
  move,
  parseBudget,
  visibleTabs,
} from './logic';

const can = (perms: Permission[]) => (p: Permission) => perms.includes(p);

describe('settings tabs', () => {
  it('shows every tab to an admin and nothing to an agent', () => {
    const admin = can(['settings:llm', 'settings:channels', 'settings:secrets']);
    expect(visibleTabs(admin).map((t) => t.value)).toEqual([
      'providers',
      'models',
      'channels',
      'tools',
      'usage',
    ]);
    expect(canOpenSettings(can(['ticket:read']))).toBe(false);
  });

  it('shows only channels to someone with channel settings alone', () => {
    expect(visibleTabs(can(['settings:channels'])).map((t) => t.value)).toEqual(['channels']);
  });
});

describe('formatting', () => {
  it('formats money at a useful precision', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.00042)).toBe('$0.0004');
    expect(formatUsd(0.00003)).toBe('<$0.0001');
    expect(formatUsd(3.456)).toBe('$3.46');
    expect(formatUsd(1234.5)).toBe('$1,235');
    expect(formatUsd(null)).toBe('—');
  });

  it('formats per-million-token prices', () => {
    expect(formatPerMTok(0.1)).toBe('$0.1');
    expect(formatPerMTok(0.075)).toBe('$0.075');
    expect(formatPerMTok(15)).toBe('$15.00');
    expect(formatPerMTok(null)).toBe('unknown');
  });

  it('masks keys to the last four characters', () => {
    expect(maskedKey('abcd')).toBe('••••abcd');
    expect(maskedKey(null)).toBe('••••');
    expect(maskedKey(null, false)).toBe('Not set');
  });
});

describe('form helpers', () => {
  it('parses budgets, treating empty as no cap', () => {
    expect(parseBudget('')).toBeNull();
    expect(parseBudget('$10')).toBe(10);
    expect(parseBudget('0')).toBe(0);
    expect(parseBudget('-1')).toBe('invalid');
    expect(parseBudget('ten')).toBe('invalid');
  });

  it('reorders a list', () => {
    expect(move(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});
