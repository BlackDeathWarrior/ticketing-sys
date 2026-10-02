import type { INestApplicationContext } from '@nestjs/common';
import type {
  CreatedApiKey,
  IntegrationMessageView,
  IntegrationTicketList,
  IntegrationTicketView,
  IntegrationView,
} from '@tms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationsService } from '../src/conversations/conversations.service';
import { DB } from '../src/infra/tokens';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';

/**
 * The integration API for tickets (ADR 0023): an app raises a ticket in one
 * call, adds follow-ups, and reads the ticket and its customer-visible
 * messages. It never reaches a ticket it did not raise.
 */
let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let shop: Awaited<ReturnType<typeof connect>>;
let other: Awaited<ReturnType<typeof connect>>;
let category: string;

interface StaffTicket {
  id: string;
  reference: string;
  channel: string;
  status: string;
  priority: string;
  tags: string[];
  externalRef: string | null;
  metadata: Record<string, unknown>;
  integration: { id: string; slug: string; name: string } | null;
  customer: { id: string; displayName: string; primaryEmail: string | null };
  category: { name: string } | null;
}
interface StaffConversation {
  id: string;
  channel: string;
  controller: string;
  messages: Array<{ id: string; authorType: string; deliveryStatus: string | null; body: string }>;
}

/** An integration with a key; `as(key)` calls the API the way the app would. */
async function connect(name: string, scopes = ['integration:ticket']) {
  const integration = await t.call<IntegrationView>('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('app-'), name },
  });
  const key = await t.call<CreatedApiKey>('POST', `/integrations/${integration.body.id}/keys`, {
    token: admin,
    body: { name: 'Backend', scopes },
  });
  expect(key.status).toBe(201);
  return { ...integration.body, key: key.body.key };
}

/** Calls the API with a key and optional extra headers (the idempotency key). */
async function api<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely typed test responses
  key: string,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await t.app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const listing = {
  id: 'MYN-48213',
  title: 'Cotton straight kurta',
  source: 'Myntra',
  price_current: 1499,
  price_original: 2999,
};

