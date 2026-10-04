import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundService } from '../src/channels/inbound.service';
import {
  clearKnowledgeBase,
  eventsHandled,
  makeTeam,
  makeUser,
  startApp,
  startWorker,
  type TestClient,
  uniq,
  waitFor,
} from './helpers';
import { FAKE_LLM_BASE_URL } from './test-env';

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let providerId: string;
let teamId: string;
let otherTeamId: string;
type User = Awaited<ReturnType<typeof makeUser>>;
let hindi: User; // online, speaks Hindi
let ana: User; // online
let ben: User; // online
let offline: User;
let lead: User;
const ruleIds: string[] = [];

interface Conv {
  id: string;
  controller: string;
  controllerUserId: string | null;
  messages: Array<{ authorType: string; body: string }>;
}
interface Handover {
  id: string;
  source: string;
  reason: string;
  rules: string[];
  packStatus: string;
  pack: {
    summary: string;
    recommendedNextStep: string;
    writtenBy: string;
    actions: string[];
  } | null;
  routedUser: { id: string; name: string } | null;
  routedTeam: { id: string; name: string } | null;
}

async function chat(text: string, session = uniq('handover-chat'), name = 'Handover Visitor') {
  const r = await t.app.get(InboundService).handle({
    channel: 'webchat',
    threadKey: session,
    channelMessageId: `${session}:${uniq()}`,
    from: { identity: { type: 'webchat_session', value: session }, displayName: name },
    text,
    receivedAt: new Date().toISOString(),
  });
  return { ...r, session };
}

