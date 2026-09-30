import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { checkTransition, lifecycleTimestamps } from './workflow.rules';

const statuses = DEFAULT_STATUSES.map((s) => ({ ...s, isActive: true }));
const transitions = DEFAULT_TRANSITIONS.map(([fromStatus, toStatus]) => ({ fromStatus, toStatus }));

describe('checkTransition', () => {
  it('allows transitions in the default workflow', () => {
    expect(checkTransition(statuses, transitions, 'new', 'ai_handling')).toEqual({ ok: true });
    expect(checkTransition(statuses, transitions, 'ai_handling', 'human_assigned')).toEqual({
      ok: true,
    });
    expect(checkTransition(statuses, transitions, 'resolved', 'in_progress')).toEqual({ ok: true });
  });

  it('rejects transitions not in the workflow', () => {
    expect(checkTransition(statuses, transitions, 'closed', 'in_progress')).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });

  it('rejects same, unknown and inactive statuses', () => {
    expect(checkTransition(statuses, transitions, 'new', 'new')).toMatchObject({
      reason: 'same_status',
    });
    expect(checkTransition(statuses, transitions, 'new', 'nope')).toMatchObject({
      reason: 'unknown_status',
    });
    const inactive = statuses.map((s) => (s.key === 'ai_handling' ? { ...s, isActive: false } : s));
    expect(checkTransition(inactive, transitions, 'new', 'ai_handling')).toMatchObject({
      reason: 'inactive_status',
    });
  });
});

describe('lifecycleTimestamps', () => {
  const now = new Date('2026-09-30T10:00:00Z');

  it('stamps resolution and clears on reopen', () => {
    expect(lifecycleTimestamps('resolved', now)).toEqual({ resolvedAt: now, closedAt: null });
    expect(lifecycleTimestamps('closed', now)).toEqual({ closedAt: now });
    expect(lifecycleTimestamps('open', now)).toEqual({ resolvedAt: null, closedAt: null });
  });
});
