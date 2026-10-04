import { createHmac } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { type Database, phoneVerifications } from '@tms/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHATSAPP_WEBHOOK_QUEUE } from '../src/channels/whatsapp/whatsapp-webhook.queue';
import { DB } from '../src/infra/tokens';
import {
  eventsHandled,
  makeUser,
  startApp,
  startWorker,
  type TestClient,
  uniq,
  waitFor,
} from './helpers';
import { FAKE_LLM_BASE_URL } from './test-env';

/**
 * The WhatsApp adapter against the real webhook route, queue, worker and
 * sender. Meta itself is not reachable from tests, so calls to the Graph API
 * are answered here, inside the test process; everything else passes through.
 */
const GRAPH = 'https://graph.facebook.com';
const MEDIA_HOST = 'https://lookaside.fbsbx.com';
const PHONE_NUMBER_ID = '1055512345';
const WABA_ID = '2055512345';
const APP_SECRET = `test-app-secret-${uniq()}`;
const VERIFY_TOKEN = `test-verify-token-${uniq()}`;
const ACCESS_TOKEN = `test-access-token-${uniq()}`;
const BSUID = `US.${Date.now()}77001`;

interface GraphCall {
  method: string;
  path: string;
  auth: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are loosely typed
  body: any;
}
const graphCalls: GraphCall[] = [];
/** A test can answer a Graph call itself; returning undefined falls back to the defaults. */
let override: ((call: GraphCall) => Response | undefined) | undefined;
let wamid = 0;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const TEMPLATES = [
  {
    id: '9001',
    name: 'ticket_update',
    language: 'en_US',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hi {{1}}, we have an update on your request {{2}}.' },
      { type: 'FOOTER', text: 'Demo Store support' },
    ],
  },
  {
    id: '9002',
    name: 'spring_sale',
    language: 'en_US',
    status: 'PENDING',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Our spring sale starts today.' }],
  },
];

function answerGraph(call: GraphCall): Response {
  const custom = override?.(call);
  if (custom) return custom;
  if (call.method === 'POST' && call.path.endsWith(`/${PHONE_NUMBER_ID}/messages`)) {
    return json({
      messaging_product: 'whatsapp',
      messages: [{ id: `wamid.out.${uniq()}${wamid++}` }],
    });
  }
  if (call.path.includes('/message_templates')) return json({ data: TEMPLATES });
  if (call.method === 'POST' && call.path.endsWith('/subscribed_apps'))
    return json({ success: true });
  if (call.path.includes(`/${PHONE_NUMBER_ID}?fields=`)) {
    return json({
      id: PHONE_NUMBER_ID,
      display_phone_number: '+1 555 010 0199',
      verified_name: 'Demo Store',
      quality_rating: 'GREEN',
    });
  }
  if (call.path.includes('/media-')) {
    return json({
      url: `${MEDIA_HOST}/whatsapp_business/attachments/?mid=1`,
      mime_type: 'image/jpeg',
      file_size: 1200,
    });
  }
  return json({ error: { message: 'Unsupported request', code: 100 } }, 400);
}

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;

interface Msg {
  id: string;
  direction: string;
  authorType: string;
  body: string;
  channelMessageId: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  metadata: Record<string, unknown>;
}
interface Conv {
  id: string;
  channel: string;
  controller: string;
  metadata: Record<string, unknown>;
  messages: Msg[];
}
interface Ticket {
  id: string;
  subject: string;
  channel: string;
  customerId: string;
  status: string;
}

const sign = (raw: string, secret = APP_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** Posts a webhook exactly as Meta does: raw JSON plus its signature header. */
async function webhook(payload: unknown, opts: { signature?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const signature = opts.signature === undefined ? sign(raw) : opts.signature;
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/channels/whatsapp/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: raw,
  });
  return res.statusCode;
}

const change = (value: Record<string, unknown>, field = 'messages') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: WABA_ID,
      changes: [
        {
          field,
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550100199', phone_number_id: PHONE_NUMBER_ID },
            ...value,
          },
        },
      ],
    },
  ],
});

const seconds = (date = new Date()) => String(Math.floor(date.getTime() / 1000));
const newPhone = () => `1555${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 9)}`;

