import type { CustomToolHttp } from '@tms/shared';
import { createCustomToolSchema, customToolInputSchema, urlPlaceholders } from '@tms/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRequest, callHttpTool, HttpToolError } from './http-tool';

const http = (over: Partial<CustomToolHttp> = {}): CustomToolHttp => ({
  method: 'GET',
  url: 'https://api.shop.example/orders/{order_id}',
  authHeader: 'Authorization',
  parameters: [],
  ...over,
});

describe('custom tool request', () => {
  it('fills URL placeholders, escaped, and puts the rest in the query for GET', () => {
    const r = buildRequest(http(), { order_id: 'DS 1/2', include: 'items', page: 2 }, 'tok');
    expect(r.url).toBe('https://api.shop.example/orders/DS%201%2F2?include=items&page=2');
    expect(r.method).toBe('GET');
    expect(r.body).toBeUndefined();
    expect(r.headers.Authorization).toBe('Bearer tok');
  });

  it('sends the rest as a JSON body for POST, PUT and PATCH', () => {
    const r = buildRequest(
      http({ method: 'POST', url: 'https://api.shop.example/orders/{order_id}/notes' }),
      { order_id: 'DS-1', note: 'Call back', urgent: true, skip: null },
      null,
    );
    expect(r.url).toBe('https://api.shop.example/orders/DS-1/notes');
    expect(JSON.parse(r.body!)).toEqual({ note: 'Call back', urgent: true });
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers.Authorization).toBeUndefined();
  });

  it('sends another header as the bare token, and none when no token is saved', () => {
    expect(buildRequest(http({ authHeader: 'X-Api-Key' }), { order_id: '1' }, 'k')).toMatchObject({
      headers: { 'X-Api-Key': 'k' },
    });
    expect(
      buildRequest(http({ authHeader: 'X-Api-Key' }), { order_id: '1' }, null).headers,
    ).not.toHaveProperty('X-Api-Key');
  });

  it('refuses to send when a placeholder has no value', () => {
    expect(() => buildRequest(http(), {}, null)).toThrow(/Missing a value for order_id/);
  });

  it('keeps an existing query string', () => {
    const r = buildRequest(
      http({ url: 'https://api.shop.example/search?kind=order' }),
      { q: 'bike' },
      null,
    );
    expect(r.url).toBe('https://api.shop.example/search?kind=order&q=bike');
  });
});

describe('custom tool call', () => {
  afterEach(() => vi.unstubAllGlobals());
  const opts = { token: null, timeoutMs: 2000, privateHosts: ['api.shop.example'] };
  const respond = (body: string, status = 200) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );

  it('returns JSON, wraps plain text, and treats an empty answer as done', async () => {
    respond('{"status":"shipped"}');
    expect(await callHttpTool(http(), { order_id: '1' }, opts)).toEqual({ status: 'shipped' });
    respond('all good');
    expect(await callHttpTool(http(), { order_id: '1' }, opts)).toEqual({ text: 'all good' });
    respond('', 200);
    expect(await callHttpTool(http(), { order_id: '1' }, opts)).toEqual({ ok: true });
  });

  it('reports 4xx as the system saying no, and 5xx and 429 as an outage', async () => {
    const failure = (): Promise<HttpToolError> =>
      callHttpTool(http(), { order_id: '1' }, opts).then(
        () => {
          throw new Error('expected the call to fail');
        },
        (err: HttpToolError) => err,
      );
    respond('{"error":"order not found"}', 404);
    const notFound = await failure();
    expect(notFound).toBeInstanceOf(HttpToolError);
    expect(notFound.fromTool).toBe(true);
    expect(notFound.message).toMatch(/answered 404: \{"error":"order not found"\}/);

    respond('down', 503);
    expect((await failure()).fromTool).toBe(false);
    respond('slow down', 429);
    expect((await failure()).fromTool).toBe(false);
  });

  it('never follows a redirect', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await callHttpTool(http(), { order_id: '1' }, opts);
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'error' });
  });

  it('refuses private addresses unless the host is allowed', async () => {
    respond('{}');
    await expect(
      callHttpTool(
        http({ url: 'http://169.254.169.254/latest/{order_id}' }),
        { order_id: 'x' },
        {
          ...opts,
          privateHosts: [],
        },
      ),
    ).rejects.toThrow(/not reachable from the public internet/);
  });
});

describe('custom tool definition', () => {
  const base = {
    name: 'order_notes',
    title: 'Order notes',
    description: 'Reads the internal notes on an order.',
    method: 'GET',
    url: 'https://api.shop.example/orders/{order_id}/notes',
    parameters: [{ name: 'order_id', description: 'Order number' }],
  };

  it('accepts a complete definition and fills the defaults', () => {
    const v = createCustomToolSchema.parse(base);
    expect(v).toMatchObject({ tier: 'read', enabled: false, timeoutMs: 8000, authHeader: null });
    expect(v.parameters[0]).toEqual({
      name: 'order_id',
      type: 'string',
      description: 'Order number',
      required: true,
    });
  });

  it('needs every URL placeholder to be a required parameter', () => {
    expect(createCustomToolSchema.safeParse({ ...base, parameters: [] }).success).toBe(false);
    expect(
      createCustomToolSchema.safeParse({
        ...base,
        parameters: [{ name: 'order_id', required: false }],
      }).success,
    ).toBe(false);
    expect(urlPlaceholders('https://a.example/{x}/b/{y}?z={x}')).toEqual(['x', 'y']);
  });

  it('refuses a placeholder in the host, other protocols and duplicate parameters', () => {
    const bad = (over: Record<string, unknown>) =>
      createCustomToolSchema.safeParse({ ...base, ...over }).success;
    expect(bad({ url: 'https://{order_id}.example/x', parameters: [{ name: 'order_id' }] })).toBe(
      false,
    );
    expect(bad({ url: 'ftp://files.example/{order_id}' })).toBe(false);
    expect(bad({ url: 'not a url' })).toBe(false);
    expect(bad({ parameters: [{ name: 'order_id' }, { name: 'order_id' }] })).toBe(false);
    expect(bad({ name: 'Order Notes' })).toBe(false);
    expect(bad({ customerArg: 'email' })).toBe(false);
  });

  it('builds the JSON schema the model and the validator use', () => {
    expect(
      customToolInputSchema([
        { name: 'order_id', type: 'string', description: 'Order number', required: true },
        { name: 'limit', type: 'integer', description: '', required: false },
      ]),
    ).toEqual({
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order number' },
        limit: { type: 'integer' },
      },
      required: ['order_id'],
      additionalProperties: false,
    });
  });
});
