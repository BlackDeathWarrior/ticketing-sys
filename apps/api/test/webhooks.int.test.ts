import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import { type Database, webhookDeliveries } from '@tms/db';
import type {
  CreatedApiKey,
  IntegrationTicketView,
  IntegrationView,
  WebhookDeliveryView,
  WebhookPayload,
  WebhookTestResult,
  WebhookView,
  WebhookWithSecret,
} from '@tms/shared';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationsService } from '../src/conversations/conversations.service';
import { DB } from '../src/infra/tokens';
import { verifySignatureHeader } from '../src/webhooks/webhook-sign';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';

// The receiver is a server inside this test, on the loopback address; retries are quick.
Object.assign(process.env, {
  WEBHOOK_PRIVATE_HOSTS: '127.0.0.1',
  WEBHOOK_BACKOFF_MS: '100',
  WEBHOOK_MAX_ATTEMPTS: '3',
  WEBHOOK_DISABLE_AFTER: '2',
  WEBHOOK_TIMEOUT_MS: '1500',
});

/**
 * Webhooks to integrations (ADR 0025): signed deliveries of the events a
 * subscription asked for, retried when the receiver fails, logged without
 * their content, and switched off when they keep failing.
 */
let t: TestClient;
let worker: INestApplicationContext;
let db: Database;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let supervisor: Awaited<ReturnType<typeof makeUser>>;
let shop: Awaited<ReturnType<typeof connect>>;
let other: Awaited<ReturnType<typeof connect>>;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: WebhookPayload<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely typed test payloads
}
let receiver: Server;
let base: string;
const received: Received[] = [];
/** What the receiver answers, per path; 200 unless a test says otherwise. */
let answer: (path: string, nth: number) => { status: number; location?: string };
/** Subscriptions a test made: switched off when it ends, so tests don't hear each other. */
const made: string[] = [];

async function connect(name: string) {
  const integration = await t.call<IntegrationView>('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('app-'), name },
  });
  const key = await t.call<CreatedApiKey>('POST', `/integrations/${integration.body.id}/keys`, {
    token: admin,
    body: {
      name: 'Backend',
      scopes: ['integration:ticket', 'integration:event'],
      rateLimitPerMinute: 6000,
    },
  });
  return { ...integration.body, key: key.body.key };
}

