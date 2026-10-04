import type { ToolView } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { catalogueAddresses, knownSystems, operationsFromOpenApi } from './tool-discovery';

let n = 0;
/** A custom tool as the tools list returns it; `keySaved` is whether its key is stored. */
function tool(
  url: string,
  over: { authHeader?: string | null; keySaved?: boolean; customerArg?: string | null } = {},
): ToolView {
  n += 1;
  return {
    id: `tool-${n}`,
    serverId: 'custom',
    serverName: 'Custom tools',
    name: `tool_${n}`,
    qualifiedName: `custom__tool_${n}`,
    title: `Tool ${n}`,
    description: '',
    inputSchema: {},
    enabled: true,
    tier: 'read',
    timeoutMs: 10_000,
    customerArg: over.customerArg ?? null,
    approverTeamId: null,
    missing: false,
    custom: {
      method: 'GET',
      url,
      authHeader: over.authHeader === undefined ? 'Authorization' : over.authHeader,
      parameters: [],
      token: { key: `tool.tool_${n}.token`, set: over.keySaved ?? false, last4: null },
      createdBy: null,
    },
  } as ToolView;
}

describe('systems the custom tools already call', () => {
  it('groups tools by host and finds what they share', () => {
    const systems = knownSystems([
      tool('https://shop.example.com/api/support/tools/orders/{order_id}', {
        customerArg: 'customer_email',
      }),
      tool('https://shop.example.com/api/support/tools/products', {
        customerArg: 'customer_email',
      }),
      tool('https://billing.example.com/v1/invoices', { authHeader: 'X-Api-Key' }),
    ]);

    expect(systems.map((s) => s.origin)).toEqual([
      'https://shop.example.com',
      'https://billing.example.com',
    ]);
    expect(systems[0]).toMatchObject({
      base: 'https://shop.example.com/api/support/tools',
      keyHeader: 'Authorization',
      customerParameter: 'customer_email',
    });
    expect(systems[1]).toMatchObject({ keyHeader: 'X-Api-Key', customerParameter: null });
  });

  it('offers a saved key only for the host it was saved for', () => {
    const keyed = tool('https://shop.example.com/api/orders', { keySaved: true });
    const systems = knownSystems([keyed, tool('https://billing.example.com/v1/invoices')]);

    expect(systems.find((s) => s.origin === 'https://shop.example.com')!.keyed).toEqual({
      id: keyed.id,
      title: keyed.title,
    });
    expect(systems.find((s) => s.origin === 'https://billing.example.com')!.keyed).toBeNull();
  });

  it('does not offer the key of a tool that sends none', () => {
    const [system] = knownSystems([
      tool('https://shop.example.com/api/status', { authHeader: null, keySaved: true }),
    ]);
    expect(system!.keyed).toBeNull();
  });

  it('skips tools from MCP servers and addresses that are not addresses', () => {
    const mcp = { ...tool('https://mcp.example.com/x'), custom: null } as ToolView;
    expect(knownSystems([mcp, tool('not an address')])).toEqual([]);
  });

  it('looks for the catalogue beside the tools first, then at the host', () => {
    const [system] = knownSystems([
      tool('https://shop.example.com/api/support/tools/orders'),
      tool('https://shop.example.com/api/support/tools/products'),
    ]);
    expect(catalogueAddresses(system!)).toEqual([
      'https://shop.example.com/api/support/tools/openapi.json',
      'https://shop.example.com/openapi.json',
    ]);
  });
});

describe('reading a system’s OpenAPI document', () => {
  const from = 'https://shop.example.com/api/support/tools/openapi.json';

  it('builds full addresses beside the document, with path and query inputs', () => {
    const [op] = operationsFromOpenApi(
      {
        paths: {
          '/orders/{order_id}': {
            get: {
              summary: 'Order status',
              parameters: [
                { name: 'order_id', in: 'path', schema: { type: 'string' } },
                {
                  name: 'limit',
                  in: 'query',
                  schema: { type: 'integer' },
                  description: 'How many',
                },
                { name: 'X-Trace', in: 'header' },
              ],
            },
          },
        },
      },
      from,
    );

    expect(op).toEqual({
      method: 'GET',
      url: 'https://shop.example.com/api/support/tools/orders/{order_id}',
      summary: 'Order status',
      changesData: false,
      parameters: [
        { name: 'order_id', type: 'string', required: true, description: '' },
        { name: 'limit', type: 'integer', required: false, description: 'How many' },
      ],
    });
  });

  it('takes a request that is not a GET as one that changes data, unless the system says otherwise', () => {
    const ops = operationsFromOpenApi(
      {
        paths: {
          '/orders/cancel': { post: { summary: 'Cancel' } },
          '/search': { post: { summary: 'Search', 'x-changes-data': false } },
        },
      },
      from,
    );
    expect(ops.map((o) => [o.url.split('/').pop(), o.changesData])).toEqual([
      ['cancel', true],
      ['search', false],
    ]);
  });

  it('reads a JSON body’s fields as inputs and marks the required ones', () => {
    const [op] = operationsFromOpenApi(
      {
        paths: {
          '/refunds': {
            post: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      required: ['order_id'],
                      properties: {
                        order_id: { type: 'string' },
                        amount: { type: 'number' },
                        'Not-A-Name': { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      from,
    );
    expect(op!.parameters).toEqual([
      { name: 'order_id', type: 'string', required: true, description: '' },
      { name: 'amount', type: 'number', required: false, description: '' },
    ]);
  });

  it('uses an absolute server the document names', () => {
    const [op] = operationsFromOpenApi(
      { servers: [{ url: 'https://api.example.com/v2/' }], paths: { '/ping': { get: {} } } },
      from,
    );
    expect(op!.url).toBe('https://api.example.com/v2/ping');
  });

  it('returns nothing for a document that is not shaped as one', () => {
    expect(operationsFromOpenApi(null, from)).toEqual([]);
    expect(operationsFromOpenApi({ paths: 'nope' }, from)).toEqual([]);
    expect(
      operationsFromOpenApi({ paths: { 'no-slash': { get: {} }, '/x': 'nope' } }, from),
    ).toEqual([]);
  });
});
