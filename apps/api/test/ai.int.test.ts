import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { type AiGolden, checkAiGolden, goldenToSimulation } from '@tms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { InboundService } from '../src/channels/inbound.service';
import { ConversationsService } from '../src/conversations/conversations.service';
import { startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { applyEmailEnv, FAKE_LLM_BASE_URL } from './test-env';

applyEmailEnv();

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: string;
let providerId: string;
let chatModelId: string;

const KB_DIR = path.resolve(__dirname, '../../../scripts/sample-data/kb');

interface Run {
  decision: string;
  confidence: number | null;
  rules: string[];
  model: string | null;
  promptVersion: string;
  sources: Array<{ chunkId: string; label: string }>;
  replyMessageId: string | null;
  kind: string;
}
interface Msg {
  id: string;
  authorType: string;
  deliveryStatus: string | null;
  body: string;
}
interface Conv {
  id: string;
  controller: string;
  messages: Msg[];
}

/** A customer message through the same pipeline every channel uses. */
async function chat(text: string, session = uniq('session')) {
  const r = await t.app.get(InboundService).handle({
    channel: 'webchat',
    threadKey: session,
    channelMessageId: `${session}:${uniq()}`,
    from: { identity: { type: 'webchat_session', value: session }, displayName: 'Test Visitor' },
    text,
    receivedAt: new Date().toISOString(),
  });
  return { ...r, session };
}

async function email(subject: string, text: string) {
  const id = `<${uniq('mail')}@customer.example>`;
  return t.app.get(InboundService).handle({
    channel: 'email',
    threadKey: id,
    channelMessageId: id,
    from: {
      identity: { type: 'email', value: `${uniq('cust')}@customer.example` },
      displayName: 'Mail Customer',
    },
    subject,
    text,
    receivedAt: new Date().toISOString(),
  });
}

const ticket = async (id: string) => (await t.call('GET', `/tickets/${id}`, { token: admin })).body;
const conversations = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Conv[];
const runs = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/ai-runs`, { token: admin })).body as Run[];

async function waitForTurn(ticketId: string, count = 1) {
  return waitFor(
    async () => {
      const turns = (await runs(ticketId)).filter((r) => r.kind === 'turn');
      return turns.length >= count ? turns[0] : undefined;
    },
    `AI turn ${count} on ${ticketId}`,
    20_000,
  );
}

async function upload(file: string) {
  const boundary = `----tms${uniq()}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="visibility"\r\n\r\npublic\r\n`,
    ),
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file}"\r\nContent-Type: text/markdown\r\n\r\n`,
    ),
    readFileSync(path.join(KB_DIR, file)),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/kb/documents/upload',
    headers: {
      authorization: `Bearer ${admin}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();

  const email = `${uniq('ai-agent')}@test.local`;
  await t.call('POST', '/users', {
    token: admin,
    body: { email, name: 'Aria Agent', password: 'Ai-Agent-Passw0rd!', roles: ['agent'] },
  });
  agent = (await t.login(email, 'Ai-Agent-Passw0rd!')).accessToken;

  const p = await t.call('POST', '/settings/llm/providers', {
    token: admin,
    body: {
      provider: 'openai_compatible',
      label: `AI fake ${uniq()}`,
      apiKey: 'fake-ai-key-00000000',
      baseUrl: FAKE_LLM_BASE_URL,
    },
  });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  providerId = p.body.id;
  const model = (body: Record<string, unknown>) =>
    t.call('POST', '/settings/llm/models', { token: admin, body: { providerId, ...body } });
  chatModelId = (
    await model({
      model: 'scripted-cheap',
      inputCostPerMTok: 0.1,
      outputCostPerMTok: 0.4,
      supportsTools: true,
      supportsJson: true,
    })
  ).body.id;
  const embed = await model({
    model: 'scripted-embed',
    mode: 'embedding',
    inputCostPerMTok: 0.02,
    outputCostPerMTok: 0,
  });
  await t.call('PUT', '/settings/llm/roles/embedding', {
    token: admin,
    body: { mode: 'ordered', modelIds: [embed.body.id] },
  });

  worker = await startWorker();
  for (const f of ['returns-policy.md', 'billing-faq.md', 'shipping-faq.md']) {
    const id = await upload(f);
    await waitFor(
      async () =>
        (await t.call('GET', `/kb/documents/${id}`, { token: admin })).body.indexState === 'indexed'
          ? true
          : undefined,
      `${f} indexed`,
      30_000,
    );
    await t.call('POST', `/kb/documents/${id}/status`, {
      token: admin,
      body: { status: 'approved' },
    });
  }
}, 90_000);

afterAll(async () => {
  await worker?.close();
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await t?.close();
});

describe('AI agent on web chat', () => {
  let first: Awaited<ReturnType<typeof chat>>;

  it('takes a new chat, answers from the knowledge base and sends it', async () => {
    first = await chat('When will my refund reach my card?');
    expect(first.createdTicket).toBe(true);
    expect((await ticket(first.ticketId)).status).toBe('ai_handling');
    expect((await conversations(first.ticketId))[0]!.controller).toBe('ai');

    const run = await waitForTurn(first.ticketId);
    expect(run).toMatchObject({
      decision: 'sent',
      model: 'openai/scripted-cheap',
      promptVersion: 'agent-v1',
    });
    expect(run.sources.length).toBeGreaterThan(0);
    const reply = await waitFor(async () => {
      const m = (await conversations(first.ticketId))[0]!.messages.find(
        (x) => x.authorType === 'ai',
      );
      return m?.deliveryStatus === 'sent' ? m : undefined;
    }, 'the AI reply to be delivered');
    expect(reply.body).toMatch(/^Thanks for your message\./);

    // The visitor sees it, labelled as the AI.
    const history = await t.app.get(ConversationsService).chatHistory(first.session);
    expect(history.at(-1)).toMatchObject({ authorType: 'ai', authorName: 'AI assistant' });

    const tk = await ticket(first.ticketId);
    expect(tk.firstResponseAt).not.toBeNull();
    expect(tk.status).toBe('pending_customer');

    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'ai.turn', targetId: first.ticketId },
    });
    expect(audit.body[0].actorType).toBe('ai');
  });

  it('classifies the new ticket', async () => {
    const tk = await waitFor(async () => {
      const x = await ticket(first.ticketId);
      return x.aiClassification ? x : undefined;
    }, 'classification');
    expect(tk.aiClassification).toMatchObject({
      category: 'Billing',
      language: 'en',
      model: 'openai/scripted-cheap',
    });
    expect(tk.category?.name).toBe('Billing');
    const kinds = (await runs(first.ticketId)).map((r) => r.kind);
    expect(kinds).toContain('classify');
  });

  it("hands the customer's follow-up back to the AI", async () => {
    await chat('And how long does express delivery take?', first.session);
    await waitForTurn(first.ticketId, 2);
    const conv = (await conversations(first.ticketId))[0]!;
    expect(conv.messages.filter((m) => m.authorType === 'ai')).toHaveLength(2);
    expect(conv.controller).toBe('ai');
  });

  it('drafts when unsure; an agent approves the edited draft and it is delivered', async () => {
    const c = await chat('What do penguins eat in winter?');
    const run = await waitForTurn(c.ticketId);
    expect(run.decision).toBe('drafted');
    const draft = (await conversations(c.ticketId))[0]!.messages.find(
      (m) => m.deliveryStatus === 'draft',
    )!;
    expect(draft.authorType).toBe('ai');
    // Drafts never reach the visitor.
    const history = await t.app.get(ConversationsService).chatHistory(c.session);
    expect(history.some((m) => m.id === draft.id)).toBe(false);

    const res = await t.call('POST', `/messages/${draft.id}/approve`, {
      token: agent,
      body: { body: 'We only sell bikes, but thanks for asking about penguins!' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sent = await waitFor(async () => {
      const m = (await conversations(c.ticketId))[0]!.messages.find((x) => x.id === draft.id);
      return m?.deliveryStatus === 'sent' ? m : undefined;
    }, 'the approved draft to be delivered');
    expect(sent.body).toBe('We only sell bikes, but thanks for asking about penguins!');
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'message.draft_approved', targetId: c.ticketId },
    });
    expect(audit.body[0]).toMatchObject({
      actorType: 'user',
      data: expect.objectContaining({ edited: true }),
    });
    expect(
      (await t.call('POST', `/messages/${draft.id}/approve`, { token: agent, body: {} })).status,
    ).toBe(409);
  });

  it("a person's reply supersedes a waiting draft", async () => {
    const c = await chat('Are penguins allowed in the store?');
    await waitForTurn(c.ticketId);
    const conv = (await conversations(c.ticketId))[0]!;
    const draft = conv.messages.find((m) => m.deliveryStatus === 'draft')!;
    await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent,
      body: { body: 'Only well-behaved ones!' },
    });
    const after = (await conversations(c.ticketId))[0]!.messages.find((m) => m.id === draft.id)!;
    expect(after.deliveryStatus).toBe('discarded');
  });

  it('discards a draft', async () => {
    const c = await chat('Do you sell penguin food?');
    await waitForTurn(c.ticketId);
    const draft = (await conversations(c.ticketId))[0]!.messages.find(
      (m) => m.deliveryStatus === 'draft',
    )!;
    expect((await t.call('POST', `/messages/${draft.id}/discard`, { token: agent })).status).toBe(
      200,
    );
    const m = (await conversations(c.ticketId))[0]!.messages.find((x) => x.id === draft.id)!;
    expect(m.deliveryStatus).toBe('discarded');
  });

  it('hands over when the customer asks for a person', async () => {
    const c = await chat('Can I talk to a real person please?');
    const run = await waitForTurn(c.ticketId);
    expect(run).toMatchObject({ decision: 'handover', rules: ['asked_for_human'] });
    const conv = (await conversations(c.ticketId))[0]!;
    expect(conv.controller).toBe('none');
    expect(conv.messages.at(-1)).toMatchObject({ authorType: 'ai' });
    expect(conv.messages.at(-1)!.body).toMatch(/member of our team/);
    expect((await ticket(c.ticketId)).status).toBe('human_assigned');
    const notes = (await t.call('GET', `/tickets/${c.ticketId}/notes`, { token: admin })).body;
    expect(notes[0]).toMatchObject({ authorType: 'ai' });
    expect(notes[0].body).toContain('The customer asked for a person');
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'ai.handover', targetId: c.ticketId },
    });
    expect(audit.body).toHaveLength(1);
  });

  it('stops answering once a person replies', async () => {
    const c = await chat('How long does standard delivery take?');
    await waitForTurn(c.ticketId);
    const conv = (await conversations(c.ticketId))[0]!;
    const reply = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent,
      body: { body: 'Hi, Aria here.' },
    });
    expect(reply.status).toBe(201);
    expect((await conversations(c.ticketId))[0]!.controller).toBe('human');

    await chat('Thanks Aria, one more question about returns.', c.session);
    await new Promise((r) => setTimeout(r, 2_500));
    expect((await runs(c.ticketId)).filter((r) => r.kind === 'turn')).toHaveLength(1);
  });

  it('hands over when the AI budget runs out mid-conversation', async () => {
    const c = await chat('What payment methods do you accept?');
    await waitForTurn(c.ticketId);
    await t.call('PATCH', `/settings/llm/providers/${providerId}`, {
      token: admin,
      body: { budgetUsd: 0 },
    });
    try {
      await chat('Can I pay with UPI?', c.session);
      const run = await waitForTurn(c.ticketId, 2);
      expect(run).toMatchObject({ decision: 'handover', rules: ['budget_exhausted'] });
      expect((await conversations(c.ticketId))[0]!.controller).toBe('none');
    } finally {
      await t.call('PATCH', `/settings/llm/providers/${providerId}`, {
        token: admin,
        body: { budgetUsd: null },
      });
    }
  });

  it('leaves new conversations to humans when no model can serve them', async () => {
    await t.call('PATCH', `/settings/llm/models/${chatModelId}`, {
      token: admin,
      body: { enabled: false },
    });
    try {
      const c = await chat('Is anyone there?');
      expect((await conversations(c.ticketId))[0]!.controller).toBe('none');
      expect((await ticket(c.ticketId)).status).toBe('new');
    } finally {
      await t.call('PATCH', `/settings/llm/models/${chatModelId}`, {
        token: admin,
        body: { enabled: true },
      });
    }
  });
});

describe('AI agent on email', () => {
  it('only drafts email replies; the approved draft is emailed', async () => {
    const r = await email(
      'Charged twice for order 55120',
      'I was charged twice, a duplicate charge on my card.',
    );
    const run = await waitForTurn(r.ticketId);
    expect(run.decision).toBe('drafted');
    const draft = (await conversations(r.ticketId))[0]!.messages.find(
      (m) => m.deliveryStatus === 'draft',
    )!;
    expect(
      (await t.call('POST', `/messages/${draft.id}/approve`, { token: agent, body: {} })).status,
    ).toBe(200);
    await waitFor(async () => {
      const m = (await conversations(r.ticketId))[0]!.messages.find((x) => x.id === draft.id);
      return m?.deliveryStatus === 'sent' ? m : undefined;
    }, 'the approved email to be sent');
  });
});

describe('AI settings', () => {
  it('only settings:ai may change behaviour, and "off" keeps the AI out', async () => {
    expect((await t.call('PUT', '/settings/ai', { token: agent, body: {} })).status).toBe(403);
    const bad = await t.call('PUT', '/settings/ai', {
      token: admin,
      body: { sendAt: 0.5, handoverBelow: 0.7 },
    });
    expect(bad.status).toBe(400);
    const off = await t.call('PUT', '/settings/ai', {
      token: admin,
      body: { channels: { webchat: 'off' } },
    });
    expect(off.body.channels).toMatchObject({ webchat: 'off', email: 'draft' });
    try {
      const c = await chat('Hello?');
      expect((await conversations(c.ticketId))[0]!.controller).toBe('none');
    } finally {
      await t.call('PUT', '/settings/ai', { token: admin, body: {} });
    }
  });
});

describe('golden conversations (apps/api/test/evals)', () => {
  const goldens = parse(
    readFileSync(path.join(__dirname, 'evals/agent.yaml'), 'utf8'),
  ) as AiGolden[];

  it.each(goldens.map((g) => [g.name, g] as const))('%s', async (_name, golden) => {
    const res = await t.call('POST', '/ai/simulate', {
      token: admin,
      body: goldenToSimulation(golden),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(checkAiGolden(golden, res.body), JSON.stringify(res.body)).toEqual([]);
  });
});
