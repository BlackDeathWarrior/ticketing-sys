import type { INestApplicationContext } from '@nestjs/common';
import { type Database, slaTimers } from '@tms/db';
import { eq } from 'drizzle-orm';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundService } from '../src/channels/inbound.service';
import { DB } from '../src/infra/tokens';
import { SlaService } from '../src/sla/sla.service';
import {
  makeTeam,
  makeUser,
  startApp,
  startWorker,
  type TestClient,
  uniq,
  waitFor,
} from './helpers';
import { applyEmailEnv, TEST_MAIL } from './test-env';

applyEmailEnv();

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let teamId: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let lead: Awaited<ReturnType<typeof makeUser>>;
const policyIds: string[] = [];

interface Timer {
  kind: string;
  state: string;
  dueAt: string | null;
  atRisk: boolean;
  targetMinutes: number;
}
interface Sla {
  policy: { name: string } | null;
  state: string | null;
  dueAt: string | null;
  timers: Timer[];
}

const sla = async (id: string) =>
  (await t.call<Sla>('GET', `/tickets/${id}/sla`, { token: admin })).body;
const timer = (s: Sla, kind: string) => s.timers.find((x) => x.kind === kind)!;

/** A customer chat through the channel pipeline: a customer-created ticket with a conversation. */
async function chat(text: string, session = uniq('sla-chat')) {
  const r = await t.app.get(InboundService).handle({
    channel: 'webchat',
    threadKey: session,
    channelMessageId: `${session}:${uniq()}`,
    from: { identity: { type: 'webchat_session', value: session }, displayName: 'SLA Visitor' },
    text,
    receivedAt: new Date().toISOString(),
  });
  return { ...r, session };
}

async function mailbox(address: string) {
  const client = new ImapFlow({
    host: TEST_MAIL.host,
    port: TEST_MAIL.imapPort,
    secure: false,
    auth: { user: address, pass: 'x' },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const out = [];
    for await (const msg of client.fetch('1:*', { source: true })) {
      if (msg.source) out.push(await simpleParser(msg.source));
    }
    return out;
  } catch {
    return [];
  } finally {
    await client.logout();
  }
}

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  teamId = await makeTeam(t, admin);
  agent = await makeUser(t, admin, 'agent', { name: 'Sla Agent', teamIds: [teamId] });
  lead = await makeUser(t, admin, 'team_lead', { name: 'Sla Lead', teamIds: [teamId] });
  worker = await startWorker();
}, 60_000);

afterAll(async () => {
  // Leave no policies behind for later test files.
  for (const id of policyIds) await t.call('DELETE', `/sla/policies/${id}`, { token: admin });
  await worker?.close();
  await t?.close();
});

describe('SLA settings', () => {
  it('are admin-only and validated', async () => {
    const body = { name: 'Nope', firstResponseMinutes: 10, resolutionMinutes: 60 };
    expect((await t.call('POST', '/sla/policies', { token: agent.token, body })).status).toBe(403);
    const badZone = await t.call('POST', '/sla/business-hours', {
      token: admin,
      body: { name: 'Mars', timezone: 'Mars/Olympus', schedule: [] },
    });
    expect(badZone.status).toBe(400);
    const badWindow = await t.call('POST', '/sla/business-hours', {
      token: admin,
      body: {
        name: 'Backwards',
        timezone: 'Asia/Kolkata',
        schedule: [{ day: 1, start: '18:00', end: '09:00' }],
      },
    });
    expect(badWindow.status).toBe(400);
  });

  it('creates business hours and policies, and refuses to delete hours in use', async () => {
    const hours = await t.call('POST', '/sla/business-hours', {
      token: admin,
      body: {
        name: uniq('Support hours'),
        timezone: 'Asia/Kolkata',
        schedule: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '18:00' })),
        holidays: [{ date: '2026-10-02', name: 'Gandhi Jayanti' }],
      },
    });
    expect(hours.status).toBe(201);
    expect(hours.body.holidays).toEqual([{ date: '2026-10-02', name: 'Gandhi Jayanti' }]);

    const normal = await t.call('POST', '/sla/policies', {
      token: admin,
      body: { name: 'Test normal', firstResponseMinutes: 60, resolutionMinutes: 240 },
    });
    const urgent = await t.call('POST', '/sla/policies', {
      token: admin,
      body: {
        name: 'Test urgent',
        priority: 'urgent',
        firstResponseMinutes: 15,
        resolutionMinutes: 120,
      },
    });
    const vipOffice = await t.call('POST', '/sla/policies', {
      token: admin,
      body: {
        name: 'Test VIP office hours',
        customerType: 'vip_test',
        firstResponseMinutes: 30,
        resolutionMinutes: 480,
        businessHoursId: hours.body.id,
      },
    });
    for (const p of [normal, urgent, vipOffice]) {
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      policyIds.push(p.body.id);
    }
    expect(vipOffice.body.businessHours).toMatchObject({ timezone: 'Asia/Kolkata' });
    const del = await t.call('DELETE', `/sla/business-hours/${hours.body.id}`, { token: admin });
    expect(del.status).toBe(409);
  });
});

