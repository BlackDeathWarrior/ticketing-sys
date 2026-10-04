import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplicationContext } from '@nestjs/common';
import {
  DELIVERY_HEADER,
  parseWebhook,
  signChatIdentity,
  SIGNATURE_HEADER,
  TmsApiError,
  TmsClient,
  type Ticket,
  WebhookSignatureError,
} from '@tms/sdk';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';

process.env.WEBHOOK_PRIVATE_HOSTS = '127.0.0.1';

/**
 * The SDK (packages/sdk) against the real API: what the integration guide
 * tells a customer to write is what works. The app's own server is played
 * by a small HTTP server here.
 */
let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let tms: TmsClient;
let integration: { id: string; slug: string };
let webhookSecret: string;
let identitySecret: string;
let receiver: Server;
const deliveries: Array<{ headers: IncomingHttpHeaders; raw: string }> = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      deliveries.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));

  t = await startApp({ listen: true });
  worker = await startWorker();
  admin = await t.adminToken();
  await t.call('PUT', '/settings/ai', { token: admin, body: { channels: { api: 'off' } } });

  // What an admin does once in Settings → Integrations.
  const made = await t.call('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('sdk-'), name: 'Acme Store' },
  });
  integration = made.body;
  const key = await t.call('POST', `/integrations/${integration.id}/keys`, {
    token: admin,
    body: { name: 'Backend', scopes: ['integration:ticket', 'integration:event'] },
  });
  const hook = await t.call('POST', `/integrations/${integration.id}/webhooks`, {
    token: admin,
    body: {
      url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/support/webhook`,
      events: ['ticket.created', 'message.created', 'incident.resolved'],
    },
  });
  webhookSecret = hook.body.secret;
  identitySecret = (
    await t.call('POST', `/integrations/${integration.id}/chat-identity-secret`, { token: admin })
  ).body.secret;

  tms = new TmsClient({ baseUrl: t.baseUrl!, apiKey: key.body.key });
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await worker?.close();
  await t?.call('PUT', '/settings/ai', { token: admin, body: {} });
  await t?.close();
  await new Promise((resolve) => receiver.close(resolve));
});

/** Verified webhooks of one type, as the app's server would read them. */
const received = (type: string) =>
  deliveries
    .map((d) => parseWebhook(d.raw, String(d.headers[SIGNATURE_HEADER]), webhookSecret))
    .filter((p) => p.type === type);

describe('the SDK against the API', () => {
  let ticket: Ticket;
  const shopper = uniq('shopper-');

  it('knows who it is', async () => {
    expect(await tms.whoAmI()).toMatchObject({
      integration: { slug: integration.slug, name: 'Acme Store' },
      key: { name: 'Backend', scopes: ['integration:ticket', 'integration:event'] },
    });
  });

  it('raises a ticket once, however often the call is retried', async () => {
    const input = {
      customer: { externalId: shopper, name: 'Asha Verma' },
      subject: 'The price on this listing looks wrong',
      body: 'The site shows 1,499 but the store charges 1,799.',
      externalRef: 'MYN-48213',
      metadata: { source: 'Myntra', price_current: 1499 },
      tags: ['wrong-price'],
    };
    const idempotencyKey = uniq('report-key-');
    ticket = await tms.tickets.create(input, { idempotencyKey });
    const again = await tms.tickets.create(input, { idempotencyKey });
    expect(again.reference).toBe(ticket.reference);
    expect(ticket).toMatchObject({
      status: { state: 'open' },
      externalRef: 'MYN-48213',
      metadata: { source: 'Myntra', price_current: 1499 },
      customer: { name: 'Asha Verma' },
    });
    expect((await tms.tickets.list({ externalRef: 'MYN-48213' })).total).toBe(1);
  });

  it('adds follow-ups and reads the conversation', async () => {
    const sent = await tms.tickets.addMessage(ticket.reference, 'It is still wrong this morning.');
    expect(sent.from).toBe('customer');
    const all = await tms.tickets.messages(ticket.reference);
    expect(all.map((m) => m.body)).toEqual([
      'The site shows 1,499 but the store charges 1,799.',
      'It is still wrong this morning.',
    ]);
    expect(await tms.tickets.messages(ticket.reference, { after: all[0]!.createdAt })).toEqual([
      all[1],
    ]);
  });

  it('reports an incident and its recovery', async () => {
    const fingerprint = `scraper.run_failed:${uniq()}`;
    const opened = await tms.incidents.report({
      fingerprint,
      title: 'Scraper exited with code 1',
      severity: 'critical',
      source: 'scraper/worker',
    });
    expect(opened.action).toBe('opened');
    expect(
      (await tms.incidents.report({ fingerprint, title: 'Again' })).incident?.occurrences,
    ).toBe(2);
    expect((await tms.incidents.list({ status: 'open' })).map((i) => i.fingerprint)).toContain(
      fingerprint,
    );
    const resolved = await tms.incidents.resolve(fingerprint, 'Scrape finished.');
    expect(resolved).toMatchObject({ action: 'resolved', incident: { status: 'resolved' } });
    expect((await tms.incidents.resolve(fingerprint)).action).toBe('ignored');
  });

  it('passes on a rating once the ticket is solved', async () => {
    const staff = await t.call('GET', `/tickets/${ticket.reference}`, { token: admin });
    await t.call('POST', `/tickets/${staff.body.id}/transition`, {
      token: admin,
      body: { status: 'resolved' },
    });
    expect(await tms.tickets.rate(ticket.reference, 4, 'Sorted.')).toMatchObject({
      rating: 4,
      comment: 'Sorted.',
      source: 'api',
    });
    expect((await tms.tickets.get(ticket.reference)).status.state).toBe('resolved');
  });

  it('gets webhooks it can verify, and refuses forged ones', async () => {
    const created = await waitFor(() => {
      const mine = received('ticket.created').filter(
        (p) => (p.data.ticket as Ticket).reference === ticket.reference,
      );
      return mine.length ? mine : undefined;
    }, 'the ticket.created webhook');
    expect(created[0]).toMatchObject({ integration: integration.slug });
    await waitFor(
      () => (received('message.created').length >= 2 ? true : undefined),
      'the message webhooks',
    );
    await waitFor(
      () => (received('incident.resolved').length ? true : undefined),
      'the incident webhook',
    );
    // Each delivery names itself in a header and in the body.
    const first = deliveries[0]!;
    expect(first.headers[DELIVERY_HEADER]).toBe(JSON.parse(first.raw).id);

    const signature = String(first.headers[SIGNATURE_HEADER]);
    expect(() => parseWebhook(first.raw, signature, 'whsec_not_the_secret')).toThrow(
      WebhookSignatureError,
    );
    expect(() => parseWebhook(`${first.raw} `, signature, webhookSecret)).toThrow(
      WebhookSignatureError,
    );
  });

  it('vouches for a signed-in visitor, who is the customer its API calls name', async () => {
    const chat = io(`${t.baseUrl}/chat`, {
      transports: ['websocket'],
      forceNew: true,
      auth: {
        integration: integration.slug,
        identityToken: signChatIdentity({ sub: shopper, name: 'Asha Verma' }, identitySecret),
      },
    });
    sockets.push(chat);
    await new Promise<void>((resolve, reject) => {
      chat.once('session', () => resolve());
      chat.once('error', (e: { message: string }) => reject(new Error(e.message)));
    });
    const sent = await chat.emitWithAck('message', {
      text: 'Following up from my account page',
      clientMessageId: uniq('client-msg-'),
    });
    const viaChat = await t.call('GET', `/tickets/${sent.ticket.reference}`, { token: admin });
    const viaApi = await t.call('GET', `/tickets/${ticket.reference}`, { token: admin });
    expect(viaChat.body.customer.id).toBe(viaApi.body.customer.id);
    // And the chat is one of the integration's own tickets.
    expect((await tms.tickets.get(sent.ticket.reference)).subject).toMatch(/^Chat: /);
  });

  it('says why a call was refused', async () => {
    const missing = await tms.tickets.get('TMS-99999999').catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(TmsApiError);
    expect(missing).toMatchObject({ status: 404, message: 'Ticket not found' });

    const wrongKey = new TmsClient({ baseUrl: t.baseUrl!, apiKey: 'tms_sk_not-a-real-key' });
    await expect(wrongKey.whoAmI()).rejects.toMatchObject({
      status: 401,
      message: 'Invalid API key',
    });
    await expect(
      tms.tickets.create({ customer: { name: 'No ids' }, subject: 'x', body: 'y' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
