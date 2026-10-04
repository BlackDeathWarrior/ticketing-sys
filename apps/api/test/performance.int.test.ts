import {
  aiRuns,
  conversations,
  type Database,
  llmCalls,
  messages,
  slaTimers,
  tickets,
} from '@tms/db';
import type { PerformanceReport, TicketReport } from '@tms/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundService } from '../src/channels/inbound.service';
import { CsatService } from '../src/csat/csat.service';
import { DB } from '../src/infra/tokens';
import { makeTeam, makeUser, startApp, type TestClient, uniq } from './helpers';

/** The byte-order mark the CSV starts with, so spreadsheet apps read it as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/**
 * The AI-versus-team report, the ticket list and CSV behind it, and the admin
 * endpoints for teams and categories. The report is checked on one team, so
 * tickets from other test files don't change the numbers. What the AI did is
 * written straight into its tables here; the AI flows themselves are covered
 * by ai.int.test.ts and handover.int.test.ts.
 */
let t: TestClient;
let db: Database;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let lead: Awaited<ReturnType<typeof makeUser>>;
let teamId: string;
let customerId: string;
const today = new Date().toISOString().slice(0, 10);

interface Made {
  id: string;
  reference: string;
}

beforeAll(async () => {
  t = await startApp();
  db = t.app.get(DB);
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent');
  lead = await makeUser(t, admin, 'team_lead');
  teamId = await makeTeam(t, admin);
  customerId = (
    await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Rita Report', email: `${uniq('rita')}@example.com` },
    })
  ).body.id;
});

afterAll(async () => {
  await t?.close();
});