describe('SLA timers', () => {
  it('start with the ticket, meet the first response, pause while pending and resume', async () => {
    const c = await chat('My order is late, can you check?');
    const started = await waitFor(async () => {
      const s = await sla(c.ticketId);
      return s.timers.length === 2 ? s : undefined;
    }, 'SLA timers');
    expect(started.policy?.name).toBe('Test normal');
    expect(started.state).toBe('ok');
    const created = new Date(
      (await t.call('GET', `/tickets/${c.ticketId}`, { token: admin })).body.createdAt,
    );
    expect(new Date(timer(started, 'first_response').dueAt!).getTime() - created.getTime()).toBe(
      60 * 60_000,
    );

    // A person answers: the first response is met; resolution keeps running.
    const [conv] = (await t.call('GET', `/tickets/${c.ticketId}/conversations`, { token: admin }))
      .body;
    await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'Looking into it now.' },
    });
    const answered = await waitFor(async () => {
      const s = await sla(c.ticketId);
      return timer(s, 'first_response').state === 'met' ? s : undefined;
    }, 'first response met');
    expect(timer(answered, 'resolution').state).toBe('running');

    // Waiting on the customer pauses the resolution clock.
    await t.call('POST', `/tickets/${c.ticketId}/transition`, {
      token: agent.token,
      body: { status: 'pending_customer' },
    });
    const paused = await waitFor(async () => {
      const s = await sla(c.ticketId);
      return timer(s, 'resolution').state === 'paused' ? s : undefined;
    }, 'resolution paused');
    expect(paused.state).toBe('paused');
    expect(timer(paused, 'resolution').dueAt).toBeNull();

    // The customer writes again: the clock resumes with a fresh due time.
    await t.app.get(InboundService).handle({
      channel: 'webchat',
      threadKey: c.session,
      channelMessageId: `${c.session}:${uniq()}`,
      from: { identity: { type: 'webchat_session', value: c.session }, displayName: 'SLA Visitor' },
      text: 'Any news?',
      receivedAt: new Date().toISOString(),
    });
    const resumed = await waitFor(async () => {
      const s = await sla(c.ticketId);
      return timer(s, 'resolution').state === 'running' ? s : undefined;
    }, 'resolution resumed');
    expect(resumed.state).toBe('ok');
    expect(new Date(resumed.dueAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('uses the most specific policy and follows a priority change', async () => {
    const c = await chat('Please help');
    await waitFor(
      async () => ((await sla(c.ticketId)).timers.length === 2 ? true : undefined),
      'timers',
    );
    await t.call('PATCH', `/tickets/${c.ticketId}`, { token: admin, body: { priority: 'urgent' } });
    const s = await waitFor(async () => {
      const v = await sla(c.ticketId);
      return v.policy?.name === 'Test urgent' ? v : undefined;
    }, 'urgent policy');
    expect(timer(s, 'first_response').targetMinutes).toBe(15);
  });

  it('warns at 80%, then breaches, and tells the assignee and team lead (breach by email)', async () => {
    const c = await chat('This is taking too long');
    await waitFor(
      async () => ((await sla(c.ticketId)).timers.length === 2 ? true : undefined),
      'timers',
    );
    await t.call('POST', `/tickets/${c.ticketId}/assign`, {
      token: admin,
      body: { assigneeId: agent.id, teamId },
    });

    // Move the first-response deadline into the recent past: 80% gone, then all of it.
    const db = t.app.get<Database>(DB);
    const svc = worker.get(SlaService, { strict: false });
    const [row] = await db.select().from(slaTimers).where(eq(slaTimers.ticketId, c.ticketId));
    const fr = (await db.select().from(slaTimers).where(eq(slaTimers.ticketId, c.ticketId))).find(
      (x) => x.kind === 'first_response',
    )!;
    expect(row).toBeDefined();
    await db
      .update(slaTimers)
      .set({ atRiskAt: new Date(Date.now() - 1000), dueAt: new Date(Date.now() + 10 * 60_000) })
      .where(eq(slaTimers.id, fr.id));
    expect((await svc.sweep()).atRisk).toBeGreaterThanOrEqual(1);
    expect((await sla(c.ticketId)).state).toBe('at_risk');

    const atRisk = await t.call('GET', '/tickets', {
      token: admin,
      query: { sla: 'at_risk', limit: '200' },
    });
    expect(atRisk.body.items.map((x: { id: string }) => x.id)).toContain(c.ticketId);

    await db
      .update(slaTimers)
      .set({ dueAt: new Date(Date.now() - 1000) })
      .where(eq(slaTimers.id, fr.id));
    expect((await svc.sweep()).breached).toBeGreaterThanOrEqual(1);
    // A second sweep finds nothing new.
    const again = await svc.sweep();
    expect(again.breached).toBe(0);
    const breached = await sla(c.ticketId);
    expect(breached.state).toBe('breached');
    expect(timer(breached, 'first_response').state).toBe('breached');

    const ref = `TMS-${(await t.call('GET', `/tickets/${c.ticketId}`, { token: admin })).body.number}`;
    for (const who of [agent, lead]) {
      const inbox = await waitFor(async () => {
        const n = (await t.call('GET', '/notifications', { token: who.token })).body;
        return n.items.some(
          (x: { kind: string; title: string }) =>
            x.kind === 'sla.breached' && x.title.startsWith(ref),
        )
          ? n
          : undefined;
      }, `breach notice for ${who.email}`);
      expect(inbox.items.find((x: { kind: string }) => x.kind === 'sla.at_risk')).toBeDefined();
      expect(inbox.unread).toBeGreaterThanOrEqual(2);
    }
    const mail = await waitFor(async () => {
      const m = await mailbox(lead.email);
      return m.find((x) => x.subject?.startsWith(`${ref} missed`));
    }, 'breach email');
    expect(mail.subject).toBe(`${ref} missed its first response target`);

    // Reading clears the count.
    await t.call('POST', '/notifications/read-all', { token: lead.token });
    expect((await t.call('GET', '/notifications', { token: lead.token })).body.unread).toBe(0);
  });
});
