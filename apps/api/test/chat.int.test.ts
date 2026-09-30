import type { INestApplicationContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';

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
