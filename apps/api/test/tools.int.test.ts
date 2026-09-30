import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { approvals, type Database, toolCalls } from '@tms/db';
import { type AiGolden, checkAiGolden, goldenToSimulation } from '@tms/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InboundService } from '../src/channels/inbound.service';
import { DB } from '../src/infra/tokens';
import { ApprovalsService } from '../src/tools/approvals.service';
import { startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { FAKE_LLM_BASE_URL, FAKE_MCP_TOKEN, FAKE_MCP_URL } from './test-env';

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: string;
let supervisor: string;
let providerId: string;
let serverId: string;
let slug: string;
const toolId: Record<string, string> = {};

interface ToolCall {
  id: string;
  tool: { name: string };
  status: string;
  actor: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  approval: { id: string; status: string } | null;
}
interface Msg {
  authorType: string;
  body: string;
  deliveryStatus: string | null;
}
interface Run {
  kind: string;
  decision: string;
  rules: string[];
  tools: Array<{ name: string; summary: string }>;
  sources: Array<{ chunkId: string; label: string }>;
}

async function user(role: string) {
  const email = `${uniq(role)}@test.local`;
  await t.call('POST', '/users', {
    token: admin,
    body: { email, name: `Tools ${role}`, password: 'Tools-Passw0rd!', roles: [role] },
  });
  return (await t.login(email, 'Tools-Passw0rd!')).accessToken;
}

/** A web chat from a customer we know by email (as a signed-in visitor would be). */
async function chat(email: string, text: string) {
  const session = uniq('tools-chat');
  return t.app.get(InboundService).handle({
    channel: 'webchat',
    threadKey: session,
    channelMessageId: `${session}:1`,
    from: { identity: { type: 'email', value: email }, displayName: email.split('@')[0] },
    text,
    receivedAt: new Date().toISOString(),
  });
}

const calls = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/tool-calls`, { token: admin })).body as ToolCall[];
const messages = async (ticketId: string) =>
  (
    (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Array<{
      controller: string;
      messages: Msg[];
    }>
  )[0]!;
const runs = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/ai-runs`, { token: admin })).body as Run[];
const aiSaid = async (ticketId: string, text: string) =>
  waitFor(
    async () =>
      (await messages(ticketId)).messages.find(
        (m) => m.authorType === 'ai' && m.body.includes(text),
      ),
    `AI message containing "${text}"`,
    20_000,
  );