async function raise(key = shop.key, extra: Record<string, unknown> = {}) {
  const res = await api<IntegrationTicketView>(key, 'POST', '/integration/tickets', {
    customer: { externalId: uniq('shopper-'), name: 'Asha Verma' },
    subject: 'The price on this listing looks wrong',
    body: 'The site shows 1,499 but the store charges 1,799.',
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

const staffTicket = async (reference: string) =>
  (await t.call<StaffTicket>('GET', `/tickets/${reference}`, { token: admin })).body;
const staffConversations = async (ticketId: string) =>
  (await t.call<StaffConversation[]>('GET', `/tickets/${ticketId}/conversations`, { token: admin }))
    .body;
const messages = async (reference: string, key = shop.key, query = '') =>
  (
    await api<IntegrationMessageView[]>(
      key,
      'GET',
      `/integration/tickets/${reference}/messages${query}`,
    )
  ).body;

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Maya Lindqvist' });
  // These tests are about the API itself; the AI on integration tickets is in ai.int.test.ts.
  await t.call('PUT', '/settings/ai', { token: admin, body: { channels: { api: 'off' } } });
  category = uniq('Listings ');
  const made = await t.call('POST', '/categories', { token: admin, body: { name: category } });
  expect(made.status).toBe(201);
  shop = await connect('Ethnic Threads');
  other = await connect('Another app');
  worker = await startWorker();
});

afterAll(async () => {
  await worker?.close();
  await t?.call('PUT', '/settings/ai', { token: admin, body: {} });
  await t?.close();
});

describe('raising a ticket', () => {
  it('creates the customer, the ticket and its first message in one call', async () => {
    const shopper = uniq('shopper-');
    const res = await api<IntegrationTicketView>(shop.key, 'POST', '/integration/tickets', {
      customer: { externalId: shopper, email: `${shopper}@shopper.example`, name: 'Asha Verma' },
      subject: 'The price on this listing looks wrong',
      body: 'The site shows 1,499 but the store charges 1,799.',
      category: category.toUpperCase(),
      priority: 'high',
      tags: ['wrong-price', 'wrong-price'],
      externalRef: listing.id,
      metadata: listing,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      reference: expect.stringMatching(/^TMS-\d+$/),
      subject: 'The price on this listing looks wrong',
      status: { key: 'new', state: 'open' },
      priority: 'high',
      category,
      tags: ['wrong-price'],
      externalRef: listing.id,
      metadata: listing,
      customer: { name: 'Asha Verma', email: `${shopper}@shopper.example`, externalId: shopper },
      resolvedAt: null,
    });

    // Agents see it like any ticket, with where it came from and what the app sent.
    const ticket = await staffTicket(res.body.reference);
    expect(ticket).toMatchObject({
      channel: 'api',
      externalRef: listing.id,
      metadata: listing,
      integration: { id: shop.id, slug: shop.slug, name: 'Ethnic Threads' },
    });
    const [conversation] = await staffConversations(ticket.id);
    expect(conversation).toMatchObject({ channel: 'api', controller: 'none' });
    expect(conversation!.messages).toHaveLength(1);

    // The app's id for the person is their identity; it vouches for their email too.
    const customer = await t.call('GET', `/customers/${ticket.customer.id}`, { token: admin });
    expect(customer.body.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'external_id', value: `${shop.slug}:${shopper}` }),
        expect.objectContaining({
          type: 'email',
          value: `${shopper}@shopper.example`,
          verified: true,
        }),
      ]),
    );

    expect(await messages(res.body.reference)).toEqual([
      expect.objectContaining({
        from: 'customer',
        name: null,
        body: 'The site shows 1,499 but the store charges 1,799.',
      }),
    ]);
  });

  it('finds the same customer by the same id, and keeps integrations apart', async () => {
    const customer = { externalId: uniq('shopper-'), name: 'Ravi' };
    const first = await staffTicket((await raise(shop.key, { customer })).reference);
    const second = await staffTicket((await raise(shop.key, { customer })).reference);
    expect(second.id).not.toBe(first.id);
    expect(second.customer.id).toBe(first.customer.id);
    // The other app's "same" id is somebody else.
    const elsewhere = await staffTicket((await raise(other.key, { customer })).reference);
    expect(elsewhere.customer.id).not.toBe(first.customer.id);
  });

  it('takes a customer known only by email', async () => {
    const email = `${uniq('anon')}@shopper.example`;
    const made = await raise(shop.key, { customer: { email } });
    expect(made.customer).toEqual({ name: email, email, externalId: null });
  });

  it('creates nothing twice for one Idempotency-Key', async () => {
    const body = {
      customer: { externalId: uniq('shopper-') },
      subject: 'Broken link',
      body: 'The buy button opens a missing page.',
    };
    const key = { 'idempotency-key': uniq('retry-key-') };
    const first = await api<IntegrationTicketView>(
      shop.key,
      'POST',
      '/integration/tickets',
      body,
      key,
    );
    const again = await api<IntegrationTicketView>(
      shop.key,
      'POST',
      '/integration/tickets',
      body,
      key,
    );
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.reference).toBe(first.body.reference);
    expect(await messages(first.body.reference)).toHaveLength(1);

    // The same key from another integration is its own request.
    const elsewhere = await api<IntegrationTicketView>(
      other.key,
      'POST',
      '/integration/tickets',
      body,
      key,
    );
    expect(elsewhere.status).toBe(201);
    expect(elsewhere.body.reference).not.toBe(first.body.reference);
  });

  it('says what is wrong with a bad request', async () => {
    const base = { subject: 'Hello', body: 'Hello there' };
    const post = (body: unknown, headers = {}) =>
      api(shop.key, 'POST', '/integration/tickets', body, headers);

    const nobody = await post({ ...base, customer: { name: 'No ids' } });
    expect(nobody.status).toBe(400);
    expect(JSON.stringify(nobody.body)).toContain('Give the customer an externalId or an email');

    const unknown = await post({ ...base, customer: { externalId: 'x1' }, category: 'Nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe('Unknown category "Nope"');

    const big = await post({
      ...base,
      customer: { externalId: 'x1' },
      metadata: { blob: 'x'.repeat(9000) },
    });
    expect(big.status).toBe(400);

    const badKey = await post(
      { ...base, customer: { externalId: 'x1' } },
      { 'idempotency-key': 'short' },
    );
    expect(badKey.status).toBe(400);
    expect(badKey.body.message).toMatch(/^Idempotency-Key: /);
  });
});

