import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CheckPhoneVerificationInput,
  EventAction,
  IncidentView,
  IntegrationIdentity,
  IntegrationMessageView,
  IntegrationTicketView,
  PhoneVerificationChecked as SharedPhoneVerificationChecked,
  PhoneVerificationStarted as SharedPhoneVerificationStarted,
  StartPhoneVerificationInput,
  WebhookEventType as SharedWebhookEventType,
  WebhookPayload as SharedWebhookPayload,
} from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  type CheckPhoneVerification,
  type EventResult,
  type Identity,
  type Incident,
  type Message,
  parseWebhook,
  type PhoneVerificationChecked,
  type PhoneVerificationStarted,
  signChatIdentity,
  signWebhook,
  type StartPhoneVerification,
  type Ticket,
  TmsApiError,
  TmsClient,
  verifyWebhookSignature,
  type WebhookEventType,
  type WebhookPayload,
  WebhookSignatureError,
} from './index';

interface Vectors {
  webhook: Array<{ name: string; secret: string; timestamp: number; body: string; header: string }>;
  identity: {
    secret: string;
    claims: { sub: string; name: string; email: string };
    issuedAt: number;
    ttlSeconds: number;
    token: string;
  };
}
/** The same file the Python client's tests read: one contract for every language. */
const vectors = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../docs/integration/signature-vectors.json'), 'utf8'),
) as Vectors;

describe('webhook signatures', () => {
  it.each(vectors.webhook)('signs $name as TMS does', (v) => {
    expect(signWebhook(v.body, v.secret, v.timestamp)).toBe(v.header);
    expect(verifyWebhookSignature(v.body, v.header, v.secret, { nowSeconds: v.timestamp })).toBe(
      true,
    );
    expect(
      verifyWebhookSignature(Buffer.from(v.body, 'utf8'), v.header, v.secret, {
        nowSeconds: v.timestamp + 60,
      }),
    ).toBe(true);
  });

  it('refuses anything that is not exactly what TMS sent', () => {
    const v = vectors.webhook[0]!;
    const at = { nowSeconds: v.timestamp };
    expect(verifyWebhookSignature(`${v.body} `, v.header, v.secret, at)).toBe(false);
    expect(verifyWebhookSignature(v.body, v.header, 'another-secret', at)).toBe(false);
    expect(verifyWebhookSignature(v.body, undefined, v.secret, at)).toBe(false);
    expect(verifyWebhookSignature(v.body, 'v1=abc', v.secret, at)).toBe(false);
    // Too old to be a fresh delivery: a replay.
    expect(
      verifyWebhookSignature(v.body, v.header, v.secret, { nowSeconds: v.timestamp + 301 }),
    ).toBe(false);
  });

  it('parses a verified webhook and throws on a forged one', () => {
    const v = vectors.webhook[0]!;
    const payload = parseWebhook(v.body, v.header, v.secret, { nowSeconds: v.timestamp });
    expect(payload).toEqual({ id: 'd1', type: 'ticket.created' });
    expect(() => parseWebhook(v.body, v.header, 'wrong', { nowSeconds: v.timestamp })).toThrow(
      WebhookSignatureError,
    );
  });
});

describe('chat identity tokens', () => {
  it('signs the token TMS verifies', () => {
    const v = vectors.identity;
    const token = signChatIdentity(v.claims, v.secret, {
      nowSeconds: v.issuedAt,
      ttlSeconds: v.ttlSeconds,
    });
    expect(token).toBe(v.token);

    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
      ...v.claims,
      iat: v.issuedAt,
      exp: v.issuedAt + v.ttlSeconds,
    });
    expect(signature).toBe(
      createHmac('sha256', v.secret).update(`${header}.${payload}`).digest('base64url'),
    );
  });

  it('needs someone to vouch for', () => {
    expect(() => signChatIdentity({ name: 'Nobody' }, 'secret')).toThrow(/sub or an email/);
  });
});