/** A subscription whose deliveries arrive at their own path of the receiver. */
async function subscribe(
  events: string[],
  opts: { integration?: { id: string }; scope?: 'own' | 'all' } = {},
) {
  const path = `/${uniq('hook-')}`;
  const res = await t.call<WebhookWithSecret>(
    'POST',
    `/integrations/${(opts.integration ?? shop).id}/webhooks`,
    { token: admin, body: { url: `${base}${path}`, events, scope: opts.scope ?? 'own' } },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  made.push(res.body.id);
  return { ...res.body, path };
}

/** Makes one subscription's receiver answer differently; the others keep answering 200. */
function respond(path: string, how: (nth: number) => { status: number; location?: string }) {
  answer = (p, nth) => (p === path ? how(nth) : { status: 200 });
}

const at = (path: string) => received.filter((r) => r.path === path);
const types = (path: string) => at(path).map((r) => r.body.type);
/** Waits until `count` deliveries of `type` have arrived at a subscription. */
const arrived = (path: string, type: string, count = 1) =>
  waitFor(() => {
    const got = at(path).filter((r) => r.body.type === type);
    return got.length >= count ? got : undefined;
  }, `${count} × ${type} at ${path}`);
/** Gives deliveries that should NOT happen time to happen. */
const settle = () => new Promise((r) => setTimeout(r, 1200));

const raise = async (key = shop.key, extra: Record<string, unknown> = {}) => {
  const res = await t.call<IntegrationTicketView>('POST', '/integration/tickets', {
    token: key,
    body: {
      customer: { externalId: uniq('shopper-'), name: 'Asha Verma' },
      subject: 'The price on this listing looks wrong',
      body: 'The site shows 1,499 but the store charges 1,799.',
      externalRef: 'MYN-48213',
      ai: 'off',
      ...extra,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
};
const staffTicket = async (reference: string) =>
  (await t.call<{ id: string }>('GET', `/tickets/${reference}`, { token: admin })).body;
const log = async (id: string) =>
  (await t.call<WebhookDeliveryView[]>('GET', `/webhooks/${id}/deliveries`, { token: admin })).body;
const subscription = async (s: { id: string; integrationId: string }) =>
  (
    await t.call<WebhookView[]>('GET', `/integrations/${s.integrationId}/webhooks`, {
      token: admin,
    })
  ).body.find((w) => w.id === s.id)!;

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const path = req.url ?? '/';
      received.push({ path, headers: req.headers, raw, body: JSON.parse(raw) });
      const a = answer(path, at(path).length);
      res.writeHead(a.status, a.location ? { location: a.location } : {});
      res.end(a.status === 200 ? 'ok' : 'internal details that must not be stored');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  t = await startApp();
  db = t.app.get(DB);
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Maya Lindqvist' });
  supervisor = await makeUser(t, admin, 'supervisor');
  await t.call('PUT', '/settings/ai', { token: admin, body: { channels: { api: 'off' } } });
  shop = await connect('Acme Store');
  other = await connect('Another app');
  worker = await startWorker();
});

beforeEach(() => {
  answer = () => ({ status: 200 });
});

afterEach(async () => {
  for (const id of made.splice(0)) {
    await t.call('PATCH', `/webhooks/${id}`, { token: admin, body: { isActive: false } });
  }
});

afterAll(async () => {
  await worker?.close();
  await t?.call('PUT', '/settings/ai', { token: admin, body: {} });
  await t?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

describe('managing webhooks', () => {
  it('returns the signing secret once and keeps it out of every later answer', async () => {
    const hook = await subscribe(['ticket.created']);
    expect(hook.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(hook).toMatchObject({
      events: ['ticket.created'],
      scope: 'own',
      isActive: true,
      consecutiveFailures: 0,
      secretLast4: hook.secret.slice(-4),
    });

    const listed = await t.call('GET', `/integrations/${shop.id}/webhooks`, { token: admin });
    expect(JSON.stringify(listed.body)).not.toContain(hook.secret);
    const patched = await t.call<WebhookView>('PATCH', `/webhooks/${hook.id}`, {
      token: admin,
      body: { description: 'Storefront backend', events: ['ticket.created', 'message.created'] },
    });
    expect(patched.body).toMatchObject({
      description: 'Storefront backend',
      events: ['ticket.created', 'message.created'],
    });
    expect(JSON.stringify(patched.body)).not.toContain(hook.secret);

    const audit = await t.call<Array<{ action: string }>>('GET', '/audit', {
      token: admin,
      query: { targetType: 'integration', targetId: shop.id, limit: '50' },
    });
    expect(audit.body.map((a) => a.action)).toEqual(
      expect.arrayContaining(['integration.webhook_created', 'integration.webhook_updated']),
    );
    expect(JSON.stringify(audit.body)).not.toContain(hook.secret);

    expect((await t.call('DELETE', `/webhooks/${hook.id}`, { token: admin })).status).toBe(204);
    expect((await subscription(hook)) ?? null).toBeNull();
    made.length = 0;
  });

  it('only calls public https addresses, or hosts it was told to trust', async () => {
    const add = (url: string) =>
      t.call('POST', `/integrations/${shop.id}/webhooks`, {
        token: admin,
        body: { url, events: ['ticket.created'] },
      });
    const plain = await add('http://hooks.example.com/tms');
    expect(plain.status).toBe(400);
    expect(plain.body.message).toBe('Webhook addresses must use https');
    for (const url of ['https://10.0.0.5/hook', 'https://169.254.169.254/latest/meta-data']) {
      const res = await add(url);
      expect(res.status, url).toBe(400);
      expect(res.body.message).toBe('That address is not reachable from the public internet');
    }
    expect((await add('ftp://hooks.example.com/tms')).status).toBe(400);
    const trusted = await add(`${base}/ok`);
    expect(trusted.status).toBe(201);
    made.push(trusted.body.id);
    // Changing the address is checked the same way.
    const hook = await subscribe(['ticket.created']);
    const moved = await t.call('PATCH', `/webhooks/${hook.id}`, {
      token: admin,
      body: { url: 'https://192.168.1.10/hook' },
    });
    expect(moved.status).toBe(400);
  });

  it('is for administrators', async () => {
    const hook = await subscribe(['ticket.created']);
    for (const [method, url, body] of [
      ['GET', `/integrations/${shop.id}/webhooks`, undefined],
      [
        'POST',
        `/integrations/${shop.id}/webhooks`,
        { url: `${base}/x`, events: ['ticket.created'] },
      ],
      ['PATCH', `/webhooks/${hook.id}`, { isActive: false }],
      ['DELETE', `/webhooks/${hook.id}`, undefined],
      ['POST', `/webhooks/${hook.id}/rotate-secret`, undefined],
      ['POST', `/webhooks/${hook.id}/test`, undefined],
      ['GET', `/webhooks/${hook.id}/deliveries`, undefined],
    ] as const) {
      expect((await t.call(method, url, { token: supervisor.token, body })).status, url).toBe(403);
      expect((await t.call(method, url, { token: shop.key, body })).status, url).toBe(403);
    }
  });

  it('sends a signed test and says what came back', async () => {
    const hook = await subscribe(['ticket.created']);
    const ok = await t.call<WebhookTestResult>('POST', `/webhooks/${hook.id}/test`, {
      token: admin,
    });
    expect(ok.body).toMatchObject({ ok: true, httpStatus: 200, error: null });
    const [ping] = at(hook.path);
    expect(ping!.body).toMatchObject({ type: 'ping', integration: shop.slug });
    expect(ping!.headers['x-tms-event']).toBe('ping');
    expect(
      verifySignatureHeader(
        String(ping!.headers['x-tms-signature']),
        ping!.raw,
        hook.secret,
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(true);

    respond(hook.path, () => ({ status: 503 }));
    const down = await t.call<WebhookTestResult>('POST', `/webhooks/${hook.id}/test`, {
      token: admin,
    });
    expect(down.body).toMatchObject({ ok: false, httpStatus: 503, error: 'HTTP 503' });
    // A test is logged, is sent once, and does not count against the subscription.
    expect((await log(hook.id)).map((d) => [d.eventType, d.status, d.attempts])).toEqual([
      ['ping', 'failed', 1],
      ['ping', 'delivered', 1],
    ]);
    expect((await subscription(hook)).consecutiveFailures).toBe(0);
  });
});

describe('deliveries', () => {
  it('tells the integration about its own tickets, signed, with what its API would return', async () => {
    const hook = await subscribe(['ticket.created', 'message.created', 'ticket.status_changed']);
    const elsewhere = await subscribe(['ticket.created'], { integration: other });
    const ticket = await raise();

    const [created] = await arrived(hook.path, 'ticket.created');
    expect(created!.body).toMatchObject({
      type: 'ticket.created',
      integration: shop.slug,
      data: {
        ticket: {
          reference: ticket.reference,
          subject: 'The price on this listing looks wrong',
          externalRef: 'MYN-48213',
          status: { key: 'new', state: 'open' },
        },
      },
    });
    expect(created!.headers['content-type']).toBe('application/json');
    expect(created!.headers['user-agent']).toBe('TMS-Webhooks/1.0');
    expect(created!.headers['x-tms-event']).toBe('ticket.created');
    expect(created!.headers['x-tms-delivery']).toBe(created!.body.id);
    const now = Math.floor(Date.now() / 1000);
    const signature = String(created!.headers['x-tms-signature']);
    expect(verifySignatureHeader(signature, created!.raw, hook.secret, now)).toBe(true);
    expect(verifySignatureHeader(signature, created!.raw, elsewhere.secret, now)).toBe(false);

    const [first] = await arrived(hook.path, 'message.created');
    expect(first!.body.data).toMatchObject({
      ticket: { reference: ticket.reference },
      message: { from: 'customer', body: 'The site shows 1,499 but the store charges 1,799.' },
    });

    // An agent answers and solves it: the app hears both.
    const staff = await staffTicket(ticket.reference);
    const [conversation] = (
      await t.call('GET', `/tickets/${staff.id}/conversations`, { token: admin })
    ).body;
    await t.call('POST', `/conversations/${conversation.id}/messages`, {
      token: agent.token,
      body: { body: 'Thanks, we have corrected the price.' },
    });
    const replies = await arrived(hook.path, 'message.created', 2);
    expect(replies[1]!.body.data.message).toMatchObject({
      from: 'support',
      name: 'Maya',
      body: 'Thanks, we have corrected the price.',
    });
    await t.call('POST', `/tickets/${staff.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });
    const changes = await arrived(hook.path, 'ticket.status_changed', 2);
    expect(changes.map((c) => [c.body.data.from, c.body.data.to])).toEqual([
      ['new', 'in_progress'],
      ['in_progress', 'resolved'],
    ]);
    expect(changes[1]!.body.data.ticket.status).toMatchObject({ state: 'resolved' });

    // The other integration heard nothing of it, and nothing it did not ask for arrived.
    await settle();
    expect(at(elsewhere.path)).toEqual([]);
    expect(new Set(types(hook.path))).toEqual(
      new Set(['ticket.created', 'message.created', 'ticket.status_changed']),
    );

    // The log has outcomes and identifiers, never what was sent.
    const entries = await log(hook.id);
    expect(entries).toHaveLength(at(hook.path).length);
    expect(entries.every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
    expect(entries.every((d) => d.httpStatus === 200 && d.deliveredAt)).toBe(true);
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.subscriptionId, hook.id));
    expect(JSON.stringify(rows)).not.toMatch(/1,499|corrected the price|Asha/);
  });

  it('never tells about a draft, a note, or a ticket that is not its own', async () => {
    const hook = await subscribe(['ticket.created', 'message.created', 'ticket.updated']);
    const mine = await raise();
    await arrived(hook.path, 'message.created');
    const staff = await staffTicket(mine.reference);
    const [conversation] = (
      await t.call('GET', `/tickets/${staff.id}/conversations`, { token: admin })
    ).body;

    await t.call('POST', `/tickets/${staff.id}/notes`, {
      token: agent.token,
      body: { body: 'Internal: the catalogue team knows.' },
    });
    await t.app.get(ConversationsService).addMessage(db, {
      conversationId: conversation.id,
      channel: 'api',
      direction: 'outbound',
      authorType: 'ai',
      body: 'A draft nobody approved.',
      deliveryStatus: 'draft',
    });
    await raise(other.key);
    const customer = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Walk-in', email: `${uniq('walkin')}@customer.example` },
    });
    await t.call('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.body.id, subject: 'Raised by an agent' },
    });

    await settle();
    expect(types(hook.path).sort()).toEqual(['message.created', 'ticket.created']);
    expect(JSON.stringify(at(hook.path).map((r) => r.body))).not.toMatch(/Internal|draft/);
  });

  it('tells a subscription for the whole workspace about every ticket', async () => {
    const all = await subscribe(['ticket.created'], { scope: 'all' });
    const customer = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Walk-in', email: `${uniq('walkin')}@customer.example` },
    });
    const byStaff = await t.call<{ reference: string }>('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.body.id, subject: 'Raised by an agent' },
    });
    const theirs = await raise(other.key);
    const got = await arrived(all.path, 'ticket.created', 2);
    expect(got.map((r) => r.body.data.ticket.reference).sort()).toEqual(
      [byStaff.body.reference, theirs.reference].sort(),
    );
  });

  it('tells about incidents and ratings', async () => {
    const hook = await subscribe(['incident.opened', 'incident.resolved', 'csat.submitted']);
    const fingerprint = `scraper.run_failed:${uniq()}`;
    const report = (body: Record<string, unknown>) =>
      t.call('POST', '/integration/events', { token: shop.key, body: { fingerprint, ...body } });
    await report({ title: 'Scraper exited with code 1', severity: 'critical' });
    await report({ title: 'Scraper exited with code 1' });
    await report({ status: 'resolved' });

    const [opened] = await arrived(hook.path, 'incident.opened');
    expect(opened!.body.data.incident).toMatchObject({
      fingerprint,
      severity: 'critical',
      ticket: expect.stringMatching(/^TMS-\d+$/),
    });
    const [resolved] = await arrived(hook.path, 'incident.resolved');
    expect(resolved!.body.data.incident).toMatchObject({ status: 'resolved', occurrences: 2 });

    // The recovery resolved the ticket; the app passes on a rating for one of its own.
    const ticket = await raise();
    const staff = await staffTicket(ticket.reference);
    await t.call('POST', `/tickets/${staff.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });
    await t.call('POST', `/integration/tickets/${ticket.reference}/rating`, {
      token: shop.key,
      body: { rating: 5, comment: 'Fixed within the hour.' },
    });
    const [rated] = await arrived(hook.path, 'csat.submitted');
    expect(rated!.body.data).toMatchObject({
      ticket: { reference: ticket.reference },
      rating: { rating: 5, comment: 'Fixed within the hour.' },
    });
  });
});

describe('when the receiver fails', () => {
  it('tries again, and the log shows how often', async () => {
    const hook = await subscribe(['ticket.created']);
    respond(hook.path, (nth) => ({ status: nth < 3 ? 500 : 200 }));
    await raise();
    const attempts = await arrived(hook.path, 'ticket.created', 3);
    // Every attempt is the same delivery, signed afresh.
    expect(new Set(attempts.map((a) => a.body.id)).size).toBe(1);
    const entry = await waitFor(async () => {
      const [d] = await log(hook.id);
      return d?.status === 'delivered' ? d : undefined;
    }, 'the delivery to be marked delivered');
    expect(entry).toMatchObject({ attempts: 3, httpStatus: 200, error: null });
    expect((await subscription(hook)).consecutiveFailures).toBe(0);
  });

  it('refuses a redirect instead of following it', async () => {
    const hook = await subscribe(['ticket.created']);
    respond(hook.path, () => ({
      status: 302,
      location: 'http://169.254.169.254/latest/meta-data',
    }));
    await raise();
    const entry = await waitFor(async () => {
      const [d] = await log(hook.id);
      return d?.status === 'failed' ? d : undefined;
    }, 'the delivery to fail');
    expect(entry).toMatchObject({
      httpStatus: 302,
      error: 'The receiver answered with a redirect',
      attempts: 3,
    });
  });

  it('gives up after the last attempt, sends it again on request, and signs with a rotated secret', async () => {
    const hook = await subscribe(['ticket.created']);
    respond(hook.path, () => ({ status: 500 }));
    const ticket = await raise();
    const failed = await waitFor(async () => {
      const [d] = await log(hook.id);
      return d?.status === 'failed' ? d : undefined;
    }, 'the delivery to fail for good');
    expect(failed).toMatchObject({ attempts: 3, httpStatus: 500, error: 'HTTP 500' });
    // What the receiver answered is not kept.
    expect(JSON.stringify(failed)).not.toContain('internal details');
    expect((await subscription(hook)).consecutiveFailures).toBe(1);

    // The receiver is fixed and the secret rotated: a redelivery is a new, signed delivery.
    answer = () => ({ status: 200 });
    const rotated = await t.call<WebhookWithSecret>('POST', `/webhooks/${hook.id}/rotate-secret`, {
      token: admin,
    });
    expect(rotated.body.secret).not.toBe(hook.secret);
    const before = at(hook.path).length;
    const again = await t.call<WebhookDeliveryView>(
      'POST',
      `/webhooks/deliveries/${failed.id}/redeliver`,
      { token: admin },
    );
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ redeliveryOf: failed.id, status: 'pending' });
    const sent = await waitFor(() => at(hook.path)[before], 'the redelivery to arrive');
    expect(sent.body).toMatchObject({
      id: again.body.id,
      type: 'ticket.created',
      data: { ticket: { reference: ticket.reference } },
    });
    const now = Math.floor(Date.now() / 1000);
    const signature = String(sent.headers['x-tms-signature']);
    expect(verifySignatureHeader(signature, sent.raw, rotated.body.secret, now)).toBe(true);
    expect(verifySignatureHeader(signature, sent.raw, hook.secret, now)).toBe(false);
    await waitFor(
      async () => ((await subscription(hook)).consecutiveFailures === 0 ? true : undefined),
      'the success to reset the failure count',
    );
  });

  it('switches a subscription off when it keeps failing, and tells the admins', async () => {
    const hook = await subscribe(['ticket.created']);
    respond(hook.path, () => ({ status: 500 }));
    await raise();
    await raise();
    const off = await waitFor(async () => {
      const s = await subscription(hook);
      return s.isActive ? undefined : s;
    }, 'the subscription to be switched off');
    expect(off).toMatchObject({ isActive: false, consecutiveFailures: 2 });
    expect(off.disabledReason).toBe(
      'Switched off after 2 deliveries in a row failed. The last error: HTTP 500',
    );
    const notices = await waitFor(async () => {
      const res = await t.call<{ items: Array<{ kind: string; body: string }> }>(
        'GET',
        '/notifications',
        { token: admin },
      );
      const mine = res.body.items.filter((n) => n.kind === 'webhook.disabled');
      return mine.length ? mine : undefined;
    }, 'the admin to be told');
    expect(notices[0]!.body).toContain('127.0.0.1');

    // Nothing more is queued for it until a person switches it back on.
    const count = at(hook.path).length;
    await raise();
    await settle();
    expect(at(hook.path)).toHaveLength(count);

    answer = () => ({ status: 200 });
    const on = await t.call<WebhookView>('PATCH', `/webhooks/${hook.id}`, {
      token: admin,
      body: { isActive: true },
    });
    expect(on.body).toMatchObject({ isActive: true, consecutiveFailures: 0, disabledReason: null });
    await raise();
    await waitFor(() => at(hook.path)[count], 'deliveries to resume');
  });
});

describe('the delivery log', () => {
  it('is cleaned up by retention, except deliveries still waiting', async () => {
    const hook = await subscribe(['ticket.created']);
    await raise();
    await arrived(hook.path, 'ticket.created');
    await waitFor(
      async () => ((await log(hook.id))[0]?.status === 'delivered' ? true : undefined),
      'the delivery to be logged',
    );
    await db
      .update(webhookDeliveries)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(webhookDeliveries.subscriptionId, hook.id));
    const run = await t.call<{ deleted: { webhookDeliveries: number } }>(
      'POST',
      '/system/retention/run',
      { token: admin },
    );
    expect(run.body.deleted.webhookDeliveries).toBeGreaterThanOrEqual(1);
    expect(await log(hook.id)).toEqual([]);
  });
});