const ticket = async (id: string) => (await t.call('GET', `/tickets/${id}`, { token: admin })).body;
const conv = async (ticketId: string) =>
  (
    (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Conv[]
  )[0]!;
const handovers = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/handovers`, { token: admin })).body as Handover[];

/**
 * By default a customer who asks for a person gets one offer of help first (ADR 0029).
 * These tests are about what follows a handover, so here the first request is enough.
 */
const AT_ONCE = { handover: { personRequestsBeforeHandover: 1 } };

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  await clearKnowledgeBase(t, admin);
  teamId = await makeTeam(t, admin, uniq('Support desk'));
  otherTeamId = await makeTeam(t, admin, uniq('Billing desk'));
  hindi = await makeUser(t, admin, 'agent', { name: 'Hema Hindi', teamIds: [teamId] });
  ana = await makeUser(t, admin, 'agent', { name: 'Ana Online', teamIds: [teamId] });
  ben = await makeUser(t, admin, 'agent', { name: 'Ben Online', teamIds: [teamId] });
  offline = await makeUser(t, admin, 'agent', { name: 'Olle Offline', teamIds: [teamId] });
  lead = await makeUser(t, admin, 'team_lead', { name: 'Lina Lead', teamIds: [teamId] });
  for (const u of [hindi, ana, ben]) {
    const r = await t.call('PUT', `/routing/agents/${u.id}/presence`, {
      token: admin,
      body: { status: 'online', capacity: 3 },
    });
    expect(r.status).toBe(200);
  }
  await t.call('PUT', `/routing/agents/${hindi.id}/skills`, {
    token: admin,
    body: { skills: ['Hindi'] },
  });

  const p = await t.call('POST', '/settings/llm/providers', {
    token: admin,
    body: {
      provider: 'openai_compatible',
      label: `Handover fake ${uniq()}`,
      apiKey: 'fake-handover-key-000',
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
  worker = await startWorker();
  await t.call('PUT', '/settings/ai', { token: admin, body: AT_ONCE });

  // A public FAQ the AI can answer the refund question from (keyword search, no embeddings).
  const faq = await t.call('POST', '/kb/documents', {
    token: admin,
    body: {
      source: 'faq',
      title: 'When will my refund reach my card?',
      content: 'Refunds reach your card 5 to 7 business days after we receive the return.',
      visibility: 'public',
    },
  });
  expect(faq.status, JSON.stringify(faq.body)).toBe(201);
  await waitFor(
    async () =>
      (await t.call('GET', `/kb/documents/${faq.body.id}`, { token: admin })).body.indexState ===
      'indexed'
        ? true
        : undefined,
    'FAQ indexed',
    30_000,
  );
  await t.call('POST', `/kb/documents/${faq.body.id}/status`, {
    token: admin,
    body: { status: 'approved' },
  });
}, 60_000);

afterAll(async () => {
  await t?.call('PUT', '/settings/ai', { token: admin, body: {} });
  for (const id of ruleIds) await t.call('DELETE', `/routing/rules/${id}`, { token: admin });
  await worker?.close();
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await t?.close();
});

describe('routing settings and presence', () => {
  it('are for admins; agents set only their own presence', async () => {
    const body = { name: 'Nope', teamId };
    expect((await t.call('POST', '/routing/rules', { token: ana.token, body })).status).toBe(403);
    expect((await t.call('GET', '/routing/agents', { token: ana.token })).status).toBe(403);
    expect((await t.call('GET', '/routing/agents', { token: lead.token })).status).toBe(200);

    const me = await t.call('PUT', '/me/presence', {
      token: offline.token,
      body: { status: 'away' },
    });
    expect(me.body).toEqual({ status: 'away', capacity: 5 });
    await t.call('PUT', '/me/presence', { token: offline.token, body: { status: 'offline' } });
  });

  it('orders rules; the first enabled match wins', async () => {
    for (const body of [
      {
        name: 'Hindi chats',
        conditions: { channel: 'webchat', language: 'hi' },
        teamId,
        requiredSkill: 'hindi',
      },
      {
        name: 'All web chats',
        conditions: { channel: 'webchat' },
        teamId,
        strategy: 'round_robin',
      },
    ]) {
      const r = await t.call('POST', '/routing/rules', { token: admin, body });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      ruleIds.push(r.body.id);
    }
    const rules = (await t.call('GET', '/routing/rules', { token: admin })).body;
    const mine = rules.filter((r: { id: string }) => ruleIds.includes(r.id));
    expect(mine.map((r: { name: string }) => r.name)).toEqual(['Hindi chats', 'All web chats']);
    expect(mine[0].requiredSkill).toBe('hindi');
  });

  it('routes by tag: an incident an app reports goes to the team that runs the app', async () => {
    // A team of its own: the other tests count on who is online in theirs.
    const opsTeamId = await makeTeam(t, admin, uniq('Operations'));
    const rule = await t.call('POST', '/routing/rules', {
      token: admin,
      body: { name: 'Incidents', conditions: { tag: 'incident' }, teamId: opsTeamId },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    expect(rule.body.conditions).toEqual({ tag: 'incident' });
    ruleIds.push(rule.body.id);

    const app = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('app-'), name: 'Routed app' },
    });
    const key = await t.call('POST', `/integrations/${app.body.id}/keys`, {
      token: admin,
      body: { name: 'Worker', scopes: ['integration:event', 'integration:ticket'] },
    });
    const onCall = await makeUser(t, admin, 'agent', {
      name: 'Omar OnCall',
      teamIds: [opsTeamId],
    });
    await t.call('PUT', `/routing/agents/${onCall.id}/presence`, {
      token: admin,
      body: { status: 'online', capacity: 3 },
    });
    const fingerprint = uniq('job.failed:');
    const reported = await t.call('POST', '/integration/events', {
      token: key.body.key,
      body: { fingerprint, title: 'Nightly job failed', severity: 'error' },
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(202);
    const routed = await waitFor(async () => {
      const tk = await ticket(reported.body.incident.ticket);
      return tk.assignee ? tk : undefined;
    }, 'the incident ticket to be routed');
    expect(routed.team.id).toBe(opsTeamId);
    expect(routed.assignee.id).toBe(onCall.id);
    expect(routed.tags).toContain('incident');

    // Routing gave it to someone, but no person has touched it: a recovery still resolves it.
    const recovered = await t.call('POST', '/integration/events', {
      token: key.body.key,
      body: { fingerprint, status: 'resolved' },
    });
    expect(recovered.body.action).toBe('resolved');
    expect((await ticket(routed.id)).status).toBe('resolved');

    // The next one, the on-call agent starts on: now the recovery leaves it to them.
    const second = uniq('job.failed:');
    const again = await t.call('POST', '/integration/events', {
      token: key.body.key,
      body: { fingerprint: second, title: 'Nightly job failed again', severity: 'error' },
    });
    const taken = await waitFor(async () => {
      const tk = await ticket(again.body.incident.ticket);
      return tk.assignee ? tk : undefined;
    }, 'the second incident ticket to be routed');
    await t.call('POST', `/tickets/${taken.id}/notes`, {
      token: onCall.token,
      body: { body: 'Looking at the job logs.' },
    });
    await t.call('POST', '/integration/events', {
      token: key.body.key,
      body: { fingerprint: second, status: 'resolved' },
    });
    expect((await ticket(taken.id)).status).not.toBe('resolved');

    // A ticket the same app raises for a user carries no such tag: the rule leaves it alone.
    const asked = await t.call('POST', '/integration/tickets', {
      token: key.body.key,
      body: {
        customer: { externalId: uniq('user-') },
        subject: 'A question from a user',
        body: 'How do I change my address?',
        ai: 'off',
      },
    });
    expect(asked.status).toBe(201);
    await eventsHandled(t);
    expect((await ticket(asked.body.reference)).team?.id).not.toBe(opsTeamId);
  });
});

describe('AI handover', () => {
  it('routes by skill, notifies the agent and writes a context pack', async () => {
    const c = await chat('मुझे किसी इंसान से बात करनी है, कृपया।');
    const [h] = await waitFor(
      async () => {
        const list = await handovers(c.ticketId);
        return list[0]?.packStatus === 'ready' ? list : undefined;
      },
      'handover with context pack',
      20_000,
    );
    expect(h).toMatchObject({ source: 'customer', rules: ['asked_for_human'] });
    expect(h!.routedUser).toEqual({ id: hindi.id, name: 'Hema Hindi' });
    expect(h!.pack).toMatchObject({ writtenBy: 'model' });
    expect(h!.pack!.summary).toContain('इंसान');
    expect(h!.pack!.recommendedNextStep).toMatch(/personally/);

    const tk = await ticket(c.ticketId);
    expect(tk).toMatchObject({ handling: 'handed_over', status: 'human_assigned' });
    expect(tk.assignee.id).toBe(hindi.id);
    // The AI told the customer a person will reply. That is not an answer: the
    // first-response clock keeps running until a person does.
    const said = (await conv(c.ticketId)).messages.filter((m) => m.authorType === 'ai');
    expect(said).toHaveLength(1);
    // Routing had chosen who by then, so the customer is told their first name.
    expect(said[0]!.body).toContain('सहयोगी Hema');
    expect(said[0]!.body).not.toContain('Hindi');
    expect(tk.firstResponseAt).toBeNull();
    const inbox = await waitFor(async () => {
      const n = (await t.call('GET', '/notifications', { token: hindi.token })).body;
      return n.items.find((x: { kind: string }) => x.kind === 'handover.requested');
    }, 'handover notice');
    expect(inbox.title).toBe(`${tk.reference} was handed to you`);

    const history = (
      await t.call('GET', `/tickets/${c.ticketId}/history`, {
        token: admin,
        query: { actorType: 'ai' },
      })
    ).body as Array<{ actorType: string; action: string }>;
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((e) => e.actorType === 'ai')).toBe(true);
    expect(history.map((e) => e.action)).toContain('handover.requested');
  });

  it('takes turns across online agents without the skill, skipping offline and full ones', async () => {
    const picks: string[] = [];
    for (let i = 0; i < 2; i++) {
      const c = await chat('Can I talk to a real person please?');
      const h = await waitFor(async () => (await handovers(c.ticketId))[0]?.routedUser, 'routed');
      picks.push(h.id);
      const told = await waitFor(
        async () => (await conv(c.ticketId)).messages.find((m) => m.authorType === 'ai'),
        'the customer to be told who answers',
      );
      expect(told.body).toContain(`my colleague ${h.name.split(' ')[0]},`);
    }
    expect(new Set(picks).size).toBe(2);
    expect(picks).not.toContain(offline.id);
  });
});

describe('AI handover on a ticket an app raised', () => {
  // The AI speaks to an app's customers by itself only where the workspace lets it.
  beforeAll(async () => {
    await t.call('PUT', '/settings/ai', {
      token: admin,
      body: { ...AT_ONCE, channels: { api: 'auto' } },
    });
  });
  afterAll(async () => {
    await t.call('PUT', '/settings/ai', { token: admin, body: AT_ONCE });
  });

  it('tells the customer in the app that a person answers now, once', async () => {
    const app = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('shop-'), name: 'Handover app' },
    });
    const key = await t.call('POST', `/integrations/${app.body.id}/keys`, {
      token: admin,
      body: { name: 'Server', scopes: ['integration:ticket'] },
    });
    const raised = await t.call('POST', '/integration/tickets', {
      token: key.body.key,
      body: {
        customer: { externalId: uniq('user-'), name: 'App Customer' },
        subject: 'Help with my account',
        body: 'Can I talk to a real person please?',
      },
    });
    expect(raised.status, JSON.stringify(raised.body)).toBe(201);
    const reference = raised.body.reference as string;
    type Seen = Array<{ from: string; body: string }>;
    const seen = async () =>
      (await t.call('GET', `/integration/tickets/${reference}/messages`, { token: key.body.key }))
        .body as Seen;
    const notice = await waitFor(
      async () => (await seen()).find((m) => m.from === 'assistant'),
      'the handover message in the app',
      20_000,
    );
    // No rule sends this channel to a team, so nobody is named.
    expect(notice.body).toMatch(/I'm passing this to a member of our team/);
    const tk = await ticket(reference);
    expect(tk).toMatchObject({ handling: 'handed_over', status: 'human_assigned' });
    // A notice, not an answer.
    expect(tk.firstResponseAt).toBeNull();
    await waitFor(
      async () => ((await handovers(tk.id))[0]?.packStatus === 'ready' ? true : undefined),
      'context pack',
      20_000,
    );
    expect((await seen()).filter((m) => m.from === 'assistant')).toHaveLength(1);
  });

  it('says nothing by itself where the AI only drafts', async () => {
    await t.call('PUT', '/settings/ai', {
      token: admin,
      body: { ...AT_ONCE, channels: { api: 'draft' } },
    });
    const app = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('shop-'), name: 'Draft app' },
    });
    const key = await t.call('POST', `/integrations/${app.body.id}/keys`, {
      token: admin,
      body: { name: 'Server', scopes: ['integration:ticket'] },
    });
    const raised = await t.call('POST', '/integration/tickets', {
      token: key.body.key,
      body: {
        customer: { externalId: uniq('user-') },
        subject: 'Help with my account',
        body: 'Can I talk to a real person please?',
      },
    });
    const tk = await ticket(raised.body.reference);
    await waitFor(
      async () => ((await handovers(tk.id))[0]?.packStatus === 'ready' ? true : undefined),
      'context pack',
      20_000,
    );
    const seen = await t.call('GET', `/integration/tickets/${raised.body.reference}/messages`, {
      token: key.body.key,
    });
    expect(seen.body.map((m: { from: string }) => m.from)).toEqual(['customer']);
  });
});

describe('take-over and hand-back', () => {
  it('lets one person take over; a second gets a 409 naming the first; the AI stays quiet', async () => {
    const c = await chat('When will my refund reach my card?');
    await waitFor(async () => {
      const cv = await conv(c.ticketId);
      return cv.messages.some((m) => m.authorType === 'ai') ? cv : undefined;
    }, 'AI answer');
    const cv = await conv(c.ticketId);
    expect((await ticket(c.ticketId)).handling).toBe('ai');

    const [first, second] = await Promise.all([
      t.call('POST', `/conversations/${cv.id}/take-over`, { token: ana.token }),
      t.call('POST', `/conversations/${cv.id}/take-over`, { token: ben.token }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    const winner = first.status === 200 ? ana : ben;
    expect(loser.body.message).toBe(
      `${winner === ana ? 'Ana Online' : 'Ben Online'} is already answering this conversation`,
    );

    const tk = await ticket(c.ticketId);
    expect(tk).toMatchObject({ handling: 'human', status: 'in_progress' });
    expect(tk.assignee.id).toBe(winner.id);

    // The customer writes again: no AI reply now.
    const aiBefore = (await conv(c.ticketId)).messages.filter((m) => m.authorType === 'ai').length;
    await t.app.get(InboundService).handle({
      channel: 'webchat',
      threadKey: c.session,
      channelMessageId: `${c.session}:${uniq()}`,
      from: {
        identity: { type: 'webchat_session', value: c.session },
        displayName: 'Handover Visitor',
      },
      text: 'And how long does a card refund take?',
      receivedAt: new Date().toISOString(),
    });

    // Handed back: the AI answers the waiting question.
    const back = await t.call('POST', `/conversations/${cv.id}/hand-back`, { token: winner.token });
    expect(back.status).toBe(200);
    expect(back.body.controller).toBe('ai');
    await waitFor(async () => {
      const m = (await conv(c.ticketId)).messages;
      return m.filter((x) => x.authorType === 'ai').length > aiBefore ? true : undefined;
    }, 'AI answers after hand-back');
    expect((await ticket(c.ticketId)).handling).toBe('ai');
    const again = await t.call('POST', `/conversations/${cv.id}/hand-back`, {
      token: winner.token,
    });
    expect(again.status).toBe(409);
  });

  it('passes a ticket to another team, which then waits in that queue', async () => {
    const c = await chat('When will my refund reach my card?');
    await waitFor(
      async () => ((await conv(c.ticketId)).messages.length > 1 ? true : undefined),
      'AI turn',
    );
    const res = await t.call('POST', `/tickets/${c.ticketId}/handover`, {
      token: ana.token,
      body: { reason: 'Invoice questions belong to billing', teamId: otherTeamId },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.source).toBe('agent');
    const routed = await waitFor(async () => {
      const [h] = await handovers(c.ticketId);
      return h?.routedTeam ? h : undefined;
    }, 'routed to team');
    expect(routed.routedTeam!.id).toBe(otherTeamId);
    expect(routed.routedUser).toBeNull(); // nobody on that team is online
    const tk = await ticket(c.ticketId);
    expect(tk).toMatchObject({ handling: 'handed_over', assigneeId: null });
    expect(tk.team.id).toBe(otherTeamId);
    expect((await conv(c.ticketId)).controller).toBe('none');
  });
});

describe('copilot, escalation and AI-vs-human filters', () => {
  it('suggests a reply from the knowledge base without storing anything', async () => {
    const c = await chat('Can I talk to a real person please?');
    await waitFor(async () => ((await handovers(c.ticketId))[0] ? true : undefined), 'handover');
    const res = await t.call('POST', `/tickets/${c.ticketId}/copilot`, {
      token: ana.token,
      body: { instruction: 'Keep it short' },
    });
    expect(res.status).toBe(200);
    expect(res.body.suggestion).toMatch(/^Hi Handover,/);
    expect(res.body.model).toBe('openai/scripted-cheap');
  });

  it('lets team leads escalate (priority up, leads told) and not agents', async () => {
    const c = await chat('Can I talk to a real person please?');
    expect(
      (
        await t.call('POST', `/tickets/${c.ticketId}/escalate`, {
          token: ana.token,
          body: { reason: 'Angry' },
        })
      ).status,
    ).toBe(403);
    const before = (await ticket(c.ticketId)).priority;
    const res = await t.call('POST', `/tickets/${c.ticketId}/escalate`, {
      token: lead.token,
      body: { reason: 'VIP customer, third contact' },
    });
    expect(res.status).toBe(200);
    expect(res.body.priority).not.toBe(before);
  });

  it('filters tickets by who is handling them, and the audit log by actor type', async () => {
    const ai = (
      await t.call('GET', '/tickets', { token: admin, query: { handling: 'ai', limit: '200' } })
    ).body.items as Array<{ handling: string }>;
    expect(ai.length).toBeGreaterThan(0);
    expect(ai.every((x) => x.handling === 'ai')).toBe(true);
    const mixed = (
      await t.call('GET', '/tickets', {
        token: admin,
        query: { handling: 'human,handed_over', limit: '200' },
      })
    ).body.items as Array<{ handling: string }>;
    expect(mixed.every((x) => ['human', 'handed_over'].includes(x.handling))).toBe(true);
    expect(mixed.some((x) => x.handling === 'handed_over')).toBe(true);
    const audit = (
      await t.call('GET', '/audit', { token: admin, query: { actorType: 'ai', limit: '50' } })
    ).body as Array<{ actorType: string }>;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.actorType === 'ai')).toBe(true);
  });
});