async function ticket(body: Record<string, unknown> = {}): Promise<Made> {
  const res = await t.call('POST', '/tickets', {
    token: admin,
    body: { customerId, teamId, subject: `Report ${uniq()}`, channel: 'email', ...body },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const resolve = async (id: string) =>
  expect(
    (
      await t.call('POST', `/tickets/${id}/transition`, {
        token: admin,
        body: { status: 'resolved' },
      })
    ).status,
  ).toBe(201);

/** Marks a ticket as worked on by the AI, and says who has it now. */
async function aiWorked(id: string, handling: 'ai' | 'human') {
  await db.insert(aiRuns).values({
    kind: 'turn',
    ticketId: id,
    decision: handling === 'ai' ? 'sent' : 'handover',
    promptVersion: 'test',
  });
  await db.update(tickets).set({ handling }).where(eq(tickets.id, id));
}

async function slaTimer(id: string, kind: string, outcome: 'met' | 'breached') {
  await db.delete(slaTimers).where(eq(slaTimers.ticketId, id));
  const now = new Date();
  await db.insert(slaTimers).values({
    ticketId: id,
    kind,
    state: outcome,
    targetMinutes: 60,
    startedAt: now,
    metAt: now,
    breachedAt: outcome === 'breached' ? now : null,
  });
}

const report = async (query: Record<string, string>, token = admin) =>
  t.call<PerformanceReport>('GET', '/reports/performance', { token, query });

describe('GET /reports/performance', () => {
  let byAi: Made;
  let handedOver: Made;
  let byHuman: Made;
  let stillAi: Made;

  beforeAll(async () => {
    byAi = await ticket({ channel: 'webchat' });
    handedOver = await ticket({ channel: 'webchat' });
    byHuman = await ticket({ subject: '=HYPERLINK("http://evil.example","refund")' });
    stillAi = await ticket();
    await aiWorked(byAi.id, 'ai');
    await aiWorked(handedOver.id, 'human');
    await aiWorked(stillAi.id, 'ai');
    for (const x of [byAi, handedOver, byHuman]) await resolve(x.id);

    const csat = t.app.get(CsatService);
    await csat.submit(byAi.id, { rating: 5 }, 'chat');
    await csat.submit(handedOver.id, { rating: 2, comment: 'Slow' }, 'portal');
    await slaTimer(byAi.id, 'first_response', 'met');
    await slaTimer(handedOver.id, 'resolution', 'breached');
    await db.insert(llmCalls).values([
      { role: 'chat_agent', model: 'test-model', status: 'ok', costUsd: 0.015, ticketId: byAi.id },
      { role: 'chat_agent', model: 'test-model', status: 'ok', costUsd: 0.005, ticketId: byAi.id },
    ]);
  });

  it('needs report:read', async () => {
    expect((await t.call('GET', '/reports/performance')).status).toBe(401);
    expect((await report({}, agent.token)).status).toBe(403);
    expect((await report({}, lead.token)).status).toBe(200);
  });

  it('splits the numbers between the AI and people', async () => {
    const res = await report({ teamId, days: '7' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body;
    expect(r.to).toBe(today);
    expect(r.daily).toHaveLength(7);
    expect(r.filters).toEqual({ channel: null, teamId });

    expect(r.created).toBe(4);
    expect(r.resolved).toEqual({ total: 3, ai: 1, ai_then_human: 1, human: 1 });
    expect(r.aiResolutionRate).toBeCloseTo(1 / 3);
    expect(r.aiWorked).toMatchObject({ total: 3, deflected: 1, toPerson: 1, open: 1 });
    expect(r.aiWorked.deflectionRate).toBeCloseTo(1 / 3);
    expect(r.aiWorked.handoverRate).toBeCloseTo(1 / 3);
    expect(r.daily.at(-1)).toEqual({ date: today, created: 4, resolvedAi: 1, resolvedHuman: 2 });

    // 1 ticket the AI resolved alone, at the default 10 minutes of agent work each.
    expect(r.timeSaved).toEqual({ minutes: 10, minutesPerTicket: 10 });

    expect(r.csat.all).toEqual({ responses: 2, average: 3.5, satisfied: 0.5 });
    expect(r.csat.ai).toEqual({ responses: 1, average: 5, satisfied: 1 });
    expect(r.csat.human).toEqual({ responses: 1, average: 2, satisfied: 0 });
    // Ratings of tickets people handled, by assignee; the AI's own are not listed here.
    expect(r.csat.byAgent).toEqual([
      { agent: 'No assignee', responses: 1, average: 2, satisfied: 0 },
    ]);

    expect(r.sla.firstResponse.ai).toEqual({ met: 1, breached: 0, compliance: 1 });
    expect(r.sla.resolution.human).toEqual({ met: 0, breached: 1, compliance: 0 });
    expect(r.sla.overall.all).toEqual({ met: 1, breached: 1, compliance: 0.5 });
    expect(r.sla.resolution.ai.compliance).toBeNull();

    expect(r.cost.totalUsd).toBeCloseTo(0.02);
    expect(r.cost.calls).toBe(2);
    expect(r.cost.perAiResolvedUsd).toBeCloseTo(0.02);
    expect(r.cost.byProvider).toEqual([
      { provider: 'Removed provider', usd: expect.closeTo(0.02), calls: 2 },
    ]);

    expect(r.byChannel).toEqual([
      {
        channel: 'email',
        created: 2,
        resolved: 1,
        resolvedAi: 0,
        csatAverage: null,
        csatResponses: 0,
      },
      {
        channel: 'webchat',
        created: 2,
        resolved: 2,
        resolvedAi: 1,
        csatAverage: 3.5,
        csatResponses: 2,
      },
    ]);
    expect(r.medianResolutionMinutes.ai).toBe(0);
  });

  it('filters by channel and by dates, and refuses a bad period', async () => {
    const chat = (await report({ teamId, channel: 'webchat' })).body;
    expect(chat.created).toBe(2);
    expect(chat.resolved.total).toBe(2);
    expect(chat.filters.channel).toBe('webchat');

    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const past = (await report({ teamId, from: '2026-01-01', to: yesterday })).body;
    expect(past.created).toBe(0);
    expect(past.aiResolutionRate).toBeNull();
    expect(past.from).toBe('2026-01-01');

    expect((await report({ from: '2026-02-30' })).status).toBe(400);
    expect((await report({ from: '2026-03-02', to: '2026-03-01' })).status).toBe(400);
    expect((await report({ days: '0' })).status).toBe(400);
    expect((await report({ teamId: 'nope' })).status).toBe(400);
  });

  it('uses the minutes per ticket set by an admin', async () => {
    await t.call('PUT', '/settings/customer-experience', {
      token: admin,
      body: { agentMinutesPerTicket: 25 },
    });
    expect((await report({ teamId })).body.timeSaved).toEqual({
      minutes: 25,
      minutesPerTicket: 25,
    });
    await t.call('PUT', '/settings/customer-experience', { token: admin, body: {} });
  });

  it('lists the tickets behind the report, and exports them as CSV', async () => {
    const list = await t.call<TicketReport>('GET', '/reports/tickets', {
      token: lead.token,
      query: { teamId },
    });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(4);
    const row = list.body.items.find((x) => x.reference === handedOver.reference)!;
    expect(row).toMatchObject({
      channel: 'webchat',
      status: 'Resolved',
      customer: 'Rita Report',
      handledBy: 'ai_then_human',
      rating: 2,
      resolutionMinutes: 0,
    });
    const onlyAi = await t.call<TicketReport>('GET', '/reports/tickets', {
      token: admin,
      query: { teamId, handledBy: 'ai' },
    });
    expect(onlyAi.body.items.map((x) => x.reference).sort()).toEqual(
      [byAi.reference, stillAi.reference].sort(),
    );
    const paged = await t.call<TicketReport>('GET', '/reports/tickets', {
      token: admin,
      query: { teamId, limit: '1', offset: '1' },
    });
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBe(4);

    // Agents can't export; team leads can. The file is plain CSV.
    const url = `/api/v1/reports/tickets.csv?teamId=${teamId}`;
    const refused = await t.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(refused.statusCode).toBe(403);
    const csv = await t.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${lead.token}` },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('tickets.csv');
    const lines = csv.body.replace(BOM, '').trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(
      'Ticket,Subject,Channel,Status,Priority,Team,Assignee,Customer,Handled by,Created,First response,Resolved,First response (minutes),Resolution (minutes),SLA,Rating',
    );
    expect(lines.find((l) => l.startsWith(byAi.reference))).toContain(',AI,');
    // A subject that looks like a formula is defused, and its quotes are escaped.
    expect(lines.find((l) => l.startsWith(byHuman.reference))).toContain(
      `"'=HYPERLINK(""http://evil.example"",""refund"")"`,
    );

    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'report.exported', actorId: lead.id },
    });
    expect(audit.body[0].data).toMatchObject({ teamId, rows: 4 });
  });
});

describe('tickets the AI answered', () => {
  /** A chat ticket the AI answered `hoursAgo`, now waiting for the customer. */
  async function answeredByAi(hoursAgo: number, lastWord: 'ai' | 'customer' = 'ai') {
    const sid = uniq('session');
    const first = await t.app.get(InboundService).handle({
      channel: 'webchat',
      threadKey: sid,
      channelMessageId: `${sid}:1`,
      from: { identity: { type: 'webchat_session', value: sid }, displayName: 'Quinn Quiet' },
      text: 'How long do refunds take?',
      receivedAt: new Date().toISOString(),
    });
    const at = new Date(Date.now() - hoursAgo * 3_600_000);
    // The question came first, an hour before the last word.
    await db
      .update(messages)
      .set({ createdAt: new Date(at.getTime() - 3_600_000) })
      .where(eq(messages.id, first.messageId));
    await db.insert(messages).values({
      conversationId: first.conversationId,
      channel: 'webchat',
      direction: lastWord === 'ai' ? 'outbound' : 'inbound',
      authorType: lastWord,
      body: lastWord === 'ai' ? 'Refunds take 5 to 7 working days.' : 'And for gift cards?',
      deliveryStatus: lastWord === 'ai' ? 'sent' : null,
      createdAt: at,
    });
    await db
      .update(conversations)
      .set({ controller: 'ai' })
      .where(eq(conversations.id, first.conversationId));
    await db
      .update(tickets)
      .set({ handling: 'ai', status: 'pending_customer' })
      .where(eq(tickets.id, first.ticketId));
    return first.ticketId;
  }
  const statusOf = async (id: string) =>
    (await t.call('GET', `/tickets/${id}`, { token: admin })).body.status as string;
  const run = () => t.call<{ resolved: number }>('POST', '/ai/auto-resolve', { token: admin });
  /** The quiet time for web chats, in minutes; `undefined` goes back to the channel's default. */
  const quietAfter = async (webchat: number | undefined) => {
    const current = (await t.call('GET', '/settings/ai', { token: admin })).body;
    const quietMinutes = { ...current.closing.quietMinutes, webchat };
    return t.call('PUT', '/settings/ai', {
      token: admin,
      body: { ...current, closing: { ...current.closing, quietMinutes } },
    });
  };
  afterAll(async () => {
    await quietAfter(undefined);
  });

  it('are resolved once the customer has been quiet long enough, and not before', async () => {
    expect((await quietAfter(48 * 60)).status).toBe(200);
    const quiet = await answeredByAi(80);
    const recent = await answeredByAi(10);
    const waitingForUs = await answeredByAi(80, 'customer');
    const takenOver = await answeredByAi(80);
    await db.update(tickets).set({ handling: 'human' }).where(eq(tickets.id, takenOver));

    expect((await t.call('POST', '/ai/auto-resolve', { token: agent.token })).status).toBe(403);
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBeGreaterThanOrEqual(1);
    expect(await statusOf(quiet)).toBe('resolved');
    expect(await statusOf(recent)).toBe('pending_customer');
    expect(await statusOf(waitingForUs)).toBe('pending_customer');
    expect(await statusOf(takenOver)).toBe('pending_customer');

    // The AI is on record as the one who resolved it, and why.
    const detail = (await t.call('GET', `/tickets/${quiet}`, { token: admin })).body;
    expect(detail.resolution).toMatch(/No reply from the customer for 48 hours/);
    const history = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'ticket.status_changed', targetId: quiet },
    });
    expect(history.body[0]).toMatchObject({ actorType: 'ai', data: { to: 'resolved' } });
    // Running it again changes nothing.
    expect(await statusOf(quiet)).toBe('resolved');
    expect((await run()).body.resolved).toBe(0);
  });

  it('follow the quiet time an admin sets for the channel; 0 switches it off', async () => {
    const id = await answeredByAi(10);

    expect((await quietAfter(0)).status).toBe(200);
    expect((await run()).body.resolved).toBe(0);
    expect(await statusOf(id)).toBe('pending_customer');

    // Eight hours: this ticket (quiet for ten) now qualifies, with any other that old.
    await quietAfter(8 * 60);
    expect((await run()).body.resolved).toBeGreaterThanOrEqual(1);
    expect(await statusOf(id)).toBe('resolved');
    expect((await quietAfter(-1)).status).toBe(400);
  });
});

describe('teams and categories', () => {
  it('renames a team and replaces its members', async () => {
    const id = await makeTeam(t, admin);
    const name = uniq('Renamed');
    const res = await t.call('PATCH', `/teams/${id}`, {
      token: admin,
      body: { name, description: 'Second line', memberIds: [agent.id, lead.id] },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ name, description: 'Second line' });
    expect(res.body.members.map((m: { id: string }) => m.id).sort()).toEqual(
      [agent.id, lead.id].sort(),
    );
    const fewer = await t.call('PATCH', `/teams/${id}`, { token: admin, body: { memberIds: [] } });
    expect(fewer.body.members).toEqual([]);
    expect(fewer.body.name).toBe(name);

    // Guard rails.
    expect(
      (await t.call('PATCH', `/teams/${id}`, { token: agent.token, body: { name } })).status,
    ).toBe(403);
    expect((await t.call('PATCH', `/teams/${id}`, { token: admin, body: {} })).status).toBe(400);
    const other = await makeTeam(t, admin);
    expect(
      (await t.call('PATCH', `/teams/${other}`, { token: admin, body: { name } })).status,
    ).toBe(409);
    expect(
      (
        await t.call('PATCH', `/teams/${id}`, {
          token: admin,
          body: { memberIds: ['00000000-0000-4000-8000-000000000000'] },
        })
      ).status,
    ).toBe(400);
  });

  it('deletes a team only when nothing depends on it', async () => {
    const id = await makeTeam(t, admin, uniq('Doomed'));
    const open = await ticket({ teamId: id });
    const blocked = await t.call('DELETE', `/teams/${id}`, { token: admin });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/1 open ticket\./);
    await resolve(open.id);

    const rule = await t.call('POST', '/routing/rules', {
      token: admin,
      body: { name: uniq('Rule'), teamId: id, conditions: { channel: 'voice' } },
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    const byRule = await t.call('DELETE', `/teams/${id}`, { token: admin });
    expect(byRule.status).toBe(409);
    expect(byRule.body.message).toMatch(/routing rule/);
    await t.call('DELETE', `/routing/rules/${rule.body.id}`, { token: admin });

    expect((await t.call('DELETE', `/teams/${id}`, { token: agent.token })).status).toBe(403);
    expect((await t.call('DELETE', `/teams/${id}`, { token: admin })).status).toBe(204);
    expect((await t.call('DELETE', `/teams/${id}`, { token: admin })).status).toBe(404);
    const teams = (await t.call('GET', '/teams', { token: admin })).body as Array<{ id: string }>;
    expect(teams.some((x) => x.id === id)).toBe(false);
    // The resolved ticket stays, without a team.
    expect((await t.call('GET', `/tickets/${open.id}`, { token: admin })).body.team).toBeNull();
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'team.deleted', targetId: id },
    });
    expect(audit.body).toHaveLength(1);
  });

  it('renames a category and switches it off for new requests', async () => {
    const name = uniq('Warranty');
    const cat = (await t.call('POST', '/categories', { token: admin, body: { name } })).body;
    const sibling = (
      await t.call('POST', '/categories', { token: admin, body: { name: uniq('Spares') } })
    ).body;
    const offered = async () =>
      ((await t.call('GET', '/public/request-form')).body.categories as Array<{ id: string }>).some(
        (c) => c.id === cat.id,
      );
    expect(await offered()).toBe(true);

    const renamed = await t.call('PATCH', `/categories/${cat.id}`, {
      token: admin,
      body: { name: `${name} claims` },
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe(`${name} claims`);
    expect(
      (
        await t.call('PATCH', `/categories/${sibling.id}`, {
          token: admin,
          body: { name: `${name} CLAIMS` },
        })
      ).status,
    ).toBe(409);

    const off = await t.call('PATCH', `/categories/${cat.id}`, {
      token: admin,
      body: { isActive: false },
    });
    expect(off.body.isActive).toBe(false);
    expect(await offered()).toBe(false);
    const listed = (await t.call('GET', '/categories', { token: admin })).body as Array<{
      id: string;
      isActive: boolean;
    }>;
    expect(listed.find((c) => c.id === cat.id)).toMatchObject({ isActive: false });

    expect(
      (
        await t.call('PATCH', `/categories/${cat.id}`, {
          token: agent.token,
          body: { isActive: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await t.call('PATCH', '/categories/00000000-0000-4000-8000-000000000000', {
          token: admin,
          body: { isActive: true },
        })
      ).status,
    ).toBe(404);
  });
});
