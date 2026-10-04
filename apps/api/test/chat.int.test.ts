import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';

const IDENTITY_SECRET = 'host-site-identity-secret-at-least-32-chars';
process.env.CHAT_IDENTITY_SECRET = IDENTITY_SECRET;

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
const sockets: Socket[] = [];

beforeAll(async () => {
  t = await startApp({ listen: true });
  worker = await startWorker();
  admin = await t.adminToken();
});

afterEach(() => {
  while (sockets.length) sockets.pop()!.disconnect();
});

afterAll(async () => {
  await worker?.close();
  await t?.close();
});

function connect(namespace: '/chat' | '/agent', auth: Record<string, unknown>): Socket {
  const s = io(`${t.baseUrl}${namespace}`, { auth, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

function next<T = unknown>(s: Socket, event: string, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${event} event`)), timeoutMs);
    s.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function startChat(auth: Record<string, unknown> = {}) {
  const chat = connect('/chat', auth);
  const session = await next<{ token: string; sessionId: string }>(chat, 'session');
  return { chat, session };
}

async function ticketForConversation(messageId: string) {
  // The newest web chat tickets; find the one holding this message.
  const list = await t.call('GET', '/tickets', {
    token: admin,
    query: { channel: 'webchat', limit: '20' },
  });
  for (const ticket of list.body.items) {
    const convs = await t.call('GET', `/tickets/${ticket.id}/conversations`, { token: admin });
    const conv = convs.body.find((c: { messages: Array<{ id: string }> }) =>
      c.messages.some((m) => m.id === messageId),
    );
    if (conv) return { ticket, conv };
  }
  return null;
}

describe('web chat', () => {
  it('turns a visitor message into a ticket and delivers the agent reply live', async () => {
    const agent = connect('/agent', { token: admin });
    const agentEvents: Array<{ type: string; ticketId?: string }> = [];
    agent.on('event', (e) => agentEvents.push(e));
    await waitFor(() => agent.connected, 'agent socket');

    const email = `${uniq('meera')}@example.com`;
    const { chat, session } = await startChat({ name: 'Meera Iyer', email });
    expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);

    const first = await chat.emitWithAck('message', {
      text: 'Where is my order 48213?',
      clientMessageId: 'client-msg-0001',
    });
    expect(first.ok).toBe(true);
    // No AI answers this chat, so the widget is not told that an answer is being written.
    expect(first.assistantReplying).toBe(false);

    // A resend with the same client id (lost ack) is not stored twice.
    const resend = await chat.emitWithAck('message', {
      text: 'Where is my order 48213?',
      clientMessageId: 'client-msg-0001',
    });
    expect(resend.message.id).toBe(first.message.id);

    const found = await waitFor(() => ticketForConversation(first.message.id), 'chat ticket');
    expect(found.ticket.subject).toBe('Chat: Where is my order 48213?');
    expect(found.ticket.status).toBe('new');
    expect(found.conv.messages).toHaveLength(1);
    expect(found.conv.metadata.sessionId).toBe(session.sessionId);

    // The visitor is a customer with the chat session and the (unverified) email they typed.
    const customer = await t.call('GET', `/customers/${found.ticket.customerId}`, { token: admin });
    expect(customer.body.displayName).toBe('Meera Iyer');
    const identities = customer.body.identities.map((i: { type: string; verified: boolean }) => [
      i.type,
      i.verified,
    ]);
    expect(identities).toEqual(
      expect.arrayContaining([
        ['webchat_session', false],
        ['email', false],
      ]),
    );

    await waitFor(
      () =>
        agentEvents.some((e) => e.type === 'message.received' && e.ticketId === found.ticket.id),
      'agent console event',
    );

    const incoming = next<{ body: string; authorType: string; authorName: string }>(
      chat,
      'message',
    );
    const reply = await t.call('POST', `/conversations/${found.conv.id}/messages`, {
      token: admin,
      body: { body: 'It left our warehouse today.' },
    });
    expect(reply.status).toBe(201);
    expect(reply.body.deliveryStatus).toBe('pending');

    const pushed = await incoming;
    expect(pushed).toMatchObject({
      body: 'It left our warehouse today.',
      authorType: 'agent',
      authorName: 'Administrator',
    });

    const delivered = await waitFor(async () => {
      const convs = await t.call('GET', `/tickets/${found.ticket.id}/conversations`, {
        token: admin,
      });
      const out = convs.body[0].messages.find((m: { id: string }) => m.id === reply.body.id);
      return out?.deliveryStatus === 'sent' ? out : null;
    }, 'delivery status');
    expect(delivered.sentAt).not.toBeNull();

    const ticket = await t.call('GET', `/tickets/${found.ticket.id}`, { token: admin });
    expect(ticket.body.status).toBe('in_progress');
    expect(ticket.body.firstResponseAt).not.toBeNull();

    // Coming back with the session token resumes the same conversation.
    const back = connect('/chat', { token: session.token });
    const resumed = await next<{ sessionId: string }>(back, 'session');
    expect(resumed.sessionId).toBe(session.sessionId);
    const history = await back.emitWithAck('history');
    expect(history.messages.map((m: { authorType: string }) => m.authorType)).toEqual([
      'customer',
      'agent',
    ]);
  });

  it('reopens a resolved chat ticket when the visitor writes again', async () => {
    const { chat } = await startChat({ name: 'Kabir' });
    const sent = await chat.emitWithAck('message', {
      text: 'My coupon did not apply',
      clientMessageId: 'client-msg-0101',
    });
    const { ticket } = await waitFor(() => ticketForConversation(sent.message.id), 'ticket');
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'resolved', resolution: 'Coupon re-applied' },
    });

    await chat.emitWithAck('message', {
      text: 'It happened again',
      clientMessageId: 'client-msg-0102',
    });
    const after = await t.call('GET', `/tickets/${ticket.id}`, { token: admin });
    expect(after.body.status).toBe('in_progress');
    const convs = await t.call('GET', `/tickets/${ticket.id}/conversations`, { token: admin });
    expect(convs.body).toHaveLength(1);
    expect(convs.body[0].messages).toHaveLength(2);
  });

  it('links a visitor vouched for by the host site to the existing customer', async () => {
    const email = `${uniq('known')}@example.com`;
    const existing = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Known Customer', email },
    });
    const identityToken = await new JwtService().signAsync(
      { email, name: 'Known Customer' },
      { secret: IDENTITY_SECRET, expiresIn: '5m' },
    );
    const { chat } = await startChat({ identityToken });
    const sent = await chat.emitWithAck('message', {
      text: 'Hello from my account page',
      clientMessageId: 'client-msg-0201',
    });
    const { ticket } = await waitFor(() => ticketForConversation(sent.message.id), 'ticket');
    expect(ticket.customerId).toBe(existing.body.id);
  });

  it('does not link to an existing customer on an unverified email', async () => {
    const email = `${uniq('victim')}@example.com`;
    const existing = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Real Owner', email },
    });
    const { chat } = await startChat({ name: 'Impostor', email });
    const sent = await chat.emitWithAck('message', {
      text: 'Please change my address',
      clientMessageId: 'client-msg-0301',
    });
    const { ticket } = await waitFor(() => ticketForConversation(sent.message.id), 'ticket');
    expect(ticket.customerId).not.toBe(existing.body.id);
  });

  it('rejects invalid messages and agent sockets without a valid token', async () => {
    const { chat } = await startChat();
    const empty = await chat.emitWithAck('message', {
      text: '   ',
      clientMessageId: 'client-msg-0401',
    });
    expect(empty.ok).toBe(false);

    const intruder = connect('/agent', { token: 'not-a-token' });
    await waitFor(() => intruder.disconnected && !intruder.active, 'intruder disconnect');
  });
});

describe("web chat on an integration's site (ADR 0026)", () => {
  /** An integration with an API key and its own chat identity secret. */
  async function site(name: string) {
    const integration = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('site-'), name },
    });
    const key = await t.call('POST', `/integrations/${integration.body.id}/keys`, {
      token: admin,
      body: { name: 'Backend', scopes: ['integration:ticket'] },
    });
    const secret = await t.call(
      'POST',
      `/integrations/${integration.body.id}/chat-identity-secret`,
      {
        token: admin,
      },
    );
    expect(secret.status).toBe(201);
    return {
      ...(integration.body as { id: string; slug: string }),
      key: key.body.key as string,
      identitySecret: secret.body.secret as string,
    };
  }
  const sign = (claims: Record<string, unknown>, secret: string) =>
    new JwtService().signAsync(claims, { secret, expiresIn: '5m' });
  const staffTicket = async (reference: string) =>
    (await t.call('GET', `/tickets/${reference}`, { token: admin })).body;

  it('makes the chat one of the integration’s own tickets, with what the page showed', async () => {
    const shop = await site('Acme Store');
    const other = await site('Another shop');
    const { chat } = await startChat({
      integration: shop.slug,
      name: 'Asha',
      context: { product_id: 'MYN-48213', title: 'Cotton straight kurta', kind: 'incident' },
    });
    const first = await chat.emitWithAck('message', {
      text: 'Is this kurta available in medium?',
      clientMessageId: uniq('client-msg-'),
    });
    expect(first).toMatchObject({
      ok: true,
      ticket: { reference: expect.stringMatching(/^TMS-\d+$/), created: true },
    });
    const again = await chat.emitWithAck('message', {
      text: 'And in large?',
      clientMessageId: uniq('client-msg-'),
    });
    expect(again.ticket).toEqual({ reference: first.ticket.reference, created: false });

    // Agents see which site it came from and what was on screen; `kind` is not the page's to set.
    const ticket = await staffTicket(first.ticket.reference);
    expect(ticket).toMatchObject({
      channel: 'webchat',
      integration: { slug: shop.slug },
      metadata: { product_id: 'MYN-48213', title: 'Cotton straight kurta' },
    });
    expect(ticket.metadata.kind).toBeUndefined();

    // The site's backend can read it with its key; another integration cannot.
    const read = (key: string) =>
      t.call('GET', `/integration/tickets/${first.ticket.reference}/messages`, { token: key });
    expect((await read(shop.key)).body.map((m: { body: string }) => m.body)).toEqual([
      'Is this kurta available in medium?',
      'And in large?',
    ]);
    expect((await read(other.key)).status).toBe(404);

    // The page moves on: the next ticket carries the new context.
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'closed' },
    });
    expect(await chat.emitWithAck('context', { product_id: 'AMZ-1002' })).toEqual({ ok: true });
    expect((await chat.emitWithAck('context', { blob: 'x'.repeat(3000) })).ok).toBe(false);
    const later = await chat.emitWithAck('message', {
      text: 'A question about another listing',
      clientMessageId: uniq('client-msg-'),
    });
    expect(later.ticket.created).toBe(true);
    expect((await staffTicket(later.ticket.reference)).metadata).toEqual({
      product_id: 'AMZ-1002',
    });
  });

  it('knows a signed-in visitor as the customer the integration names through its API', async () => {
    const shop = await site('Acme Store');
    const shopper = uniq('shopper-');
    const raised = await t.call('POST', '/integration/tickets', {
      token: shop.key,
      body: {
        customer: { externalId: shopper, name: 'Asha Verma' },
        subject: 'Earlier request',
        body: 'Raised by the site’s backend.',
        ai: 'off',
      },
    });
    const viaApi = await staffTicket(raised.body.reference);

    const { chat } = await startChat({
      integration: shop.slug,
      identityToken: await sign({ sub: shopper, name: 'Asha Verma' }, shop.identitySecret),
    });
    const sent = await chat.emitWithAck('message', {
      text: 'Following up from my account page',
      clientMessageId: uniq('client-msg-'),
    });
    const viaChat = await staffTicket(sent.ticket.reference);
    expect(viaChat.customer.id).toBe(viaApi.customer.id);
  });

  it('ignores an identity signed with anything but this integration’s secret', async () => {
    const shop = await site('Acme Store');
    const other = await site('Another shop');
    const shopper = uniq('shopper-');
    for (const secret of [other.identitySecret, IDENTITY_SECRET]) {
      const { chat } = await startChat({
        integration: shop.slug,
        identityToken: await sign({ sub: shopper, name: 'Someone else' }, secret),
      });
      const sent = await chat.emitWithAck('message', {
        text: 'Let me into that account',
        clientMessageId: uniq('client-msg-'),
      });
      const ticket = await staffTicket(sent.ticket.reference);
      const customer = await t.call('GET', `/customers/${ticket.customer.id}`, { token: admin });
      // An anonymous visitor: no identity of the shop's customer.
      expect(
        customer.body.identities.map((i: { type: string }) => i.type),
        'identity types',
      ).toEqual(['webchat_session']);
    }
  });

  it('refuses a widget that names an unknown or switched-off integration', async () => {
    const shop = await site('Acme Store');
    await t.call('PATCH', `/integrations/${shop.id}`, { token: admin, body: { isActive: false } });
    for (const integration of ['no-such-site', shop.slug]) {
      const chat = connect('/chat', { integration });
      const refused = await next<{ message: string }>(chat, 'error');
      expect(refused.message).toBe('This chat is not set up correctly: unknown integration');
      await waitFor(() => chat.disconnected, 'the socket to be closed');
    }
  });

  it('shows the identity secret once, to administrators', async () => {
    const shop = await site('Acme Store');
    expect(shop.identitySecret).toMatch(/^chid_[A-Za-z0-9_-]{43}$/);
    const listed = await t.call('GET', '/integrations', { token: admin });
    const mine = listed.body.find((i: { id: string }) => i.id === shop.id);
    expect(mine.chatIdentityLast4).toBe(shop.identitySecret.slice(-4));
    expect(JSON.stringify(listed.body)).not.toContain(shop.identitySecret);
    // A new secret is an administrator's to make: a supervisor is refused.
    const supervisor = await makeUser(t, admin, 'supervisor');
    expect(
      (
        await t.call('POST', `/integrations/${shop.id}/chat-identity-secret`, {
          token: supervisor.token,
        })
      ).status,
    ).toBe(403);
  });
});
