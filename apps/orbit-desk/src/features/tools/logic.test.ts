import { describe, expect, it } from 'vitest';
import { argRows, parseArgs, resultPreview, schemaArgs, timeLeft } from './logic';

describe('tools logic', () => {
  it('shows arguments without the customer binding', () => {
    expect(argRows({ order_id: 'DS-1', email: 'a@b.c', amount: 5, note: '' }, ['email'])).toEqual([
      { label: 'Order id', value: 'DS-1' },
      { label: 'Amount', value: '5' },
    ]);
  });

  it('reads argument names from a schema', () => {
    expect(schemaArgs({ type: 'object', properties: { order_id: {}, email: {} } })).toEqual([
      'order_id',
      'email',
    ]);
    expect(schemaArgs({})).toEqual([]);
  });

  it('says how long an approval has left', () => {
    const now = new Date('2026-09-30T10:00:00Z');
    expect(timeLeft('2026-09-30T10:20:00Z', now)).toBe('in 20 min');
    expect(timeLeft('2026-09-30T15:00:00Z', now)).toBe('in 5 h');
    expect(timeLeft('2026-10-04T10:00:00Z', now)).toBe('in 4 days');
    expect(timeLeft('2026-09-30T09:00:00Z', now)).toBe('expired');
  });

  it('parses test arguments and previews results', () => {
    expect(parseArgs('{"order_id":"DS-1"}')).toEqual({ ok: true, value: { order_id: 'DS-1' } });
    expect(parseArgs('')).toEqual({ ok: true, value: {} });
    expect(parseArgs('[1]')).toMatchObject({ ok: false });
    expect(parseArgs('{')).toEqual({ ok: false, error: 'That is not valid JSON' });
    expect(resultPreview({ a: 'x'.repeat(300) }, 20)).toHaveLength(21);
  });
});