describe('the client', () => {
  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }
  /** A `fetch` that records the request and answers what the test says. */
  function stub(answer: { status?: number; body?: unknown; headers?: Record<string, string> }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: answer.headers,
      });
    }) as typeof fetch;
    const client = new TmsClient({
      baseUrl: 'https://support.example.com/',
      apiKey: 'tms_sk_test',
      fetch: fetchImpl,
    });
    return { client, calls };
  }

  it('raises a ticket with the key and an idempotency key', async () => {
    const { client, calls } = stub({ status: 201, body: { reference: 'TMS-7' } });
    const ticket = await client.tickets.create(
      {
        customer: { externalId: 'shopper-42' },
        subject: 'Wrong price',
        body: 'The listing shows the wrong price.',
        externalRef: 'MYN-48213',
      },
      { idempotencyKey: 'report-0001' },
    );
    expect(ticket.reference).toBe('TMS-7');
    expect(calls).toEqual([
      {
        url: 'https://support.example.com/api/v1/integration/tickets',
        method: 'POST',
        headers: {
          authorization: 'Bearer tms_sk_test',
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': 'report-0001',
        },
        body: {
          customer: { externalId: 'shopper-42' },
          subject: 'Wrong price',
          body: 'The listing shows the wrong price.',
          externalRef: 'MYN-48213',
        },
      },
    ]);
  });

  it('builds the other requests', async () => {
    const { client, calls } = stub({ body: [] });
    await client.whoAmI();
    await client.tickets.get('TMS-7');
    await client.tickets.list({ externalRef: 'MYN 1', state: 'open', limit: 5 });
    await client.tickets.messages('TMS-7', { after: '2026-10-01T10:00:00.000Z' });
    await client.tickets.addMessage('TMS-7', 'Still wrong');
    await client.tickets.rate('TMS-7', 5, 'Thanks');
    await client.incidents.report({ fingerprint: 'job.failed', title: 'Job failed' });
    await client.incidents.resolve('job.failed', 'Fine again');
    await client.incidents.list({ status: 'open' });
    expect(
      calls.map((c) => `${c.method} ${c.url.replace('https://support.example.com', '')}`),
    ).toEqual([
      'GET /api/v1/integration',
      'GET /api/v1/integration/tickets/TMS-7',
      'GET /api/v1/integration/tickets?externalRef=MYN%201&state=open&limit=5',
      'GET /api/v1/integration/tickets/TMS-7/messages?after=2026-10-01T10%3A00%3A00.000Z',
      'POST /api/v1/integration/tickets/TMS-7/messages',
      'POST /api/v1/integration/tickets/TMS-7/rating',
      'POST /api/v1/integration/events',
      'POST /api/v1/integration/events',
      'GET /api/v1/integration/incidents?status=open',
    ]);
    expect(calls[4]!.body).toEqual({ body: 'Still wrong' });
    expect(calls[5]!.body).toEqual({ rating: 5, comment: 'Thanks' });
    expect(calls[6]!.body).toEqual({
      fingerprint: 'job.failed',
      title: 'Job failed',
      status: 'firing',
    });
    expect(calls[7]!.body).toEqual({
      fingerprint: 'job.failed',
      status: 'resolved',
      message: 'Fine again',
    });
  });

  it('turns a refusal into an error that says why and when to retry', async () => {
    const { client } = stub({
      status: 429,
      body: { statusCode: 429, message: 'Too many requests. Try again in 12 seconds.' },
      headers: { 'retry-after': '12' },
    });
    const err = await client.whoAmI().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TmsApiError);
    expect(err).toMatchObject({
      status: 429,
      message: 'Too many requests. Try again in 12 seconds.',
      retryAfter: 12,
    });

    const { client: gone } = stub({ status: 404, body: { message: 'Ticket not found' } });
    await expect(gone.tickets.get('TMS-1')).rejects.toMatchObject({
      status: 404,
      retryAfter: null,
    });
  });
});

describe('the types', () => {
  it('are the API’s own', () => {
    // Compile-time only: each SDK type and its @tms/shared contract accept each other.
    const both = <A, B extends A>(_a?: A, _b?: B) => true;
    expect(
      [
        both<Ticket, IntegrationTicketView>(),
        both<IntegrationTicketView, Ticket>(),
        both<Message, IntegrationMessageView>(),
        both<IntegrationMessageView, Message>(),
        both<Incident, IncidentView>(),
        both<IncidentView, Incident>(),
        both<Identity, IntegrationIdentity>(),
        both<EventResult['action'], EventAction>(),
        both<EventAction, EventResult['action']>(),
        both<PhoneVerificationStarted, SharedPhoneVerificationStarted>(),
        both<SharedPhoneVerificationStarted, PhoneVerificationStarted>(),
        both<PhoneVerificationChecked, SharedPhoneVerificationChecked>(),
        both<SharedPhoneVerificationChecked, PhoneVerificationChecked>(),
        both<StartPhoneVerification, StartPhoneVerificationInput>(),
        both<StartPhoneVerificationInput, StartPhoneVerification>(),
        both<CheckPhoneVerification, CheckPhoneVerificationInput>(),
        both<CheckPhoneVerificationInput, CheckPhoneVerification>(),
        both<WebhookEventType, SharedWebhookEventType>(),
        both<SharedWebhookEventType, WebhookEventType>(),
        both<WebhookPayload, SharedWebhookPayload>(),
        both<SharedWebhookPayload, WebhookPayload>(),
      ].every(Boolean),
    ).toBe(true);
  });
});
