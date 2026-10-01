import { describe, expect, it } from 'vitest';
import type { ToolView } from '@tms/shared';
import {
  argRows,
  customToolBody,
  emptyCustomTool,
  formFromTool,
  parseArgs,
  resultPreview,
  schemaArgs,
  timeLeft,
} from './logic';

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

describe('custom tool form', () => {
  const tool: ToolView = {
    id: 't1',
    serverId: 's1',
    serverName: 'Custom tools',
    name: 'stock_level',
    qualifiedName: 'custom__stock_level',
    title: 'Stock level',
    description: 'How many units of a product are in the warehouse.',
    inputSchema: {},
    enabled: true,
    tier: 'read',
    timeoutMs: 8000,
    customerArg: 'email',
    missing: false,
    custom: {
      method: 'GET',
      url: 'https://api.shop.example/stock/{sku}',
      authHeader: 'X-Api-Key',
      parameters: [
        { name: 'sku', type: 'string', description: 'Product code', required: true },
        { name: 'email', type: 'string', description: '', required: true },
      ],
      token: { key: 'tool.custom_stock_level.token', set: true, last4: '9f2c' },
      createdBy: null,
    },
  };

  it('starts empty, switched off and read-only', () => {
    expect(emptyCustomTool()).toMatchObject({
      method: 'GET',
      tier: 'read',
      enabled: false,
      parameters: [],
    });
  });

  it('round-trips a saved tool through the form', () => {
    const form = formFromTool(tool);
    expect(form).toMatchObject({
      name: 'stock_level',
      authHeader: 'X-Api-Key',
      customerArg: 'email',
    });
    expect(customToolBody(form)).toEqual({
      title: 'Stock level',
      description: 'How many units of a product are in the warehouse.',
      method: 'GET',
      url: 'https://api.shop.example/stock/{sku}',
      authHeader: 'X-Api-Key',
      parameters: tool.custom!.parameters,
      tier: 'read',
      customerArg: 'email',
      timeoutMs: 8000,
      enabled: true,
    });
  });

  it('trims what was typed, and drops a customer argument that no longer exists', () => {
    const body = customToolBody({
      ...formFromTool(tool),
      title: '  Stock  ',
      authHeader: '',
      parameters: [{ name: ' sku ', type: 'string', description: ' Code ', required: true }],
    });
    expect(body.title).toBe('Stock');
    expect(body.authHeader).toBeNull();
    expect(body.parameters).toEqual([
      { name: 'sku', type: 'string', description: 'Code', required: true },
    ]);
    expect(body.customerArg).toBeNull();
  });
});