describe('the conversation', () => {
  it('shows the app what the customer may see: replies, never drafts or notes', async () => {
    const made = await raise();
    const ticket = await staffTicket(made.reference);
    const [conversation] = await staffConversations(ticket.id);

    // An internal note and an AI draft: neither is for the customer.
    await t.call('POST', `/tickets/${ticket.id}/notes`, {
      token: agent.token,
      body: { body: 'Checked with the catalogue team.' },
    });
    const conversations = t.app.get(ConversationsService);
    await conversations.addMessage(t.app.get(DB), {
      conversationId: conversation!.id,
      channel: 'api',
      direction: 'outbound',
      authorType: 'ai',
      body: 'A draft nobody approved.',
      deliveryStatus: 'draft',
    });

    const reply = await t.call('POST', `/conversations/${conversation!.id}/messages`, {
      token: agent.token,
      body: { body: 'Thanks, we have corrected the price.' },
    });
    expect(reply.status).toBe(201);

    const seen = await messages(made.reference);
    expect(seen.map((m) => [m.from, m.body])).toEqual([
      ['customer', 'The site shows 1,499 but the store charges 1,799.'],
      ['support', 'Thanks, we have corrected the price.'],
    ]);
    // First name only, as in the portal.
    expect(seen[1]!.name).toBe('Maya');

    // The reply needs no delivery: the app reads it, so the worker marks it sent.
    await waitFor(async () => {
      const m = (await staffConversations(ticket.id))[0]!.messages.find(
        (x) => x.authorType === 'agent',
      );
      return m?.deliveryStatus === 'sent';
    }, 'the reply to be marked sent');

    // Polling: only what is newer than the last message seen.
    const newer = await messages(made.reference, shop.key, `?after=${seen[0]!.createdAt}`);
    expect(newer.map((m) => m.from)).toEqual(['support']);
    expect(await messages(made.reference, shop.key, `?after=${seen[1]!.createdAt}`)).toEqual([]);

    // The agent's reply moved the ticket on.
    const now = await api<IntegrationTicketView>(
      shop.key,
      'GET',
      `/integration/tickets/${made.reference}`,
    );
    expect(now.body.status).toMatchObject({ key: 'in_progress', state: 'open' });
    expect(now.body.handling).toBe('human');
  });

  it("adds the customer's follow-up to the same conversation and reopens a solved ticket", async () => {
    const made = await raise();
    const ticket = await staffTicket(made.reference);
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'resolved', resolution: 'Price corrected.' },
    });

    const key = { 'idempotency-key': uniq('follow-up-') };
    const post = () =>
      api<IntegrationMessageView>(
        shop.key,
        'POST',
        `/integration/tickets/${made.reference}/messages`,
        { body: 'It still shows the old price for me.' },
        key,
      );
    const sent = await post();
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      from: 'customer',
      body: 'It still shows the old price for me.',
    });
    const again = await post();
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(sent.body.id);

    const conversations = await staffConversations(ticket.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.messages).toHaveLength(2);
    expect((await staffTicket(made.reference)).status).toBe('in_progress');
  });

  it('refuses a follow-up on a closed ticket', async () => {
    const made = await raise();
    const ticket = await staffTicket(made.reference);
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'closed' },
    });
    const res = await api(shop.key, 'POST', `/integration/tickets/${made.reference}/messages`, {
      body: 'Hello again',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This ticket is closed. Create a new one.');
  });

  it("passes on the customer's rating once the ticket is solved", async () => {
    const made = await raise();
    const rate = () =>
      api(shop.key, 'POST', `/integration/tickets/${made.reference}/rating`, {
        rating: 5,
        comment: 'Fixed within the hour.',
      });
    expect((await rate()).status).toBe(409);

    const ticket = await staffTicket(made.reference);
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });
    const rated = await rate();
    expect(rated.status).toBe(200);
    expect(rated.body).toMatchObject({ rating: 5, source: 'api' });
    const seen = await t.call('GET', `/tickets/${ticket.id}/rating`, { token: admin });
    expect(seen.body.rating).toMatchObject({ rating: 5, comment: 'Fixed within the hour.' });
  });
});

