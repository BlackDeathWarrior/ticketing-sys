import { describe, expect, it } from 'vitest';
import { actionLabel, controllerText, laneOf, laneRows, timerText } from './logic';

type M = { kind: 'customer' | 'ai' | 'agent' | 'note' | 'system'; byAi: boolean; id: string };
const m = (id: string, kind: M['kind'], byAi = false): M => ({ id, kind, byAi });

describe('handover logic', () => {
  it('puts messages in lanes and marks where the replying side switches', () => {
    expect(laneOf(m('1', 'note', true))).toBe('ai');
    expect(laneOf(m('2', 'note'))).toBe('human');
    const rows = laneRows([
      m('c1', 'customer'),
      m('a1', 'ai', true),
      m('n1', 'note', true),
      m('c2', 'customer'),
      m('h1', 'agent'),
      m('a2', 'ai', true),
    ]);
    expect(rows.map((r) => (r.type === 'switch' ? `→${r.to}` : r.message.id))).toEqual([
      'c1',
      'a1',
      'n1',
      'c2',
      '→human',
      'h1',
      '→ai',
      'a2',
    ]);
  });

  it('says who is replying', () => {
    expect(controllerText({ controller: 'ai', controllerUserId: null }, 'u1').text).toBe(
      'AI is replying',
    );
    expect(controllerText({ controller: 'human', controllerUserId: 'u1' }, 'u1').tone).toBe('me');
    expect(
      controllerText(
        { controller: 'human', controllerUserId: 'u2', controllerName: 'Maya Lindqvist' },
        'u1',
      ).text,
    ).toBe('Maya Lindqvist is replying');
    expect(controllerText({ controller: 'none', controllerUserId: null }, 'u1').text).toBe(
      'Waiting for a person',
    );
  });

  it('describes SLA timers', () => {
    const now = new Date('2026-09-30T10:00:00Z');
    const base = {
      kind: 'first_response' as const,
      targetMinutes: 60,
      startedAt: '2026-09-30T09:00:00Z',
      metAt: null,
      breachedAt: null,
      atRisk: false,
    };
    expect(timerText({ ...base, state: 'running', dueAt: '2026-09-30T10:45:00Z' }, now)).toBe(
      '45 min left',
    );
    expect(
      timerText({ ...base, state: 'running', dueAt: '2026-09-30T13:05:00Z', atRisk: true }, now),
    ).toBe('At risk · 3 h 5 min left');
    expect(timerText({ ...base, state: 'paused', dueAt: null }, now)).toMatch(/^Paused/);
    expect(timerText({ ...base, state: 'breached', dueAt: null }, now)).toBe('Missed');
    expect(actionLabel('handover.requested')).toBe('Handover requested');
  });
});
