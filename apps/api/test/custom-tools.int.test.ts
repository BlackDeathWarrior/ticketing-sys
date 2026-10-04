import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { INestApplicationContext } from '@nestjs/common';
import type { McpServerView, RoleView, ToolView } from '@tms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InboundService } from '../src/channels/inbound.service';
import type { Env } from '../src/config/env';
import { ENV } from '../src/infra/tokens';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { FAKE_LLM_BASE_URL } from './test-env';

/**
 * Custom tools and custom MCP servers, end to end. The "company systems" are
 * a small HTTP API and an MCP server started inside this test, so nothing
 * here depends on the bundled Demo Store sample.
 */
const API_TOKEN = `warehouse-token-${uniq()}`;
const MCP_TOKEN = `loyalty-token-${uniq()}`;

interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: unknown;
}
const seen: Seen[] = [];
let failWith: number | null = null;
let system: HttpServer;
let base: string;

/** The in-test MCP server: one read tool and one that reports a failure. */
function loyaltyServer() {
  const server = new McpServer(
    { name: 'loyalty', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'points_balance',
        title: 'Points balance',
        description: "The customer's loyalty points.",
        inputSchema: {
          type: 'object',
          properties: { email: { type: 'string', format: 'email' } },
          required: ['email'],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: 'redeem_points',
        description: 'Spends points on a voucher.',
        inputSchema: {
          type: 'object',
          properties: { email: { type: 'string' }, points: { type: 'integer', minimum: 1 } },
          required: ['email', 'points'],
        },
        annotations: { destructiveHint: true },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as { email?: string };
    if (req.params.name !== 'points_balance') {
      return { content: [{ type: 'text', text: 'Not enough points' }], isError: true };
    }
    const data = { email: args.email, points: 1240, tier: 'silver' };
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let lead: Awaited<ReturnType<typeof makeUser>>;
let supervisor: Awaited<ReturnType<typeof makeUser>>;
let providerId: string;
const created: string[] = [];

const definition = (over: Record<string, unknown> = {}) => ({
  name: uniq('stock_'),
  title: 'Stock level',
  description: 'How many units of a product are in the warehouse.',
  method: 'GET',
  url: `${base}/stock/{sku}`,
  authHeader: 'Authorization',
  parameters: [
    { name: 'sku', description: 'Product code, e.g. BIKE-CARGO-2' },
    { name: 'warehouse', required: false },
  ],
  ...over,
});

async function create(body: Record<string, unknown>, token = admin) {
  const res = await t.call<ToolView>('POST', '/tools/custom', { token, body });
  if (res.status === 201) created.push(res.body.id);
  return res;
}
const test = (id: string, body: Record<string, unknown>, token = admin) =>
  t.call('POST', `/tools/custom/${id}/test`, { token, body });
const roles = async () => (await t.call<RoleView[]>('GET', '/roles', { token: admin })).body;

beforeAll(async () => {
  system = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const body = req.method === 'GET' ? undefined : await readBody(req);
    if (url.pathname === '/mcp') {
      if (req.headers['x-api-key'] !== MCP_TOKEN) {
        res.writeHead(401).end('{"error":"wrong key"}');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const server = loyaltyServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    seen.push({
      method: req.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (failWith) return send(failWith, { error: 'warehouse system is down' });
    if (url.pathname === '/moved') {
      res.writeHead(302, { location: `${base}/stock/ANY` }).end();
      return;
    }
    const stock = /^\/stock\/(.+)$/.exec(url.pathname);
    if (stock) {
      const sku = decodeURIComponent(stock[1]!);
      return sku === 'NOPE'
        ? send(404, { error: 'unknown product' })
        : send(200, { sku, units: 14, warehouse: url.searchParams.get('warehouse') ?? 'main' });
    }
    const order = /^\/orders\/(DS-\d+)$/.exec(url.pathname);
    if (order && req.method === 'GET') {
      return send(200, {
        order_id: order[1],
        status: 'shipped',
        carrier: 'Northwind Parcel',
        tracking_number: 'NW-552190',
        owner: url.searchParams.get('email'),
      });
    }
    if (url.pathname === '/refunds' && req.method === 'POST') {
      const b = body as { order_id: string };
      return send(200, {
        refund_id: 'RF-7781',
        order_id: b.order_id,
        amount: 59.9,
        currency: 'EUR',
        arrives_in: '5 to 7 business days',
      });
    }
    send(404, { error: 'no such route' });
  });
  await new Promise<void>((resolve) => system.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(system.address() as AddressInfo).port}`;

  t = await startApp();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Cora Custom' });
  lead = await makeUser(t, admin, 'team_lead', { name: 'Tao Lead' });
  supervisor = await makeUser(t, admin, 'supervisor', { name: 'Sana Supervisor' });
  worker = await startWorker();
  // This test's systems live on the loopback address, which is private by default.
  for (const env of [t.app.get<Env>(ENV), worker.get<Env>(ENV)]) {
    if (!env.TOOL_PRIVATE_HOSTS.includes('127.0.0.1')) env.TOOL_PRIVATE_HOSTS.push('127.0.0.1');
  }
}, 60_000);

afterAll(async () => {
  for (const id of created) {
    const tool = (await t.call<ToolView[]>('GET', '/tools/custom', { token: admin })).body.find(
      (x) => x.id === id,
    );
    if (!tool?.custom) continue;
    const { token: _token, createdBy: _by, ...http } = tool.custom;
    await t.call('PUT', `/tools/custom/${id}`, {
      token: admin,
      body: {
        title: tool.title,
        description: tool.description,
        ...http,
        tier: tool.tier,
        customerArg: tool.customerArg,
        enabled: false,
      },
    });
  }
  for (const role of ['agent', 'team_lead', 'supervisor']) {
    await t.call('DELETE', `/roles/${role}/permissions/tool:create`, { token: admin });
  }
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await worker?.close();
  await t?.close();
  await new Promise((resolve) => system.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
  failWith = null;
});

describe('who may create custom tools', () => {
  it('is admins only until an admin grants the permission', async () => {
    for (const who of [agent, lead, supervisor]) {
      expect((await create(definition(), who.token)).status).toBe(403);
      expect((await t.call('GET', '/tools/custom', { token: who.token })).status).toBe(403);
    }
    expect((await t.call('GET', '/roles', { token: lead.token })).status).toBe(403);
    const all = await roles();
    expect(all.map((r) => r.key)).toEqual(['agent', 'team_lead', 'supervisor', 'admin']);
    expect(all.find((r) => r.key === 'admin')).toMatchObject({ locked: true });
    expect(all.find((r) => r.key === 'admin')!.permissions).toContain('tool:create');
    expect(all.find((r) => r.key === 'team_lead')!.permissions).not.toContain('tool:create');
  });

  it('lets a role create tools once granted, and stops it when revoked', async () => {
    const granted = await t.call<RoleView>('PUT', '/roles/team_lead/permissions/tool:create', {
      token: admin,
    });
    expect(granted.status).toBe(200);
    expect(granted.body.permissions).toContain('tool:create');

    const made = await create(definition(), lead.token);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.custom?.createdBy?.name).toBe('Tao Lead');
    // Still not an admin: no MCP servers, no keys, and agents are still refused.
    expect((await t.call('GET', '/tools/servers', { token: lead.token })).status).toBe(403);
    expect(
      (
        await t.call('PUT', `/settings/secrets/${made.body.custom!.token.key}`, {
          token: lead.token,
          body: { value: 'x'.repeat(16) },
        })
      ).status,
    ).toBe(403);
    expect((await create(definition(), agent.token)).status).toBe(403);

    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'role.permission_granted' },
    });
    expect(audit.body[0].data).toMatchObject({ role: 'team_lead', permission: 'tool:create' });

    await t.call('DELETE', '/roles/team_lead/permissions/tool:create', { token: admin });
    expect((await create(definition(), lead.token)).status).toBe(403);
  });

  it('only hands out delegable permissions, and never changes administrators', async () => {
    const other = await t.call('PUT', '/roles/agent/permissions/settings:secrets', {
      token: admin,
    });
    expect(other.status).toBe(400);
    expect(
      (await t.call('DELETE', '/roles/admin/permissions/tool:create', { token: admin })).status,
    ).toBe(400);
    expect(
      (await t.call('PUT', '/roles/nobody/permissions/tool:create', { token: admin })).status,
    ).toBe(404);
  });
});

describe('custom tools', () => {
  it('refuses unsafe or inconsistent definitions', async () => {
    const bad = async (over: Record<string, unknown>) => (await create(definition(over))).status;
    expect(await bad({ url: 'http://169.254.169.254/latest/{sku}' })).toBe(400);
    expect(await bad({ url: 'http://10.0.0.5/stock/{sku}' })).toBe(400);
    expect(await bad({ url: `${base}/stock/{missing}` })).toBe(400);
    expect(await bad({ name: 'Not A Name' })).toBe(400);
    expect(await bad({ customerArg: 'email' })).toBe(400);
    expect(await bad({ description: 'short' })).toBe(400);

    const first = await create(definition({ name: 'stock_twice' }));
    expect(first.status).toBe(201);
    expect((await create(definition({ name: 'stock_twice' }))).status).toBe(409);
  });

  it('starts switched off, and runs a test call with the token, path and query', async () => {
    const made = await create(definition());
    expect(made.body).toMatchObject({
      enabled: false,
      tier: 'read',
      serverName: 'Custom tools',
      qualifiedName: `custom__${made.body.name}`,
    });
    expect(made.body.custom?.token).toMatchObject({ set: false });
    // It is not an MCP server, so it never shows up in that list.
    const servers = (await t.call<McpServerView[]>('GET', '/tools/servers', { token: admin })).body;
    expect(servers.some((s) => s.slug === 'custom')).toBe(false);

    const key = await t.call('PUT', `/settings/secrets/${made.body.custom!.token.key}`, {
      token: admin,
      body: { value: API_TOKEN },
    });
    expect(key.status).toBe(200);

    const res = await test(made.body.id, { args: { sku: 'BIKE/CARGO 2', warehouse: 'north' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      result: { sku: 'BIKE/CARGO 2', units: 14, warehouse: 'north' },
    });
    expect(seen[0]).toMatchObject({
      method: 'GET',
      path: '/stock/BIKE%2FCARGO%202',
      query: { warehouse: 'north' },
    });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${API_TOKEN}`);
    // The key never comes back.
    const listed = (await t.call('GET', '/tools/custom', { token: admin })).body;
    expect(JSON.stringify(listed)).not.toContain(API_TOKEN);
  });

  it('checks arguments before calling, and reports the system saying no', async () => {
    const made = await create(definition());
    const missing = await test(made.body.id, { args: {} });
    expect(missing.body.status).toBe('denied');
    expect(seen).toHaveLength(0);
    // An input the tool does not have is dropped: the system never sees it.
    const extra = await test(made.body.id, { args: { sku: 'A', drop_table: true } });
    expect(extra.body.status).not.toBe('denied');
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toContain('drop_table');

    const unknown = await test(made.body.id, { args: { sku: 'NOPE' } });
    expect(unknown.body).toMatchObject({ status: 'error' });
    expect(unknown.body.error).toMatch(/answered 404.*unknown product/);
  });

  it('sends a JSON body for POST and refuses redirects', async () => {
    const post = await create(
      definition({
        method: 'POST',
        url: `${base}/refunds`,
        tier: 'write',
        parameters: [{ name: 'order_id' }, { name: 'amount', type: 'number', required: false }],
      }),
    );
    const res = await test(post.body.id, { args: { order_id: 'DS-90001', amount: 12.5 } });
    expect(res.body.status).toBe('ok');
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: '/refunds',
      body: { order_id: 'DS-90001', amount: 12.5 },
    });
    expect(seen[0]!.headers['content-type']).toBe('application/json');

    const moved = await create(definition({ url: `${base}/moved`, parameters: [] }));
    const redirect = await test(moved.body.id, { args: {} });
    expect(redirect.body.status).toBe('error');
    expect(seen.filter((s) => s.path.startsWith('/stock'))).toHaveLength(0);
  });

  it('stops calling a system that keeps failing, without blocking other tools', async () => {
    const flaky = await create(definition());
    const healthy = await create(definition());
    failWith = 503;
    for (let i = 0; i < 3; i++) await test(flaky.body.id, { args: { sku: 'A' } });
    const calls = seen.length;
    expect(calls).toBeGreaterThanOrEqual(5);
    const blocked = await test(flaky.body.id, { args: { sku: 'A' } });
    expect(blocked.body.error).toMatch(/unavailable right now/);
    expect(seen).toHaveLength(calls);

    failWith = null;
    expect((await test(healthy.body.id, { args: { sku: 'A' } })).body.status).toBe('ok');
  });

  it('can be edited and switched on, keeps its name, and is deleted only when unused', async () => {
    const made = await create(definition());
    const { token: _token, createdBy: _by, ...http } = made.body.custom!;
    const edited = await t.call<ToolView>('PUT', `/tools/custom/${made.body.id}`, {
      token: admin,
      body: {
        ...http,
        title: 'Warehouse stock',
        description: 'How many units of a product the warehouse holds right now.',
        tier: 'read',
        enabled: true,
      },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ title: 'Warehouse stock', enabled: true });
    expect(edited.body.name).toBe(made.body.name);

    const unused = await t.call('DELETE', `/tools/custom/${made.body.id}`, { token: admin });
    expect(unused.status).toBe(204);

    const used = await create(definition());
    await test(used.body.id, { args: { sku: 'A' } });
    expect((await t.call('DELETE', `/tools/custom/${used.body.id}`, { token: admin })).status).toBe(
      409,
    );
    // An MCP-server route can't touch a custom tool's holder.
    const all = (await t.call<ToolView[]>('GET', '/tools', { token: admin })).body;
    const holder = all.find((x) => x.custom)!.serverId;
    expect((await t.call('DELETE', `/tools/servers/${holder}`, { token: admin })).status).toBe(404);
  });
});

describe('the AI using custom tools', () => {
  const email = `${uniq('shopper')}@example.com`;
  interface Conv {
    messages: Array<{ authorType: string; body: string }>;
  }
  const conversation = async (ticketId: string) =>
    (
      (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Conv[]
    )[0]!;
  const aiSaid = (ticketId: string, text: string) =>
    waitFor(
      async () =>
        (await conversation(ticketId)).messages.find(
          (m) => m.authorType === 'ai' && m.body.includes(text),
        ),
      `AI message containing "${text}"`,
      20_000,
    );
  const chat = (text: string) => {
    const session = uniq('custom-chat');
    return t.app.get(InboundService).handle({
      channel: 'webchat',
      threadKey: session,
      channelMessageId: `${session}:1`,
      from: { identity: { type: 'email', value: email }, displayName: 'Custom Shopper' },
      text,
      receivedAt: new Date().toISOString(),
    });
  };

  beforeAll(async () => {
    // Only this test's tools are on offer, whatever earlier test files left enabled.
    const servers = (await t.call<McpServerView[]>('GET', '/tools/servers', { token: admin })).body;
    for (const s of servers.filter((x) => x.enabled)) {
      await t.call('PATCH', `/tools/servers/${s.id}`, { token: admin, body: { enabled: false } });
    }
    const p = await t.call('POST', '/settings/llm/providers', {
      token: admin,
      body: {
        provider: 'openai_compatible',
        label: `Custom tools fake ${uniq()}`,
        apiKey: 'fake-custom-key-00000',
        baseUrl: FAKE_LLM_BASE_URL,
      },
    });
    providerId = p.body.id;
    await t.call('POST', '/settings/llm/models', {
      token: admin,
      body: {
        providerId,
        model: 'scripted-cheap',
        inputCostPerMTok: 0.1,
        outputCostPerMTok: 0.4,
        supportsTools: true,
        supportsJson: true,
      },
    });
    const status = await create({
      name: 'order_status',
      title: 'Order status',
      description: 'Status, carrier and tracking number of one of the customer’s orders.',
      method: 'GET',
      url: `${base}/orders/{order_id}`,
      authHeader: null,
      parameters: [
        { name: 'order_id', description: 'Order number, e.g. DS-10421' },
        { name: 'email' },
      ],
      customerArg: 'email',
      enabled: true,
    });
    expect(status.status, JSON.stringify(status.body)).toBe(201);
    const refund = await create({
      name: 'issue_refund',
      title: 'Issue refund',
      description: 'Refunds money to the card used for one of the customer’s orders.',
      method: 'POST',
      url: `${base}/refunds`,
      authHeader: null,
      parameters: [{ name: 'order_id' }, { name: 'email' }, { name: 'reason', required: false }],
      customerArg: 'email',
      tier: 'transactional',
      enabled: true,
    });
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
  }, 60_000);

  it('answers from a custom tool, with the customer filled in by TMS', async () => {
    const r = await chat('Where is my order DS-90412?');
    const reply = await aiSaid(r.ticketId, 'DS-90412 is shipped');
    expect(reply.body).toContain('Northwind Parcel');
    expect(reply.body).toContain('NW-552190');

    const order = seen.find((s) => s.path === '/orders/DS-90412')!;
    // The model only gave the order number; the email came from the ticket's customer.
    expect(order.query).toEqual({ email });
    const calls = (await t.call('GET', `/tickets/${r.ticketId}/tool-calls`, { token: admin })).body;
    expect(calls[0]).toMatchObject({
      status: 'ok',
      actor: 'ai',
      tool: { name: 'order_status', serverName: 'Custom tools' },
    });
  });

  it("on an integration's site, acts only for a person the app has named", async () => {
    const app = await t.call<{ id: string; slug: string }>('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('shop-'), name: 'A shop' },
    });
    const victim = `${uniq('victim')}@example.com`;
    const onSite = (text: string, from: Parameters<InboundService['handle']>[0]['from']) => {
      const session = uniq('site-chat');
      return t.app.get(InboundService).handle({
        channel: 'webchat',
        threadKey: session,
        channelMessageId: `${session}:1`,
        from,
        text,
        receivedAt: new Date().toISOString(),
        ticket: { integrationId: app.body.id },
      });
    };

    // A visitor types someone else's address into the shop's chat and asks about "their" order.
    const stranger = await onSite('Where is my order DS-90414?', {
      identity: { type: 'webchat_session', value: uniq('anon-') },
      displayName: 'Somebody',
      extraIdentities: [{ type: 'email', value: victim, verified: false }],
    });
    await waitFor(async () => {
      const runs = (await t.call('GET', `/tickets/${stranger.ticketId}/ai-runs`, { token: admin }))
        .body as Array<{ kind: string }>;
      return runs.find((r) => r.kind === 'turn');
    }, 'the AI to answer the unidentified visitor');
    // A tool that takes the customer is not offered for a visitor the shop has not named:
    // nothing was tried, and the order system was never asked.
    expect(seen.some((s) => s.path === '/orders/DS-90414')).toBe(false);
    expect(
      (await t.call('GET', `/tickets/${stranger.ticketId}/tool-calls`, { token: admin })).body,
    ).toEqual([]);

    // The address's owner signs in: the shop vouches for them by its own id.
    const owner = await onSite('Where is my order DS-90415?', {
      identity: { type: 'external_id', value: `${app.body.slug}:user-1` },
      displayName: 'The Owner',
      extraIdentities: [{ type: 'email', value: victim, verified: true }],
    });
    await aiSaid(owner.ticketId, 'DS-90415 is shipped');
    // The proven claim took the address from the visitor who had only typed it.
    expect(seen.find((s) => s.path === '/orders/DS-90415')!.query).toEqual({ email: victim });
    const strangerNow = (await t.call('GET', `/customers/${stranger.customerId}`, { token: admin }))
      .body;
    expect(strangerNow.primaryEmail).toBeNull();
    expect(strangerNow.identities.some((i: { type: string }) => i.type === 'email')).toBe(false);
  });

  it('waits for approval before a transactional custom tool runs', async () => {
    const r = await chat('I was charged twice for order DS-90413, please refund me');
    await aiSaid(r.ticketId, 'to our team for approval');
    expect(seen.some((s) => s.path === '/refunds')).toBe(false);

    const [call] = (await t.call('GET', `/tickets/${r.ticketId}/tool-calls`, { token: admin }))
      .body;
    expect(call).toMatchObject({ status: 'awaiting_approval', tool: { name: 'issue_refund' } });
    const decided = await t.call('POST', `/approvals/${call.approval.id}/decide`, {
      token: supervisor.token,
      body: { decision: 'approve', reason: 'The second charge is confirmed.' },
    });
    expect(decided.status).toBe(200);

    await aiSaid(r.ticketId, 'RF-7781');
    const sent = seen.find((s) => s.path === '/refunds')!;
    expect(sent.body).toMatchObject({ order_id: 'DS-90413', email });
  });
});

describe('a custom MCP server', () => {
  let serverId: string;
  let list: ToolView[];

  it('is added, given its key, and synced', async () => {
    const added = await t.call<McpServerView>('POST', '/tools/servers', {
      token: admin,
      body: { name: `Loyalty ${uniq()}`, url: `${base}/mcp`, authHeader: 'X-Api-Key' },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    serverId = added.body.id;

    // Without its key the server refuses us, and the reason is kept.
    const refused = await t.call('POST', `/tools/servers/${serverId}/sync`, { token: admin });
    expect(refused.status).toBe(400);
    const failed = (await t.call<McpServerView[]>('GET', '/tools/servers', { token: admin })).body;
    expect(failed.find((s) => s.id === serverId)!.lastError).toBeTruthy();

    await t.call('PUT', `/settings/secrets/${added.body.token.key}`, {
      token: admin,
      body: { value: MCP_TOKEN },
    });
    const synced = await t.call<ToolView[]>('POST', `/tools/servers/${serverId}/sync`, {
      token: admin,
    });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    list = synced.body;
    expect(list.map((x) => x.name).sort()).toEqual(['points_balance', 'redeem_points']);
    // New tools start off; tiers and the customer argument are guessed from the server's hints.
    expect(list.find((x) => x.name === 'points_balance')).toMatchObject({
      enabled: false,
      tier: 'read',
      customerArg: 'email',
      custom: null,
    });
    expect(list.find((x) => x.name === 'redeem_points')).toMatchObject({ tier: 'transactional' });
  });

  it('runs a tool with the customer filled in, and reports a tool error', async () => {
    const balance = list.find((x) => x.name === 'points_balance')!;
    const ok = await t.call('POST', `/tools/${balance.id}/test`, {
      token: admin,
      body: { args: {}, customerEmail: 'ines.duarte@example.org' },
    });
    expect(ok.body).toMatchObject({
      status: 'ok',
      result: { email: 'ines.duarte@example.org', points: 1240, tier: 'silver' },
    });

    const redeem = list.find((x) => x.name === 'redeem_points')!;
    await t.call('PATCH', `/tools/${redeem.id}`, { token: admin, body: { tier: 'write' } });
    const failed = await t.call('POST', `/tools/${redeem.id}/test`, {
      token: admin,
      body: { args: { points: 50 }, customerEmail: 'ines.duarte@example.org' },
    });
    expect(failed.body).toMatchObject({ status: 'error', error: 'Not enough points' });
    const invalid = await t.call('POST', `/tools/${redeem.id}/test`, {
      token: admin,
      body: { args: { points: 0 }, customerEmail: 'ines.duarte@example.org' },
    });
    expect(invalid.body.status).toBe('denied');
  });

  it('records why a sync failed when the server stops answering', async () => {
    await t.call('PATCH', `/tools/servers/${serverId}`, {
      token: admin,
      body: { url: `${base.replace(/:\d+$/, ':9')}/mcp` },
    });
    const res = await t.call('POST', `/tools/servers/${serverId}/sync`, { token: admin });
    expect(res.status).toBe(400);
    const server = (
      await t.call<McpServerView[]>('GET', '/tools/servers', { token: admin })
    ).body.find((s) => s.id === serverId)!;
    expect(server.lastError).toBeTruthy();
    await t.call('PATCH', `/tools/servers/${serverId}`, { token: admin, body: { enabled: false } });
  });
});