function textFrom(
  phone: string,
  body: string,
  opts: { id?: string; at?: Date; name?: string } = {},
) {
  const id = opts.id ?? `wamid.in.${uniq()}`;
  return {
    id,
    payload: change({
      contacts: [{ profile: { name: opts.name ?? 'Wanda WhatsApp' }, wa_id: phone }],
      messages: [{ from: phone, id, timestamp: seconds(opts.at), type: 'text', text: { body } }],
    }),
  };
}

const statusOf = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  change({ statuses: [{ id, status, timestamp: seconds(), recipient_id: '1', ...extra }] });

async function ticketsFor(q: string): Promise<Ticket[]> {
  const res = await t.call('GET', '/tickets', { token: admin, query: { q, channel: 'whatsapp' } });
  return res.body.items as Ticket[];
}
const conversations = async (ticketId: string) =>
  (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Conv[];

/** Sends a customer's first message and waits for its ticket. */
async function opened(phone: string, body: string, opts: { at?: Date; name?: string } = {}) {
  expect(await webhook(textFrom(phone, body, opts).payload)).toBe(200);
  const ticket = await waitFor(async () => (await ticketsFor(body))[0], `ticket for "${body}"`);
  const [conv] = await conversations(ticket.id);
  return { ticket, conv: conv! };
}

const outbound = async (ticketId: string, messageId: string) =>
  (await conversations(ticketId)).flatMap((c) => c.messages).find((m) => m.id === messageId)!;

const settled = (ticketId: string, messageId: string, status: string) =>
  waitFor(async () => {
    const m = await outbound(ticketId, messageId);
    return m.deliveryStatus === status ? m : undefined;
  }, `message ${status}`);

const messageSends = () =>
  graphCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/messages'));

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(MEDIA_HOST)) {
      return new Response(Buffer.alloc(1200, 7), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (!url.startsWith(GRAPH)) return realFetch(input, init);
    const headers = new Headers(init?.headers);
    const call: GraphCall = {
      method: init?.method ?? 'GET',
      path: url.slice(GRAPH.length),
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    graphCalls.push(call);
    return answerGraph(call);
  });

  t = await startApp();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Wren WhatsApp' });
}, 60_000);

afterAll(async () => {
  await worker?.close();
  for (const key of ['whatsapp.app_secret', 'whatsapp.verify_token', 'whatsapp.access_token']) {
    await t.call('DELETE', `/settings/secrets/${key}`, { token: admin });
  }
  await t.call('PUT', '/settings/channels/whatsapp', {
    token: admin,
    body: {
      enabled: false,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      graphVersion: 'v23.0',
    },
  });
  await t?.close();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  graphCalls.length = 0;
  override = undefined;
});

describe('before WhatsApp is set up', () => {
  it('rejects the handshake and every delivery', async () => {
    const verify = await t.call('GET', '/channels/whatsapp/webhook', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'anything', 'hub.challenge': '42' },
    });
    expect(verify.status).toBe(403);
    const raw = JSON.stringify(textFrom(newPhone(), 'hello').payload);
    // Signed with an empty key: must not pass when no secret is stored.
    expect(await webhook(JSON.parse(raw), { signature: sign(raw, '') })).toBe(401);
  });

  it('tells an agent that WhatsApp is not connected', async () => {
    const res = await t.call('POST', '/whatsapp/templates/sync', { token: admin });
    expect(res.status).toBe(400);
  });
});

