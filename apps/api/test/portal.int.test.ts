import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type {
  ChatRatingPrompt,
  CsatPrompt,
  PortalSession,
  PortalTicketDetail,
  PortalTicketSummary,
} from '@tms/shared';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  eventsHandled,
  makeUser,
  startApp,
  startWorker,
  type TestClient,
  uniq,
  waitFor,
} from './helpers';
import { applyEmailEnv, TEST_MAIL } from './test-env';

applyEmailEnv();

/**
 * The customer portal and ratings, through the real routes, the worker and
 * the mail server: sign-in links arrive by email, a session only reaches its
 * own customer's tickets, replies join the ticket, and ratings come from
 * customers only.
 */
let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await startApp({ listen: true });
  worker = await startWorker();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Paula Portal' });
});

afterAll(async () => {
  while (sockets.length) sockets.pop()!.disconnect();
  await t?.call('PUT', '/settings/customer-experience', { token: admin, body: {} });
  await worker?.close();
  await t?.close();
});

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

/** A customer who wrote in through the request form; returns their ticket. */
async function customerWithTicket(email = `${uniq('nora')}@example.org`, name = 'Nora Quist') {
  const subject = `${uniq('Kettle')} stopped heating`;
  const res = await t.call('POST', '/public/requests', {
    body: {
      submissionId: randomUUID(),
      name,
      email,
      subject,
      description: 'The kettle I bought last month no longer heats water.',
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const ticket = (await t.call('GET', `/tickets/${res.body.reference}`, { token: admin })).body;
  return { email, subject, reference: res.body.reference as string, id: ticket.id as string };
}

/** Asks for a sign-in link and reads the token out of the email. */
async function linkToken(email: string, nth = 1): Promise<string> {
  const res = await t.call('POST', '/public/portal/sign-in', { body: { email } });
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  expect(res.body).toEqual({ ok: true });
  const mail = await waitFor(async () => {
    const links = (await mailbox(email)).filter((m) => m.subject?.startsWith('Your sign-in link'));
    return links.length >= nth ? links.at(-1) : undefined;
  }, 'the sign-in email');
  const token = /#\/portal\/verify\/(\S+)/.exec(mail.text ?? '')?.[1];
  expect(token, mail.text).toBeTruthy();
  return token!;
}

async function signIn(email: string): Promise<string> {
  const res = await t.call<PortalSession>('POST', '/public/portal/session', {
    body: { token: await linkToken(email) },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token;
}

const resolve = (id: string) =>
  t.call('POST', `/tickets/${id}/transition`, { token: admin, body: { status: 'resolved' } });

const audit = async (action: string, targetId: string) =>
  (await t.call('GET', '/audit', { token: admin, query: { action, targetId, limit: '20' } }))
    .body as Array<{ actorType: string; actorId: string | null; data: Record<string, unknown> }>;

describe('portal sign-in', () => {
  it('emails a one-time link; the answer is the same for an unknown address', async () => {
    const c = await customerWithTicket();
    const stranger = `${uniq('nobody')}@example.org`;
    const unknown = await t.call('POST', '/public/portal/sign-in', { body: { email: stranger } });
    expect(unknown.status).toBe(202);
    expect(unknown.body).toEqual({ ok: true });

    const token = await linkToken(c.email);
    const session = await t.call<PortalSession>('POST', '/public/portal/session', {
      body: { token },
    });
    expect(session.status).toBe(200);
    expect(session.body.customer).toEqual({ name: 'Nora Quist', email: c.email });
    expect(session.body.expiresIn).toBe(3600);

    // The link works once, and a changed token is refused.
    expect((await t.call('POST', '/public/portal/session', { body: { token } })).status).toBe(401);
    const forged = `${token.slice(0, -4)}AAAA`;
    expect(
      (await t.call('POST', '/public/portal/session', { body: { token: forged } })).status,
    ).toBe(401);

    // Nothing was sent to the address we don't know.
    expect(await mailbox(stranger)).toHaveLength(0);
    const customer = (await t.call('GET', `/tickets/${c.id}`, { token: admin })).body.customer;
    expect((await audit('portal.signed_in', customer.id))[0]).toMatchObject({
      actorType: 'customer',
      actorId: customer.id,
    });
    expect((await audit('portal.link_requested', customer.id)).length).toBeGreaterThan(0);
  });

  it('keeps staff and customer sessions apart', async () => {
    const c = await customerWithTicket();
    const session = await signIn(c.email);
    expect((await t.call('GET', '/portal/tickets')).status).toBe(401);
    expect((await t.call('GET', '/portal/tickets', { token: admin })).status).toBe(401);
    expect((await t.call('GET', '/portal/tickets', { token: agent.token })).status).toBe(401);
    expect((await t.call('GET', '/tickets', { token: session })).status).toBe(401);
    expect((await t.call('GET', '/portal/me', { token: session })).body).toEqual({
      name: 'Nora Quist',
      email: c.email,
    });
  });

  it('limits how many links one address can ask for', async () => {
    const email = `${uniq('eager')}@example.org`;
    for (let i = 0; i < 5; i++) {
      expect((await t.call('POST', '/public/portal/sign-in', { body: { email } })).status).toBe(
        202,
      );
    }
    const sixth = await t.call('POST', '/public/portal/sign-in', { body: { email } });
    expect(sixth.status).toBe(429);
    expect(sixth.body.message).toMatch(/15 minutes/);
    expect(
      (await t.call('POST', '/public/portal/sign-in', { body: { email: 'not-an-email' } })).status,
    ).toBe(400);
  });
});

describe('my requests', () => {
  it('shows a customer their own tickets and nobody else’s', async () => {
    const mine = await customerWithTicket();
    const other = await customerWithTicket(undefined, 'Otto Other');
    const session = await signIn(mine.email);

    // An agent answers and leaves an internal note; a second ticket comes in by another channel.
    const conv = (await t.call('GET', `/tickets/${mine.id}/conversations`, { token: admin }))
      .body[0];
    await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'Sorry about that. Is the base plugged in and switched on?' },
    });
    await t.call('POST', `/tickets/${mine.id}/notes`, {
      token: agent.token,
      body: { body: 'INTERNAL: probably the thermal fuse, offer a replacement.' },
    });
    const customer = (await t.call('GET', `/tickets/${mine.id}`, { token: admin })).body.customer;
    const phoneTicket = await t.call('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.id, channel: 'voice', subject: `${uniq('Called')} about a lid` },
    });

    const list = await t.call<PortalTicketSummary[]>('GET', '/portal/tickets', { token: session });
    expect(list.status).toBe(200);
    expect(list.body.map((x) => x.reference).sort()).toEqual(
      [mine.reference, phoneTicket.body.reference].sort(),
    );
    expect(list.body.find((x) => x.reference === mine.reference)).toMatchObject({
      subject: mine.subject,
      channel: 'web_form',
      status: 'open',
      rating: null,
    });

    const detail = await t.call<PortalTicketDetail>('GET', `/portal/tickets/${mine.reference}`, {
      token: session,
    });
    expect(detail.status).toBe(200);
    expect(detail.body.canReply).toBe(true);
    expect(detail.body.canRate).toBe(false);
    const said = detail.body.messages.map((m) => [m.from, m.name, m.body.slice(0, 20)]);
    expect(said).toContainEqual(['you', null, 'The kettle I bought ']);
    // The agent's first name only, and never the internal note.
    expect(said).toContainEqual(['support', 'Paula', 'Sorry about that. Is']);
    expect(JSON.stringify(detail.body)).not.toContain('INTERNAL');
    expect(JSON.stringify(detail.body)).not.toContain('Portal');

    // Someone else's ticket looks like one that doesn't exist, by reference or by id.
    for (const ref of [other.reference, other.id, 'TMS-99999999']) {
      expect((await t.call('GET', `/portal/tickets/${ref}`, { token: session })).status).toBe(404);
    }
    expect(
      (
        await t.call('POST', `/portal/tickets/${other.reference}/reply`, {
          token: session,
          body: { body: 'Let me in' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.call('POST', `/portal/tickets/${other.reference}/rating`, {
          token: session,
          body: { rating: 1 },
        })
      ).status,
    ).toBe(404);
  });

  it('adds a reply to the ticket, reopens it, and starts an email thread when there is none', async () => {
    const c = await customerWithTicket();
    const session = await signIn(c.email);
    expect((await resolve(c.id)).status).toBe(201);

    const reply = await t.call<PortalTicketDetail>('POST', `/portal/tickets/${c.reference}/reply`, {
      token: session,
      body: { body: 'It still does not heat, even with the base switched on.' },
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.messages.filter((m) => m.from === 'you')).toHaveLength(2);
    expect(reply.body.status).toBe('open');

    const convs = (await t.call('GET', `/tickets/${c.id}/conversations`, { token: admin })).body;
    expect(convs).toHaveLength(1);
    const viaPortal = convs[0].messages.filter(
      (m: { metadata: { via?: string } }) => m.metadata.via === 'portal',
    );
    expect(viaPortal).toHaveLength(1);
    expect(viaPortal[0]).toMatchObject({ direction: 'inbound', authorType: 'customer' });
    expect((await audit('message.received', c.id))[0]!.actorType).toBe('customer');
    expect(
      (
        await t.call('POST', `/portal/tickets/${c.reference}/reply`, {
          token: session,
          body: { body: '' },
        })
      ).status,
    ).toBe(400);

    // A ticket logged by an agent has no thread: the reply opens an email one to this address.
    const customer = (await t.call('GET', `/tickets/${c.id}`, { token: admin })).body.customer;
    const logged = await t.call('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.id, subject: `${uniq('Spare')} lid request` },
    });
    const second = await t.call('POST', `/portal/tickets/${logged.body.reference}/reply`, {
      token: session,
      body: { body: 'Any news on the spare lid?' },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const started = (
      await t.call('GET', `/tickets/${logged.body.id}/conversations`, { token: admin })
    ).body;
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      channel: 'email',
      externalThreadId: `portal-${logged.body.id}`,
      metadata: { address: c.email },
    });

    // The agent's answer on that thread goes to the customer's inbox, and shows in the portal.
    await t.call('POST', `/conversations/${started[0].id}/messages`, {
      token: agent.token,
      body: { body: 'The spare lid ships tomorrow.' },
    });
    await waitFor(
      async () => (await mailbox(c.email)).find((m) => m.text?.includes('ships tomorrow')),
      'the agent’s reply by email',
    );

    // Closed tickets can't be answered.
    await t.call('POST', `/tickets/${c.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });
    await t.call('POST', `/tickets/${c.id}/transition`, {
      token: admin,
      body: { status: 'closed' },
    });
    const closed = await t.call('POST', `/portal/tickets/${c.reference}/reply`, {
      token: session,
      body: { body: 'Hello?' },
    });
    expect(closed.status).toBe(409);
    expect(
      (await t.call('GET', `/portal/tickets/${c.reference}`, { token: session })).body.canReply,
    ).toBe(false);
  });
});

describe('ratings', () => {
  it('asks by email once a ticket is solved; the link rates that ticket only', async () => {
    const c = await customerWithTicket();
    await t.call('POST', `/tickets/${c.id}/assign`, {
      token: admin,
      body: { assigneeId: agent.id },
    });

    // Not solved yet: nothing to rate, and staff have no way to rate at all.
    const session = await signIn(c.email);
    const early = await t.call('POST', `/portal/tickets/${c.reference}/rating`, {
      token: session,
      body: { rating: 5 },
    });
    expect(early.status).toBe(409);
    expect(
      (await t.call('POST', `/tickets/${c.id}/rating`, { token: admin, body: { rating: 5 } }))
        .status,
    ).toBe(404);

    await resolve(c.id);
    const mail = await waitFor(
      async () => (await mailbox(c.email)).find((m) => m.subject?.startsWith('How did we do?')),
      'the survey email',
    );
    expect(mail.subject).toContain(c.reference);
    const token = /#\/rate\/(\S+)/.exec(mail.text ?? '')?.[1];
    expect(token).toBeTruthy();

    const prompt = await t.call<CsatPrompt>('GET', `/public/csat/${token}`);
    expect(prompt.status).toBe(200);
    expect(prompt.body).toEqual({ reference: c.reference, subject: c.subject, rating: null });
    expect((await t.call('GET', `/public/csat/${token}x`)).status).toBe(404);
    expect((await t.call('POST', `/public/csat/${token}`, { body: { rating: 6 } })).status).toBe(
      400,
    );

    const rated = await t.call('POST', `/public/csat/${token}`, {
      body: { rating: 5, comment: 'Quick and friendly.' },
    });
    expect(rated.status, JSON.stringify(rated.body)).toBe(200);
    expect(rated.body).toMatchObject({
      rating: 5,
      comment: 'Quick and friendly.',
      source: 'email',
    });

    // Agents read it; the audit trail says the customer gave it.
    const seen = await t.call('GET', `/tickets/${c.id}/rating`, { token: agent.token });
    expect(seen.body.rating).toMatchObject({ rating: 5, source: 'email' });
    expect((await audit('csat.submitted', c.id))[0]).toMatchObject({
      actorType: 'customer',
      data: { rating: 5, previousRating: null, source: 'email' },
    });

    // The customer changes their mind in the portal; a low rating reaches the assignee.
    const changed = await t.call('POST', `/portal/tickets/${c.reference}/rating`, {
      token: session,
      body: { rating: 2, comment: 'It broke again.' },
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ rating: 2, source: 'portal' });
    const detail = await t.call<PortalTicketDetail>('GET', `/portal/tickets/${c.reference}`, {
      token: session,
    });
    expect(detail.body).toMatchObject({ status: 'resolved', canRate: true, rating: { rating: 2 } });
    await waitFor(async () => {
      const mine = await t.call('GET', '/notifications', { token: agent.token });
      return (mine.body.items ?? mine.body).find(
        (n: { kind: string; title: string }) =>
          n.kind === 'csat.low' && n.title.includes(c.reference),
      );
    }, 'the low-rating notification');

    // Solved a second time: the customer is not asked again.
    await t.call('POST', `/tickets/${c.id}/transition`, {
      token: admin,
      body: { status: 'in_progress' },
    });
    await resolve(c.id);
    await eventsHandled(t);
    expect(
      (await mailbox(c.email)).filter((m) => m.subject?.startsWith('How did we do?')),
    ).toHaveLength(1);
    expect(await audit('csat.requested', c.id)).toHaveLength(1);
  });

  it('asks in the chat window, and again when the visitor comes back', async () => {
    const connect = (auth: Record<string, unknown> = {}) => {
      const s = io(`${t.baseUrl}/chat`, { auth, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      return s;
    };
    const visitor = connect({ name: 'Vik Visitor' });
    const session = await new Promise<{ token: string }>((r) => visitor.once('session', r));
    const prompts: ChatRatingPrompt[] = [];
    visitor.on('rate', (p: ChatRatingPrompt) => prompts.push(p));
    const marker = uniq('Where');
    const sent = await visitor.emitWithAck('message', {
      text: `${marker} is the manual for my kettle?`,
      clientMessageId: randomUUID(),
    });
    expect(sent.ok).toBe(true);
    const conv = await waitFor(async () => {
      const list = await t.call('GET', '/tickets', { token: admin, query: { q: marker } });
      return list.body.items[0] as { id: string; reference: string };
    }, 'the chat ticket');

    await resolve(conv.id);
    await waitFor(() => prompts.length > 0, 'the rating prompt');
    expect(prompts[0]).toMatchObject({ reference: conv.reference });

    // Coming back later with the same session: the question is still open.
    const back = connect({ token: session.token });
    await new Promise((r) => back.once('session', r));
    const history = await back.emitWithAck('history');
    expect(history.rate).toMatchObject({ reference: conv.reference });

    expect((await back.emitWithAck('rate', { token: history.rate.token, rating: 0 })).ok).toBe(
      false,
    );
    const answer = await back.emitWithAck('rate', { token: history.rate.token, rating: 4 });
    expect(answer).toEqual({ ok: true, rating: 4 });
    expect((await back.emitWithAck('history')).rate).toBeNull();
    expect(
      (await t.call('GET', `/tickets/${conv.id}/rating`, { token: admin })).body.rating,
    ).toMatchObject({ rating: 4, source: 'chat' });
  });

  it('can be switched off, and so can the portal', async () => {
    expect(
      (await t.call('GET', '/settings/customer-experience', { token: agent.token })).status,
    ).toBe(403);
    const defaults = await t.call('GET', '/settings/customer-experience', { token: admin });
    expect(defaults.body).toEqual({
      portalEnabled: true,
      csatByEmail: true,
      csatInChat: true,
      agentMinutesPerTicket: 10,
    });
    const c = await customerWithTicket();
    const session = await signIn(c.email);

    const saved = await t.call('PUT', '/settings/customer-experience', {
      token: admin,
      body: { portalEnabled: false, csatByEmail: false, csatInChat: false },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(
      (
        await t.call('PUT', '/settings/customer-experience', {
          token: admin,
          body: { agentMinutesPerTicket: 0 },
        })
      ).status,
    ).toBe(400);

    expect(
      (await t.call('POST', '/public/portal/sign-in', { body: { email: c.email } })).status,
    ).toBe(403);
    expect((await t.call('GET', '/portal/tickets', { token: session })).status).toBe(403);
    // The worker hears about the new settings through an event.
    await eventsHandled(t);
    await resolve(c.id);
    await eventsHandled(t);
    expect(
      (await mailbox(c.email)).filter((m) => m.subject?.startsWith('How did we do?')),
    ).toHaveLength(0);

    await t.call('PUT', '/settings/customer-experience', { token: admin, body: {} });
    expect((await t.call('GET', '/portal/tickets', { token: session })).status).toBe(200);
  });
});