describe('finding tickets', () => {
  it('lists its own tickets by reference in the app and by state', async () => {
    const ref = uniq('LISTING-');
    const open = await raise(shop.key, { externalRef: ref });
    const solved = await raise(shop.key, { externalRef: ref });
    await raise(shop.key, { externalRef: uniq('OTHER-') });
    const ticket = await staffTicket(solved.reference);
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });

    const list = (query: string, key = shop.key) =>
      api<IntegrationTicketList>(key, 'GET', `/integration/tickets?${query}`);
    const both = await list(`externalRef=${ref}`);
    expect(both.body.total).toBe(2);
    expect(both.body.items.map((i) => i.reference).sort()).toEqual(
      [open.reference, solved.reference].sort(),
    );
    const stillOpen = await list(`externalRef=${ref}&state=open`);
    expect(stillOpen.body.items.map((i) => i.reference)).toEqual([open.reference]);
    const done = await list(`externalRef=${ref}&state=resolved`);
    expect(done.body.items.map((i) => i.reference)).toEqual([solved.reference]);
    expect((await list('state=nonsense')).status).toBe(400);

    // Paging, newest first.
    const page = await list('limit=1');
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBeGreaterThan(2);

    // Another integration sees none of them.
    expect((await list(`externalRef=${ref}`, other.key)).body).toEqual({ items: [], total: 0 });
  });

  it("lists one user's tickets by the app's own id for them, and says whose a ticket is", async () => {
    const list = (query: string, key = shop.key) =>
      api<IntegrationTicketList>(key, 'GET', `/integration/tickets?${query}`);
    const asha = uniq('shopper-');
    const ravi = uniq('shopper-');
    const first = await raise(shop.key, { customer: { externalId: asha, name: 'Asha Verma' } });
    const second = await raise(shop.key, { customer: { externalId: asha } });
    const ravis = await raise(shop.key, { customer: { externalId: ravi, name: 'Ravi Menon' } });
    expect(first.customer.externalId).toBe(asha);

    // "Your requests" in the app: only this person's.
    const mine = await list(`customer=${asha}`);
    expect(mine.body.total).toBe(2);
    expect(mine.body.items.map((i) => i.reference).sort()).toEqual(
      [first.reference, second.reference].sort(),
    );
    expect(mine.body.items.every((i) => i.customer.externalId === asha)).toBe(true);
    expect((await list(`customer=${asha}&state=resolved`)).body.total).toBe(0);

    // Reading one ticket says whose it is, so the app can check before it shows it.
    const read = await api<IntegrationTicketView>(
      shop.key,
      'GET',
      `/integration/tickets/${ravis.reference}`,
    );
    expect(read.body.customer.externalId).toBe(ravi);

    // Someone the app has never named has no tickets.
    expect((await list(`customer=${uniq('nobody-')}`)).body).toEqual({ items: [], total: 0 });
    // Another app's user with the same id is another person.
    await raise(other.key, { customer: { externalId: asha } });
    expect((await list(`customer=${asha}`, other.key)).body.total).toBe(1);
    expect((await list(`customer=${asha}`)).body.total).toBe(2);
    // A customer known only by email has no id of the app's.
    const byEmail = await raise(shop.key, {
      customer: { email: `${uniq('walkin')}@shopper.example` },
    });
    expect(byEmail.customer.externalId).toBeNull();
  });
});

describe('what an integration cannot reach', () => {
  it("answers 404 for another integration's ticket, and for one raised on another channel", async () => {
    const theirs = await raise(other.key);
    const customer = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Walk-in', email: `${uniq('walkin')}@customer.example` },
    });
    const byStaff = await t.call<{ reference: string }>('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.body.id, subject: 'Raised by an agent' },
    });

    for (const reference of [
      theirs.reference,
      byStaff.body.reference,
      'TMS-99999999',
      'nonsense',
    ]) {
      for (const [method, url, body] of [
        ['GET', `/integration/tickets/${reference}`, undefined],
        ['GET', `/integration/tickets/${reference}/messages`, undefined],
        ['POST', `/integration/tickets/${reference}/messages`, { body: 'Let me in' }],
        ['POST', `/integration/tickets/${reference}/rating`, { rating: 1 }],
      ] as const) {
        const res = await api(shop.key, method, url, body);
        expect(res.status, `${method} ${url}`).toBe(404);
        expect(res.body.message).toBe('Ticket not found');
      }
    }
    // Nothing was added to their ticket.
    expect(await messages(theirs.reference, other.key)).toHaveLength(1);
  });

  it('needs the ticket scope, and an API key rather than a staff token', async () => {
    const events = await connect('Worker only', ['integration:event']);
    const res = await api(events.key, 'POST', '/integration/tickets', {
      customer: { externalId: 'x1' },
      subject: 'No',
      body: 'No',
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This API key lacks the scope: integration:ticket');
    expect((await api(events.key, 'GET', '/integration/tickets')).status).toBe(403);

    expect((await t.call('GET', '/integration/tickets', { token: admin })).status).toBe(401);
    expect((await t.call('GET', '/integration/tickets')).status).toBe(401);
  });
});