describe('WhatsApp channel', () => {
  beforeAll(async () => {
    const saved = await t.call('PUT', '/settings/channels/whatsapp', {
      token: admin,
      body: {
        enabled: true,
        phoneNumberId: PHONE_NUMBER_ID,
        wabaId: WABA_ID,
        graphVersion: 'v23.0',
      },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    for (const [key, value] of [
      ['whatsapp.app_secret', APP_SECRET],
      ['whatsapp.verify_token', VERIFY_TOKEN],
      ['whatsapp.access_token', ACCESS_TOKEN],
    ]) {
      const res = await t.call('PUT', `/settings/secrets/${key}`, {
        token: admin,
        body: { value },
      });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(value);
    }
    // Started after the settings are saved, so the worker reads them fresh.
    worker = await startWorker();
  }, 60_000);

  it('answers the handshake only for the saved verify token', async () => {
    const ok = await t.app.inject({
      method: 'GET',
      url: '/api/v1/channels/whatsapp/webhook',
      query: {
        'hub.mode': 'subscribe',
        'hub.verify_token': VERIFY_TOKEN,
        'hub.challenge': '1158201444',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect(ok.headers['content-type']).toMatch(/text\/plain/);

    for (const query of [
      { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' },
      { 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1' },
    ]) {
      expect((await t.call('GET', '/channels/whatsapp/webhook', { query })).status).toBe(403);
    }
  });

  it('rejects unsigned, wrongly signed and tampered deliveries', async () => {
    const { payload } = textFrom(newPhone(), `Forged ${uniq()}`);
    const raw = JSON.stringify(payload);
    expect(await webhook(payload, { signature: null })).toBe(401);
    expect(await webhook(payload, { signature: sign(raw, 'someone-elses-secret') })).toBe(401);
    expect(await webhook({ ...payload, extra: true }, { signature: sign(raw) })).toBe(401);
    expect(await ticketsFor('Forged')).toHaveLength(0);
  });

  it('reports the connection, with the number and its quality', async () => {
    const res = await t.call('POST', '/settings/channels/whatsapp/test', { token: admin });
    expect(res.body.ok, JSON.stringify(res.body)).toBe(true);
    expect(res.body.detail).toMatch(/\+1 555 010 0199 \(Demo Store\), quality green/);
    expect(graphCalls.every((c) => c.auth === `Bearer ${ACCESS_TOKEN}`)).toBe(true);

    override = () => json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401);
    const bad = await t.call('POST', '/settings/channels/whatsapp/test', { token: admin });
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/rejected the WhatsApp access token/);
  });

  it('opens a ticket for a first message and threads the next one onto it', async () => {
    const phone = newPhone();
    const subject = `My cargo bike order is late ${uniq()}`;
    const { ticket, conv } = await opened(phone, subject, { name: 'Tariq Okafor' });
    expect(ticket.subject).toBe(`WhatsApp: ${subject}`);
    expect(ticket.channel).toBe('whatsapp');
    expect(conv.channel).toBe('whatsapp');
    expect(conv.metadata).toMatchObject({
      waPhone: phone,
      profileName: 'Tariq Okafor',
      phoneNumberId: PHONE_NUMBER_ID,
    });
    expect(conv.messages).toHaveLength(1);

    const customer = (await t.call('GET', `/customers/${ticket.customerId}`, { token: admin }))
      .body;
    expect(customer.displayName).toBe('Tariq Okafor');
    expect(customer.identities).toContainEqual(
      expect.objectContaining({ type: 'whatsapp', value: phone }),
    );

    const second = textFrom(phone, 'It was due on Monday.');
    expect(await webhook(second.payload)).toBe(200);
    // Meta redelivers when it doesn't hear back; the same message id is stored once.
    expect(await webhook({ ...second.payload, redelivery: 1 })).toBe(200);
    const after = await waitFor(async () => {
      const [c] = await conversations(ticket.id);
      return c!.messages.length >= 2 ? c! : undefined;
    }, 'second message');
    await eventsHandled(t, [WHATSAPP_WEBHOOK_QUEUE]);
    expect((await conversations(ticket.id))[0]!.messages).toHaveLength(2);
    expect(after.messages[1]!.body).toBe('It was due on Monday.');
    expect(await ticketsFor('It was due on Monday')).toHaveLength(0);
  });

  it("stores a customer's photo as an attachment", async () => {
    const phone = newPhone();
    const caption = `Cracked on arrival ${uniq()}`;
    const id = `wamid.in.${uniq()}`;
    const status = await webhook(
      change({
        contacts: [{ profile: { name: 'Ines Duarte' }, wa_id: phone }],
        messages: [
          {
            from: phone,
            id,
            timestamp: seconds(),
            type: 'image',
            image: { id: `media-${uniq()}`, mime_type: 'image/jpeg', caption },
          },
        ],
      }),
    );
    expect(status).toBe(200);
    const ticket = await waitFor(async () => (await ticketsFor(caption))[0], 'photo ticket');
    const [conv] = await conversations(ticket.id);
    const message = conv!.messages[0]!;
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({ contentType: 'image/jpeg', size: 1200 });
    expect(message.attachments[0]!.filename).toMatch(/^image-\d+\.jpg$/);

    const file = await t.app.inject({
      method: 'GET',
      url: `/api/v1/messages/${message.id}/attachments/0`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.length).toBe(1200);
  });

  it('keeps the message when its file cannot be fetched', async () => {
    override = (call) =>
      call.path.includes('/media-')
        ? json({ error: { message: 'Media not found', code: 131052 } }, 404)
        : undefined;
    const phone = newPhone();
    const id = `wamid.in.${uniq()}`;
    await webhook(
      change({
        contacts: [{ profile: { name: `Voice Note ${id}` }, wa_id: phone }],
        messages: [
          {
            from: phone,
            id,
            timestamp: seconds(),
            type: 'audio',
            audio: { id: `media-${uniq()}`, mime_type: 'audio/ogg; codecs=opus' },
          },
        ],
      }),
    );
    const ticket = await waitFor(async () => (await ticketsFor('[audio]'))[0], 'audio ticket');
    const [conv] = await conversations(ticket.id);
    expect(conv!.messages[0]!.body).toBe('[audio]');
    expect(conv!.messages[0]!.attachments).toHaveLength(0);
    expect(conv!.messages[0]!.metadata.waMediaError).toBeTruthy();
  });

  it('ignores reactions and other phone numbers on the same app', async () => {
    const phone = newPhone();
    const marker = uniq('elsewhere');
    await webhook(
      change({
        metadata: { display_phone_number: '15550100111', phone_number_id: '9999999999' },
        contacts: [{ profile: { name: 'Other Number' }, wa_id: phone }],
        messages: [
          {
            from: phone,
            id: `wamid.in.${uniq()}`,
            timestamp: seconds(),
            type: 'text',
            text: { body: marker },
          },
        ],
      }),
    );
    await webhook(
      change({
        contacts: [{ profile: { name: 'Reactor' }, wa_id: phone }],
        messages: [
          {
            from: phone,
            id: `wamid.in.${uniq()}`,
            timestamp: seconds(),
            type: 'reaction',
            reaction: { message_id: 'wamid.x', emoji: '👍' },
          },
        ],
      }),
    );
    // A later message from the same person proves the queue got past both.
    const { ticket } = await opened(phone, `After the reaction ${uniq()}`);
    expect((await conversations(ticket.id))[0]!.messages).toHaveLength(1);
    expect(await ticketsFor(marker)).toHaveLength(0);
  });

  it('sends an agent reply and follows it to delivered and read', async () => {
    const phone = newPhone();
    const { ticket, conv } = await opened(phone, `Where is my refund ${uniq()}`);
    const reply = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'Your refund was issued this morning.' },
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const sent = await settled(ticket.id, reply.body.id, 'sent');
    expect(sent.channelMessageId).toMatch(/^wamid\.out\./);

    const [send] = messageSends();
    expect(send!.path).toBe(`/v23.0/${PHONE_NUMBER_ID}/messages`);
    expect(send!.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(send!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: 'Your refund was issued this morning.' },
    });

    // Reports can arrive out of order: read first, then a late "delivered".
    const id = sent.channelMessageId!;
    await webhook(statusOf(id, 'read'));
    const read = await settled(ticket.id, reply.body.id, 'read');
    expect(read.metadata.readAt).toBeTruthy();
    await webhook(statusOf(id, 'delivered'));
    await webhook(statusOf(id, 'failed', { errors: [{ code: 131026, title: 'Undeliverable' }] }));
    const { ticket: marker } = await opened(newPhone(), `Queue marker ${uniq()}`);
    expect(marker.id).toBeTruthy();
    const still = await outbound(ticket.id, reply.body.id);
    expect(still.deliveryStatus).toBe('read');
    expect(still.deliveryError).toBeNull();

    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { targetId: ticket.id, action: 'message.read' },
    });
    expect(audit.body).toHaveLength(1);
  });

  it("shows Meta's reason when a sent message is not delivered", async () => {
    const { ticket, conv } = await opened(newPhone(), `Please call me ${uniq()}`);
    const reply = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'We will call you today.' },
    });
    const sent = await settled(ticket.id, reply.body.id, 'sent');
    await webhook(
      statusOf(sent.channelMessageId!, 'failed', {
        errors: [{ code: 131026, title: 'Message undeliverable' }],
      }),
    );
    const failed = await settled(ticket.id, reply.body.id, 'failed');
    expect(failed.deliveryError).toMatch(/could not deliver the message/);
  });

  it('fails at once on an error retrying cannot fix, and retries one it can', async () => {
    const { ticket, conv } = await opened(newPhone(), `Two failures ${uniq()}`);
    override = (call) =>
      call.path.endsWith('/messages')
        ? json({ error: { message: '(#131030) Recipient not in allowed list', code: 131030 } }, 400)
        : undefined;
    const blocked = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'First try.' },
    });
    const failed = await settled(ticket.id, blocked.body.id, 'failed');
    expect(failed.deliveryError).toMatch(/allowed list/);
    expect(messageSends()).toHaveLength(1);

    graphCalls.length = 0;
    let attempts = 0;
    override = (call) =>
      call.path.endsWith('/messages') && attempts++ === 0
        ? json({ error: { message: 'Service temporarily unavailable', code: 131016 } }, 503)
        : undefined;
    const flaky = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'Second try.' },
    });
    await settled(ticket.id, flaky.body.id, 'sent');
    expect(messageSends()).toHaveLength(2);
  });

  it('files a sender with only a user id, and replies to that id', async () => {
    const marker = `No phone number here ${uniq()}`;
    const message = (body: string, extra: Record<string, unknown> = {}) =>
      change({
        contacts: [
          { profile: { name: 'Sheena Nelson', username: 'realsheena' }, user_id: BSUID, ...extra },
        ],
        messages: [
          {
            from_user_id: BSUID,
            ...(extra.wa_id ? { from: extra.wa_id } : {}),
            id: `wamid.in.${uniq()}`,
            timestamp: seconds(),
            type: 'text',
            text: { body },
          },
        ],
      });
    await webhook(message(marker));
    const ticket = await waitFor(async () => (await ticketsFor(marker))[0], 'user-id ticket');
    const [conv] = await conversations(ticket.id);
    expect(conv!.metadata).toMatchObject({ waUserId: BSUID, waUsername: 'realsheena' });
    expect(conv!.metadata.waPhone ?? null).toBeNull();

    const reply = await t.call('POST', `/conversations/${conv!.id}/messages`, {
      token: agent.token,
      body: { body: 'Hello Sheena.' },
    });
    await settled(ticket.id, reply.body.id, 'sent');
    const [send] = messageSends();
    expect(send!.body.recipient).toBe(BSUID);
    expect(send!.body).not.toHaveProperty('to');

    // Meta later shows the phone number too: same customer, same ticket, and the phone is linked.
    const phone = newPhone();
    await webhook(message('Here is my number as well.', { wa_id: phone }));
    const grown = await waitFor(async () => {
      const [c] = await conversations(ticket.id);
      return c!.messages.filter((m) => m.direction === 'inbound').length === 2 ? c! : undefined;
    }, 'second user-id message');
    expect(grown.metadata).toMatchObject({ waUserId: BSUID, waPhone: phone });
    const customer = (await t.call('GET', `/customers/${ticket.customerId}`, { token: admin }))
      .body;
    expect(customer.identities.map((i: { type: string }) => i.type).sort()).toEqual([
      'whatsapp',
      'whatsapp_bsuid',
    ]);
  });

  describe('templates and the 24-hour window', () => {
    let templateId: string;

    it('syncs templates from Meta (admins only) and lists approved ones for agents', async () => {
      expect(
        (await t.call('POST', '/whatsapp/templates/sync', { token: agent.token })).status,
      ).toBe(403);
      const sync = await t.call('POST', '/whatsapp/templates/sync', { token: admin });
      expect(sync.status, JSON.stringify(sync.body)).toBe(200);
      expect(sync.body).toEqual({ total: 2, approved: 1, removed: 0 });
      expect(graphCalls.some((c) => c.path.includes(`/v23.0/${WABA_ID}/message_templates`))).toBe(
        true,
      );

      const approved = await t.call('GET', '/whatsapp/templates', { token: agent.token });
      expect(approved.body.map((x: { name: string }) => x.name)).toEqual(['ticket_update']);
      templateId = approved.body[0].id;
      const all = await t.call('GET', '/whatsapp/templates', {
        token: admin,
        query: { all: 'true' },
      });
      expect(all.body).toHaveLength(2);

      const audit = await t.call('GET', '/audit', {
        token: admin,
        query: { action: 'whatsapp.templates_synced' },
      });
      expect(audit.body.length).toBeGreaterThan(0);
    });

    it("follows Meta's template status changes", async () => {
      await webhook(
        change(
          {
            event: 'APPROVED',
            message_template_name: 'spring_sale',
            message_template_language: 'en_US',
          },
          'message_template_status_update',
        ),
      );
      await waitFor(async () => {
        const list = await t.call('GET', '/whatsapp/templates', { token: agent.token });
        return list.body.length === 2;
      }, 'template approved');
      await webhook(
        change(
          {
            event: 'PAUSED',
            message_template_name: 'spring_sale',
            message_template_language: 'en_US',
          },
          'message_template_status_update',
        ),
      );
      await waitFor(async () => {
        const list = await t.call('GET', '/whatsapp/templates', { token: agent.token });
        return list.body.length === 1;
      }, 'template paused');
    });

    it('refuses free text after 24 hours, and sends a template instead', async () => {
      const phone = newPhone();
      const yesterday = new Date(Date.now() - 25 * 3_600_000);
      const { ticket, conv } = await opened(phone, `Old question ${uniq()}`, { at: yesterday });

      const text = await t.call('POST', `/conversations/${conv.id}/messages`, {
        token: agent.token,
        body: { body: 'Sorry for the wait.' },
      });
      expect(text.status).toBe(409);
      expect(text.body.code).toBe('wa_window_closed');
      expect(messageSends()).toHaveLength(0);

      const missing = await t.call('POST', `/conversations/${conv.id}/whatsapp-template`, {
        token: agent.token,
        body: { templateId, body: ['Old'] },
      });
      expect(missing.status).toBe(400);
      expect(JSON.stringify(missing.body)).toMatch(/2 variable/);

      const sent = await t.call('POST', `/conversations/${conv.id}/whatsapp-template`, {
        token: agent.token,
        body: { templateId, body: ['Wanda', 'TMS-1'] },
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(201);
      expect(sent.body.body).toBe(
        'Hi Wanda, we have an update on your request TMS-1.\n\nDemo Store support',
      );
      await settled(ticket.id, sent.body.id, 'sent');
      const [send] = messageSends();
      expect(send!.body).toMatchObject({
        to: phone,
        type: 'template',
        template: {
          name: 'ticket_update',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Wanda' },
                { type: 'text', text: 'TMS-1' },
              ],
            },
          ],
        },
      });

      // The customer answers: the window is open again and free text goes through.
      await webhook(textFrom(phone, 'Thanks, what is the update?').payload);
      await waitFor(async () => {
        const [c] = await conversations(ticket.id);
        return c!.messages.length === 3;
      }, 'customer answer');
      const again = await t.call('POST', `/conversations/${conv.id}/messages`, {
        token: agent.token,
        body: { body: 'Your replacement ships tomorrow.' },
      });
      expect(again.status).toBe(201);
    });

    it('refuses a template Meta has not approved', async () => {
      const { conv } = await opened(newPhone(), `Template checks ${uniq()}`);
      const all = await t.call('GET', '/whatsapp/templates', {
        token: admin,
        query: { all: 'true' },
      });
      const paused = all.body.find((x: { name: string }) => x.name === 'spring_sale');
      const res = await t.call('POST', `/conversations/${conv.id}/whatsapp-template`, {
        token: agent.token,
        body: { templateId: paused.id },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/not approved/);
    });

    it('starts a WhatsApp conversation on a ticket with a template', async () => {
      const phone = newPhone();
      const customer = await t.call('POST', '/customers', {
        token: admin,
        body: { displayName: 'Ravi Menon', phone: `+${phone}` },
      });
      const made = await t.call('POST', '/tickets', {
        token: admin,
        body: {
          customerId: customer.body.id,
          subject: `Callback about bulk order ${uniq()}`,
          description: 'Asked by phone to be contacted on WhatsApp.',
          channel: 'whatsapp',
        },
      });
      expect(made.status).toBe(201);
      const started = await t.call('POST', `/tickets/${made.body.id}/conversations`, {
        token: agent.token,
        body: {
          channel: 'whatsapp',
          template: { templateId, body: ['Ravi', made.body.reference] },
        },
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      await settled(made.body.id, started.body.id, 'sent');
      expect(messageSends()[0]!.body).toMatchObject({ to: phone, type: 'template' });

      // The customer's reply lands on the same ticket.
      await webhook(textFrom(phone, 'Yes, I am here.', { name: 'Ravi Menon' }).payload);
      await waitFor(async () => {
        const [c] = await conversations(made.body.id);
        return c?.messages.length === 2;
      }, 'reply on the started conversation');

      const noNumber = await t.call('POST', '/customers', {
        token: admin,
        body: { displayName: 'No Phone', email: `${uniq('nophone')}@example.com` },
      });
      const other = await t.call('POST', '/tickets', {
        token: admin,
        body: { customerId: noNumber.body.id, subject: 'No number', description: 'x' },
      });
      const refused = await t.call('POST', `/tickets/${other.body.id}/conversations`, {
        token: agent.token,
        body: { channel: 'whatsapp', template: { templateId, body: ['A', 'B'] } },
      });
      expect(refused.status).toBe(400);
    });

    it('subscribes the business account to the app (admins only)', async () => {
      expect((await t.call('POST', '/whatsapp/subscribe', { token: agent.token })).status).toBe(
        403,
      );
      const res = await t.call('POST', '/whatsapp/subscribe', { token: admin });
      expect(res.status).toBe(200);
      expect(graphCalls).toContainEqual(
        expect.objectContaining({ method: 'POST', path: `/v23.0/${WABA_ID}/subscribed_apps` }),
      );
    });
  });

  describe('proving a phone number with a code (ADR 0034)', () => {
    let shop: { id: string; slug: string };
    let key: string;
    let ticketsOnly: string;
    let otherApp: string;

    interface Person {
      externalId: string;
      name: string;
      email: string;
    }
    const person = (): Person => ({
      externalId: uniq('user-'),
      name: 'Pia Phone',
      email: `${uniq('pia')}@example.com`,
    });
    const start = (phone: string, customer: Person, token = key) =>
      t.call('POST', '/integration/customers/phone-verifications', {
        token,
        body: { customer, phone },
      });
    const check = (phone: string, customer: Person, code: string, token = key) =>
      t.call('POST', '/integration/customers/phone-verifications/check', {
        token,
        body: { customer, phone, code },
      });
    /** The code in the last message Meta was asked to send to `phone`. */
    const codeSentTo = (phone: string) => {
      const sent = messageSends()
        .filter((c) => c.body.to === phone)
        .at(-1)!;
      return /^(\d{6}) is your/.exec(sent.body.text.body as string)![1]!;
    };
    const not = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
    /** A number that has written to the business: no template is synced, so only it may get a code. */
    const writer = async () => {
      const phone = newPhone();
      await opened(phone, `Hello ${uniq()}`);
      return phone;
    };
    /** A code on its way to a number that may get one. */
    const sent = async () => {
      const phone = await writer();
      const who = person();
      const res = await start(phone, who);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return { phone, who, code: codeSentTo(phone), expiresAt: res.body.expiresAt as string };
    };

    beforeAll(async () => {
      const app = async (scopes: string[]) => {
        const made = await t.call('POST', '/integrations', {
          token: admin,
          body: { slug: uniq('wa-app-'), name: 'Phone app' },
        });
        const k = await t.call('POST', `/integrations/${made.body.id}/keys`, {
          token: admin,
          body: { name: 'Server', scopes },
        });
        return { app: made.body as { id: string; slug: string }, key: k.body.key as string };
      };
      const mine = await app(['integration:customer']);
      shop = mine.app;
      key = mine.key;
      otherApp = (await app(['integration:customer'])).key;
      const k = await t.call('POST', `/integrations/${shop.id}/keys`, {
        token: admin,
        body: { name: 'Tickets only', scopes: ['integration:ticket'] },
      });
      ticketsOnly = k.body.key;
    });

    it('is refused to a key without the customer scope', async () => {
      expect((await start(newPhone(), person(), ticketsOnly)).status).toBe(403);
    });

    it('sends nothing to a number that has not written, while no template exists', async () => {
      const phone = newPhone();
      const who = person();
      const before = messageSends().length;
      expect((await start(phone, who)).status).toBe(409);
      expect(messageSends()).toHaveLength(before);
      // Nothing was stored either: there is no code to guess at.
      const guess = await check(phone, who, '123456');
      expect(guess.status).toBe(400);
      expect(guess.body.reason).toBe('no-code');
    });

    it('links the number once the customer types the code, and the code works once', async () => {
      const { phone, who, code, expiresAt } = await sent();
      const minutes = (new Date(expiresAt).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(9);
      expect(minutes).toBeLessThanOrEqual(10);

      const wrong = await check(phone, who, not(code));
      expect(wrong.status).toBe(400);
      expect(wrong.body.reason).toBe('wrong-code');

      const right = await check(phone, who, code);
      expect(right.status, JSON.stringify(right.body)).toBe(200);
      expect(right.body).toEqual({ verified: true, phone });
      const again = await check(phone, who, code);
      expect(again.body.reason).toBe('no-code');

      // The customer the app named now holds the number and the email, both verified.
      const found = (await t.call('GET', '/customers', { token: admin, query: { q: who.email } }))
        .body.items as Array<{ id: string }>;
      const customer = (await t.call('GET', `/customers/${found[0]!.id}`, { token: admin })).body;
      expect(customer.identities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'phone', value: phone, verified: true }),
          expect.objectContaining({ type: 'email', value: who.email, verified: true }),
          expect.objectContaining({ type: 'external_id', value: `${shop.slug}:${who.externalId}` }),
        ]),
      );

      // The code itself is in no audit entry.
      const audit = await t.call('GET', '/audit', {
        token: admin,
        query: { action: 'customer.phone_verification_sent', targetId: shop.id },
      });
      expect(audit.body.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit.body)).not.toContain(code);
    });

    it('stops after five wrong tries, even for the right code', async () => {
      const { phone, who, code } = await sent();
      for (let i = 0; i < 5; i++) {
        expect((await check(phone, who, not(code))).body.reason).toBe('wrong-code');
      }
      const locked = await check(phone, who, code);
      expect(locked.status).toBe(400);
      expect(locked.body.reason).toBe('too-many-attempts');
    });

    it('sends a number one code a minute, whatever the rate limit setting', async () => {
      const { phone, who } = await sent();
      const second = await start(phone, who);
      expect(second.status).toBe(429);
    });

    it('refuses a code after its ten minutes', async () => {
      const { phone, who, code } = await sent();
      await t.app
        .get<Database>(DB)
        .update(phoneVerifications)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(phoneVerifications.phone, phone));
      const late = await check(phone, who, code);
      expect(late.status).toBe(400);
      expect(late.body.reason).toBe('expired');
    });

    it('keeps a code to the app that asked for it', async () => {
      const { phone, who, code } = await sent();
      expect((await check(phone, who, code, otherApp)).body.reason).toBe('no-code');
      expect((await check(phone, who, code)).status).toBe(200);
    });
  });

  describe('with the AI agent', () => {
    let providerId: string;

    beforeAll(async () => {
      const p = await t.call('POST', '/settings/llm/providers', {
        token: admin,
        body: {
          provider: 'openai_compatible',
          label: `WhatsApp fake ${uniq()}`,
          apiKey: 'fake-whatsapp-key-000',
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
      const faq = await t.call('POST', '/kb/documents', {
        token: admin,
        body: {
          source: 'faq',
          title: 'When will my refund reach my card?',
          content: 'Refunds reach your card 5 to 7 business days after we receive the return.',
          visibility: 'public',
        },
      });
      await waitFor(
        async () =>
          (await t.call('GET', `/kb/documents/${faq.body.id}`, { token: admin })).body
            .indexState === 'indexed'
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
      if (providerId) {
        await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
      }
    });

    it('answers on WhatsApp by itself, and the answer is sent through Meta', async () => {
      const phone = newPhone();
      const question = 'When will my refund reach my card? I returned the helmet last week.';
      await webhook(textFrom(phone, question, { name: `Refund ${uniq()}` }).payload);
      const answered = await waitFor(
        async () => {
          const found = (await ticketsFor('refund reach my card')).slice(0, 5);
          for (const ticket of found) {
            const [c] = await conversations(ticket.id);
            const ai =
              c?.metadata.waPhone === phone && c.messages.find((m) => m.authorType === 'ai');
            if (ai && ai.deliveryStatus === 'sent') return { ticket, conv: c!, ai };
          }
          return undefined;
        },
        'AI answer sent',
        30_000,
      );
      expect(answered.conv.controller).toBe('ai');
      expect(answered.ai.body).toMatch(/5 to 7 business days/);
      expect(answered.ai.channelMessageId).toMatch(/^wamid\.out\./);
      const send = messageSends().find((c) => c.body.to === phone);
      expect(send!.body.text.body).toBe(answered.ai.body);
    });
  });

  it('fails a reply at once when the access token is gone', async () => {
    const { ticket, conv } = await opened(newPhone(), `Token removed ${uniq()}`);
    const queued = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'Queued before the token was removed.' },
    });
    await settled(ticket.id, queued.body.id, 'sent');

    await t.call('DELETE', '/settings/secrets/whatsapp.access_token', { token: admin });
    const refused = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: agent.token,
      body: { body: 'This cannot go out.' },
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/not connected/);
  });
});