/** Asks for a refund and waits for the approval it creates. */
async function refundRequest(email: string, order: string) {
  const r = await chat(email, `I was charged twice for order ${order}, please refund me`);
  await aiSaid(r.ticketId, 'to our team for approval');
  const [call] = await calls(r.ticketId);
  expect(call).toMatchObject({ status: 'awaiting_approval', tool: { name: 'issue_refund' } });
  return { ...r, approvalId: call!.approval!.id };
}

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  agent = await user('agent');
  supervisor = await user('supervisor');
  await fetch(new URL('/demo-store/reset', FAKE_MCP_URL), { method: 'POST' });

  const p = await t.call('POST', '/settings/llm/providers', {
    token: admin,
    body: {
      provider: 'openai_compatible',
      label: `Tools fake ${uniq()}`,
      apiKey: 'fake-tools-key-0000000',
      baseUrl: FAKE_LLM_BASE_URL,
    },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  providerId = p.body.id;
  const m = await t.call('POST', '/settings/llm/models', {
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
  expect(m.status).toBe(201);
  worker = await startWorker();
}, 60_000);

afterAll(async () => {
  await worker?.close();
  if (serverId) {
    await t.call('PATCH', `/tools/servers/${serverId}`, { token: admin, body: { enabled: false } });
  }
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await t?.close();
});

describe('tool registry', () => {
  it('is for admins only', async () => {
    expect((await t.call('GET', '/tools/servers', { token: agent })).status).toBe(403);
    expect((await t.call('GET', '/tools', { token: supervisor })).status).toBe(403);
    expect((await t.call('GET', '/approvals', { token: agent })).status).toBe(403);
    expect((await t.call('GET', '/approvals', { token: supervisor })).status).toBe(200);
  });

  it('refuses servers on private or metadata addresses', async () => {
    const res = await t.call('POST', '/tools/servers', {
      token: admin,
      body: { name: 'Sneaky', url: 'http://169.254.169.254/mcp' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not reachable from the public internet/);
  });

  it('registers the Demo Store server, keeps its token write-only, and syncs its tools', async () => {
    const res = await t.call('POST', '/tools/servers', {
      token: admin,
      body: { name: 'Demo Store systems', url: FAKE_MCP_URL, authHeader: 'Authorization' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    serverId = res.body.id;
    slug = res.body.slug;
    expect(res.body.token).toEqual({ key: `tool.${slug}.token`, set: false, last4: null });

    // Without the token the server says no, and the error is kept on the server.
    const denied = await t.call('POST', `/tools/servers/${serverId}/sync`, { token: admin });
    expect(denied.status).toBe(400);
    const [before] = (await t.call('GET', '/tools/servers', { token: admin })).body.filter(
      (s: { id: string }) => s.id === serverId,
    );
    expect(before.lastError).toBeTruthy();

    const secret = await t.call('PUT', `/settings/secrets/tool.${slug}.token`, {
      token: admin,
      body: { value: FAKE_MCP_TOKEN },
    });
    expect(secret.status).toBe(200);
    const synced = await t.call('POST', `/tools/servers/${serverId}/sync`, { token: admin });
    expect(synced.status, JSON.stringify(synced.body)).toBe(200);
    const byName = Object.fromEntries(
      (synced.body as Array<{ id: string; name: string }>).map((x) => [x.name, x]),
    );
    expect(Object.keys(byName).sort()).toEqual([
      'issue_refund',
      'lookup_customer',
      'order_status',
      'payment_status',
    ]);
    // New tools start off; the tier comes from the server's hints; the email is bound to the customer.
    expect(byName.order_status).toMatchObject({
      enabled: false,
      tier: 'read',
      customerArg: 'email',
    });
    expect(byName.issue_refund).toMatchObject({ tier: 'transactional', customerArg: 'email' });
    for (const [name, v] of Object.entries(byName)) toolId[name] = v.id;

    const servers = (await t.call('GET', '/tools/servers', { token: admin })).body;
    const s = servers.find((x: { id: string }) => x.id === serverId);
    expect(s).toMatchObject({ toolCount: 4, lastError: null });
    expect(s.token).toEqual({
      key: `tool.${slug}.token`,
      set: true,
      last4: FAKE_MCP_TOKEN.slice(-4),
    });
    expect(JSON.stringify(servers)).not.toContain(FAKE_MCP_TOKEN);
  });

  it('tests read tools and refuses to test transactional ones', async () => {
    const ok = await t.call('POST', `/tools/${toolId.order_status}/test`, {
      token: admin,
      body: { args: { order_id: 'DS-10421' }, customerEmail: 'bea.sandoval@example.com' },
    });
    expect(ok.body).toMatchObject({
      status: 'ok',
      result: { order_id: 'DS-10421', status: 'shipped' },
    });

    const invalid = await t.call('POST', `/tools/${toolId.order_status}/test`, {
      token: admin,
      body: { args: {}, customerEmail: 'bea.sandoval@example.com' },
    });
    expect(invalid.body).toMatchObject({
      status: 'denied',
      error: expect.stringMatching(/order_id/),
    });

    const refund = await t.call('POST', `/tools/${toolId.issue_refund}/test`, {
      token: admin,
      body: {
        args: { order_id: 'DS-10388', reason: 'test' },
        customerEmail: 'tom.whitaker@example.com',
      },
    });
    expect(refund.status).toBe(400);
  });

  it('validates tool settings, then enables the tools', async () => {
    const bad = await t.call('PATCH', `/tools/${toolId.order_status}`, {
      token: admin,
      body: { customerArg: 'nope' },
    });
    expect(bad.status).toBe(400);
    for (const id of Object.values(toolId)) {
      const r = await t.call('PATCH', `/tools/${id}`, { token: admin, body: { enabled: true } });
      expect(r.status).toBe(200);
    }
  });
});

describe('AI with company tools', () => {
  it('looks up the customer’s own order and answers from it', async () => {
    const r = await chat('bea.sandoval@example.com', 'Where is my order DS-10421?');
    const reply = await aiSaid(r.ticketId, 'Order DS-10421 is shipped');
    expect(reply.body).toContain('NW-7731-0042');

    const [call] = await calls(r.ticketId);
    expect(call).toMatchObject({ status: 'ok', actor: 'ai', tool: { name: 'order_status' } });
    // The email came from the ticket, not from the model.
    expect(call!.args).toEqual({ order_id: 'DS-10421', email: 'bea.sandoval@example.com' });
    const [run] = await runs(r.ticketId);
    expect(run).toMatchObject({ decision: 'sent' });
    expect(run!.sources.map((s) => s.label)).toContain('Demo Store systems · Order status');
    expect(run!.tools.find((x) => x.name === 'order_status')?.summary).toBe(
      'order id DS-10421 → done',
    );
  });

  it('cannot see another customer’s order, and hands over', async () => {
    const r = await chat('omar.farouk@example.org', 'Where is my order DS-10421?');
    const run = await waitFor(async () => (await runs(r.ticketId))[0], 'AI run', 20_000);
    expect(run).toMatchObject({ decision: 'handover', rules: ['ai_requested'] });
    const [call] = await calls(r.ticketId);
    expect(call).toMatchObject({
      status: 'error',
      error: 'No order DS-10421 was found for this customer',
    });
    expect(call!.result).toBeNull();
  });

  it('dry runs use read tools but never act or store anything', async () => {
    const before = (await t.app.get<Database>(DB).select().from(toolCalls)).length;
    const status = await t.call('POST', '/ai/simulate', {
      token: admin,
      body: {
        messages: [{ author: 'customer', body: 'Where is my order DS-10421?' }],
        customerEmail: 'bea.sandoval@example.com',
      },
    });
    expect(status.body).toMatchObject({
      decision: 'sent',
      reply: expect.stringContaining('shipped'),
    });
    const refund = await t.call('POST', '/ai/simulate', {
      token: admin,
      body: {
        messages: [
          { author: 'customer', body: 'Please refund order DS-10388, I was charged twice' },
        ],
        customerEmail: 'tom.whitaker@example.com',
      },
    });
    expect(refund.body.tools).toContainEqual({
      name: 'issue_refund',
      summary: expect.stringContaining('not run (dry run)'),
    });
    expect((await t.app.get<Database>(DB).select().from(toolCalls)).length).toBe(before);
  });
});

describe('approvals', () => {
  it('holds a refund for a supervisor, runs it once approved, and tells the customer', async () => {
    const r = await refundRequest('tom.whitaker@example.com', 'DS-10388');
    expect((await messages(r.ticketId)).controller).toBe('ai');

    const inbox = (
      await t.call('GET', '/approvals', { token: supervisor, query: { status: 'pending' } })
    ).body;
    const item = inbox.find((a: { id: string }) => a.id === r.approvalId);
    expect(item).toMatchObject({
      status: 'pending',
      tool: { name: 'issue_refund', tier: 'transactional', serverName: 'Demo Store systems' },
      args: { order_id: 'DS-10388', email: 'tom.whitaker@example.com' },
      evidence: expect.stringContaining('charged twice'),
    });
    expect(item.summary).toMatch(/^Issue refund: order id DS-10388/);
    expect(item.summary).not.toContain('tom.whitaker');

    // Agents can't approve; supervisors can.
    const denied = await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: agent,
      body: { decision: 'approve' },
    });
    expect(denied.status).toBe(403);
    const ok = await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: supervisor,
      body: { decision: 'approve', note: 'Duplicate charge confirmed' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decidedBy: { name: 'Tools supervisor' } });

    const told = await aiSaid(r.ticketId, 'has been issued');
    expect(told.body).toMatch(
      /refund of 59\.90 EUR for order DS-10388 has been issued \(reference RF-\d+\)/,
    );
    const [call] = await calls(r.ticketId);
    expect(call).toMatchObject({ status: 'ok', result: { order_id: 'DS-10388', amount: 59.9 } });
    const followup = (await runs(r.ticketId)).find((x) => x.kind === 'followup');
    expect(followup).toMatchObject({ decision: 'sent' });

    // A second decision is refused.
    const again = await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: supervisor,
      body: { decision: 'reject' },
    });
    expect(again.status).toBe(409);
    const audit = await t.call('GET', '/audit', { token: admin, query: { targetId: r.ticketId } });
    const actions = (audit.body.items ?? audit.body).map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['approval.requested', 'approval.approved', 'tool.called']),
    );
  });

  it('tells the customer when a request is rejected', async () => {
    const r = await refundRequest('diego.paredes@example.net', 'DS-77421');
    const res = await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: supervisor,
      body: { decision: 'reject', note: 'Return not received yet' },
    });
    expect(res.body).toMatchObject({ status: 'rejected', note: 'Return not received yet' });
    const told = await aiSaid(r.ticketId, 'could not approve');
    // The supervisor's note is internal.
    expect(told.body).not.toContain('Return not received');
    const [call] = await calls(r.ticketId);
    expect(call).toMatchObject({ status: 'rejected', result: null });
  });

  it('hands over when a request expires', async () => {
    const r = await refundRequest('chidi.eze@example.com', 'DS-80114');
    const db = t.app.get<Database>(DB);
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, r.approvalId));
    expect(await worker.get(ApprovalsService, { strict: false }).expire(r.approvalId)).toBe(true);

    const run = await waitFor(
      async () => (await runs(r.ticketId)).find((x) => x.kind === 'followup'),
      'follow-up after expiry',
      20_000,
    );
    expect(run).toMatchObject({ decision: 'handover', rules: ['approval_expired'] });
    expect((await messages(r.ticketId)).controller).toBe('none');
    const late = await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: supervisor,
      body: { decision: 'approve' },
    });
    expect(late.status).toBe(409);
  });

  it('leaves a note instead when a person has taken over', async () => {
    const r = await refundRequest('lena.fischer@example.org', 'DS-48213');
    const conv = (await t.call('GET', `/tickets/${r.ticketId}/conversations`, { token: admin }))
      .body[0] as { id: string };
    await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent,
      body: { body: 'Hi, I am looking into this for you.' },
    });
    await t.call('POST', `/approvals/${r.approvalId}/decide`, {
      token: supervisor,
      body: { decision: 'approve' },
    });
    const note = await waitFor(
      async () =>
        (await t.call('GET', `/tickets/${r.ticketId}/notes`, { token: admin })).body.find(
          (n: { body: string }) => n.body.includes('was approved and done'),
        ),
      'follow-up note',
      20_000,
    );
    expect(note.body).toContain('please let the customer know');
    const ai = (await messages(r.ticketId)).messages.filter((m) => m.authorType === 'ai');
    expect(ai.some((m) => m.body.includes('has been issued'))).toBe(false);
  });
});

describe('golden conversations with tools (apps/api/test/evals/tools.yaml)', () => {
  const goldens = parse(
    readFileSync(path.join(__dirname, 'evals/tools.yaml'), 'utf8'),
  ) as AiGolden[];

  it.each(goldens.map((g) => [g.name, g] as const))('%s', async (_name, golden) => {
    const res = await t.call('POST', '/ai/simulate', {
      token: admin,
      body: goldenToSimulation(golden),
    });
    expect(res.status).toBe(200);
    expect(checkAiGolden(golden, res.body)).toEqual([]);
  });
});
