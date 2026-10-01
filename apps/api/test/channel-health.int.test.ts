import { createHmac } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { ChannelHealth, HealthCheck, WhatsappConnectResult } from '@tms/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelHealthMonitor } from '../src/channels/health/channel-health.monitor';
import type { Env } from '../src/config/env';
import { ENV } from '../src/infra/tokens';
import { ChannelSignalsService } from '../src/settings/channel-signals.service';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { applyEmailEnv } from './test-env';

/**
 * The channel status lights and the one-step WhatsApp connect. Email runs
 * against GreenMail; Meta's answers are supplied inside the test process, as
 * in whatsapp.int.test.ts.
 */
applyEmailEnv();

const GRAPH = 'https://graph.facebook.com';
const PHONE_NUMBER_ID = '1055577001';
const WABA_ID = '2055577001';
const APP_SECRET = `health-app-secret-${uniq()}`;
const VERIFY_TOKEN = `health-verify-token-${uniq()}`;
const ACCESS_TOKEN = `health-access-token-${uniq()}`;

interface GraphCall {
  method: string;
  path: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request bodies are loosely typed
  body: any;
}
const graphCalls: GraphCall[] = [];
let override: ((call: GraphCall) => Response | undefined) | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const metaError = (code: number, message: string, status = 400) =>
  json({ error: { message, code, type: 'OAuthException' } }, status);

function answerGraph(call: GraphCall): Response {
  const custom = override?.(call);
  if (custom) return custom;
  if (call.path.includes(`/${PHONE_NUMBER_ID}?fields=`)) {
    return json({
      id: PHONE_NUMBER_ID,
      display_phone_number: '+1 555 010 0142',
      verified_name: 'Demo Store',
      quality_rating: 'GREEN',
    });
  }
  if (call.path.includes(`/${WABA_ID}/phone_numbers`)) {
    return json({ data: [{ id: PHONE_NUMBER_ID, display_phone_number: '+1 555 010 0142' }] });
  }
  if (call.path.endsWith(`/${WABA_ID}/subscribed_apps`)) {
    return call.method === 'POST'
      ? json({ success: true })
      : json({ data: [{ whatsapp_business_api_data: { id: '77', name: 'TMS' } }] });
  }
  if (call.method === 'POST' && call.path.endsWith('/register')) return json({ success: true });
  if (call.method === 'POST' && call.path.endsWith('/messages')) {
    return json({ messages: [{ id: `wamid.health.${uniq()}` }] });
  }
  return metaError(100, 'Unsupported request');
}

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let signals: ChannelSignalsService;

const health = async (token = admin) =>
  (await t.call<ChannelHealth[]>('GET', '/channels/health', { token })).body;
const light = async (channel: string) => (await health()).find((h) => h.channel === channel)!;
const checkOf = (h: { checks: HealthCheck[] }, key: string) => h.checks.find((c) => c.key === key);
const recheck = async () =>
  (await t.call<ChannelHealth[]>('POST', '/channels/health/check', { token: admin })).body;

const connect = (body: Record<string, unknown>, token = admin) =>
  t.call<WhatsappConnectResult>('POST', '/whatsapp/connect', { token, body });
const whatsappView = async () =>
  (await t.call('GET', '/settings/channels/whatsapp', { token: admin })).body as {
    config: { enabled: boolean; phoneNumberId: string } | null;
    secrets: Array<{ key: string; set: boolean; last4: string | null }>;
  };

beforeAll(async () => {
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(GRAPH)) return realFetch(input, init);
    const call: GraphCall = {
      method: init?.method ?? 'GET',
      path: url.slice(GRAPH.length),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    graphCalls.push(call);
    return answerGraph(call);
  });

  t = await startApp();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Hal Health' });
  signals = t.app.get(ChannelSignalsService);
  // Start from a clean slate, whatever earlier test files left behind.
  for (const key of ['whatsapp.app_secret', 'whatsapp.verify_token', 'whatsapp.access_token']) {
    await t.call('DELETE', `/settings/secrets/${key}`, { token: admin });
  }
  for (const field of ['probe', 'webhookAt', 'handshakeAt'] as const) {
    await signals.clear('whatsapp', field);
  }
  await signals.clear('email', 'probe');
  await signals.clear('email', 'poller');
  worker = await startWorker();
}, 60_000);

afterAll(async () => {
  await worker?.close();
  for (const key of ['whatsapp.app_secret', 'whatsapp.verify_token', 'whatsapp.access_token']) {
    await t.call('DELETE', `/settings/secrets/${key}`, { token: admin });
  }
  const view = await whatsappView();
  if (view.config) {
    await t.call('PUT', '/settings/channels/whatsapp', {
      token: admin,
      body: { ...view.config, enabled: false },
    });
  }
  await t?.close();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  graphCalls.length = 0;
  override = undefined;
});

describe('channel status lights', () => {
  it('are for people who manage channels', async () => {
    expect((await t.call('GET', '/channels/health', { token: agent.token })).status).toBe(403);
    expect((await t.call('POST', '/channels/health/check', { token: agent.token })).status).toBe(
      403,
    );
    expect((await t.call('GET', '/channels/health')).status).toBe(401);
  });

  it('show every channel, with web chat working', async () => {
    const all = await waitFor(async () => {
      const list = await health();
      return list.find((h) => h.channel === 'webchat')?.state === 'ok' ? list : undefined;
    }, 'worker heartbeat');
    expect(all.map((h) => h.channel)).toEqual([
      'email',
      'whatsapp',
      'webchat',
      'web_form',
      'voice',
    ]);

    const chat = all.find((h) => h.channel === 'webchat')!;
    expect(chat.summary).toMatch(/^Accepting chats/);
    expect(checkOf(chat, 'worker')).toMatchObject({ state: 'ok', detail: 'Running' });

    // Voice has no key in this test, so it is off (or says the key is missing).
    expect(['off', 'down']).toContain(all.find((h) => h.channel === 'voice')!.state);
    expect(all.find((h) => h.channel === 'whatsapp')!.state).toBe('off');
  });

  it('turn green for email once the mailbox is watched and the mail server answers', async () => {
    const email = await waitFor(async () => {
      const h = (await recheck()).find((x) => x.channel === 'email')!;
      return checkOf(h, 'imap')?.state === 'ok' && checkOf(h, 'smtp')?.state === 'ok'
        ? h
        : undefined;
    }, 'email reading and sending');
    expect(checkOf(email, 'imap')?.detail).toBe('Watching support@tms.local for new mail');
    expect(email.checkedAt).toBeTruthy();
    // Other test files may have left failed emails behind; that alone would make it amber.
    if (checkOf(email, 'deliveries')?.state === 'ok') {
      expect(email).toMatchObject({
        state: 'ok',
        summary: 'Reading and sending as support@tms.local',
      });
      expect((await light('web_form')).state).toBe('ok');
    }
  });

  it('turn red for email when the mail server refuses us, and say which half', async () => {
    const env = t.app.get<Env>(ENV);
    const port = env.EMAIL_SMTP_PORT;
    env.EMAIL_SMTP_PORT = 1;
    try {
      const email = (await recheck()).find((h) => h.channel === 'email')!;
      expect(email.state).toBe('down');
      expect(checkOf(email, 'smtp')?.state).toBe('down');
      expect(checkOf(email, 'smtp')?.detail).toBeTruthy();
      expect(checkOf(email, 'imap')?.state).toBe('ok');
      expect((await light('web_form')).state).toBe('down');
    } finally {
      env.EMAIL_SMTP_PORT = port;
    }
    const back = (await recheck()).find((h) => h.channel === 'email')!;
    expect(checkOf(back, 'smtp')?.state).toBe('ok');
  });
});

describe('Connect WhatsApp', () => {
  const details = {
    phoneNumberId: PHONE_NUMBER_ID,
    wabaId: WABA_ID,
    accessToken: ACCESS_TOKEN,
    appSecret: APP_SECRET,
    verifyToken: VERIFY_TOKEN,
  };

  it('needs both channel and key permissions, and valid IDs', async () => {
    expect((await connect(details, agent.token)).status).toBe(403);
    const bad = await connect({ ...details, phoneNumberId: '+1 555 010 0142' });
    expect(bad.status).toBe(400);
    const noToken = await connect({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID });
    expect(noToken.status).toBe(400);
    expect(JSON.stringify(noToken.body)).toMatch(/Enter the access token/);
    expect(graphCalls).toHaveLength(0);
  });

  it('saves nothing when Meta rejects the token', async () => {
    const before = await whatsappView();
    override = () => metaError(190, 'Invalid OAuth access token', 401);
    const res = await connect(details);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.steps).toHaveLength(1);
    expect(res.body.steps[0]).toMatchObject({ key: 'number', state: 'down' });
    expect(res.body.steps[0]!.detail).toMatch(/rejected the WhatsApp access token/);

    const after = await whatsappView();
    expect(after.config).toEqual(before.config);
    expect(after.secrets.every((s) => !s.set)).toBe(true);
  });

  it('saves nothing when the number is not under the business account', async () => {
    override = (call) =>
      call.path.includes('/phone_numbers')
        ? json({ data: [{ id: '999000111', display_phone_number: '+1 555 010 0999' }] })
        : undefined;
    const res = await connect(details);
    expect(res.body.connected).toBe(false);
    const account = res.body.steps.find((s) => s.key === 'account')!;
    expect(account.state).toBe('down');
    expect(account.detail).toContain(`Phone number ID ${PHONE_NUMBER_ID} does not belong`);
    expect(account.detail).toContain('+1 555 010 0999 (999000111)');
    expect((await whatsappView()).secrets.every((s) => !s.set)).toBe(true);
  });

  it('connects in one step: checks with Meta, saves, subscribes and lights up', async () => {
    const res = await connect(details);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.number).toEqual({
      display: '+1 555 010 0142',
      name: 'Demo Store',
      quality: 'GREEN',
    });
    expect(res.body.steps.map((s) => [s.key, s.state])).toEqual([
      ['number', 'ok'],
      ['account', 'ok'],
      ['subscription', 'ok'],
      ['security', 'ok'],
    ]);
    // No key comes back, in the result or anywhere in the settings view.
    const text = JSON.stringify(res.body) + JSON.stringify(await whatsappView());
    for (const value of [ACCESS_TOKEN, APP_SECRET, VERIFY_TOKEN]) expect(text).not.toContain(value);
    expect(graphCalls.some((c) => c.method === 'POST' && c.path.endsWith('/subscribed_apps'))).toBe(
      true,
    );

    const view = await whatsappView();
    expect(view.config).toMatchObject({ enabled: true, phoneNumberId: PHONE_NUMBER_ID });
    expect(view.secrets.every((s) => s.set)).toBe(true);
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'settings.secret_created', targetId: 'whatsapp.access_token' },
    });
    expect(audit.body.length).toBeGreaterThan(0);

    const wa = await light('whatsapp');
    expect(checkOf(wa, 'meta')).toMatchObject({
      state: 'ok',
      detail: 'Meta accepts the token for +1 555 010 0142 (Demo Store)',
    });
    expect(checkOf(wa, 'quality')).toMatchObject({ state: 'ok', detail: 'Green' });
    expect(checkOf(wa, 'subscription')?.state).toBe('ok');
    expect(checkOf(wa, 'security')?.state).toBe('ok');
    expect(wa.checkedAt).toBeTruthy();
  });

  it('stays amber until Meta has called the webhook, then goes green', async () => {
    // Nothing has arrived from Meta on this number yet (unless an earlier file sent messages).
    const before = await light('whatsapp');
    if (!before.activity.lastInboundAt) {
      expect(checkOf(before, 'webhook')).toMatchObject({ state: 'warning' });
      expect(before.state).toBe('warning');
    }

    const verify = await t.call('GET', '/channels/whatsapp/webhook', {
      query: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '9' },
    });
    expect(verify.status).toBe(200);
    const verified = await light('whatsapp');
    expect(checkOf(verified, 'webhook')?.state).toBe('ok');

    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const hook = await t.app.inject({
      method: 'POST',
      url: '/api/v1/channels/whatsapp/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
    expect(hook.statusCode).toBe(200);
    const heard = await light('whatsapp');
    expect(checkOf(heard, 'webhook')?.detail).toBe('Meta last called the webhook just now');
    if (checkOf(heard, 'deliveries')?.state === 'ok') {
      expect(heard).toMatchObject({
        state: 'ok',
        summary: 'Connected to +1 555 010 0142 (Demo Store)',
      });
    }
  });

  it('keeps saved keys when reconnecting without them, and registers with a PIN', async () => {
    const res = await connect({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, pin: '123456' });
    expect(res.body.connected).toBe(true);
    expect(res.body.steps.find((s) => s.key === 'register')).toMatchObject({
      state: 'ok',
      detail: 'Registered with the Cloud API',
    });
    const register = graphCalls.find((c) => c.path.endsWith('/register'))!;
    expect(register.body).toEqual({ messaging_product: 'whatsapp', pin: '123456' });

    override = (call) =>
      call.path.endsWith('/register')
        ? metaError(133005, 'Two step verification PIN mismatch')
        : undefined;
    const wrong = await connect({ phoneNumberId: PHONE_NUMBER_ID, wabaId: WABA_ID, pin: '000000' });
    // A wrong PIN doesn't undo a working connection; it is reported next to it.
    expect(wrong.body.connected).toBe(true);
    expect(wrong.body.steps.find((s) => s.key === 'register')).toMatchObject({ state: 'warning' });
    expect(wrong.body.steps.find((s) => s.key === 'register')!.detail).toMatch(/PIN is wrong/);
  });

  it('turns red when Meta stops accepting the token, and tells the admins once', async () => {
    const monitor = worker.get(ChannelHealthMonitor);
    expect(await monitor.run()).not.toContain('whatsapp');

    override = (call) =>
      call.path.includes('?fields=') ? metaError(190, 'Session has expired', 401) : undefined;
    expect(await monitor.run()).toContain('whatsapp');
    const wa = await light('whatsapp');
    expect(wa.state).toBe('down');
    expect(wa.summary).toMatch(/rejected the WhatsApp access token/);

    const mine = async () =>
      (
        (await t.call('GET', '/notifications', { token: admin })).body.items as Array<{
          kind: string;
          title: string;
          body: string;
        }>
      ).filter((n) => n.kind === 'channel.down' && n.title === 'WhatsApp stopped working');
    const told = await waitFor(async () => ((await mine()).length ? mine() : undefined), 'notice');
    expect(told[0]!.body).toMatch(/Settings → Channels/);
    // Agents don't manage channels, so they are not told.
    const theirs = (await t.call('GET', '/notifications', { token: agent.token })).body.items;
    expect(theirs.some((n: { kind: string }) => n.kind === 'channel.down')).toBe(false);

    // Still down on the next check: no second notice.
    expect(await monitor.run()).toEqual([]);
    expect(await mine()).toHaveLength(told.length);

    override = undefined;
    const back = (await recheck()).find((h) => h.channel === 'whatsapp')!;
    expect(checkOf(back, 'meta')?.state).toBe('ok');
  });

  it('says so when Meta is not sending the account’s messages anywhere', async () => {
    override = (call) =>
      call.method === 'GET' && call.path.endsWith('/subscribed_apps')
        ? json({ data: [] })
        : undefined;
    const wa = (await recheck()).find((h) => h.channel === 'whatsapp')!;
    expect(checkOf(wa, 'subscription')).toMatchObject({ state: 'down' });
    expect(wa.state).toBe('down');
  });

  it('goes grey when switched off, and red when the token is removed', async () => {
    await t.call('DELETE', '/settings/secrets/whatsapp.access_token', { token: admin });
    const noToken = await light('whatsapp');
    expect(noToken.state).toBe('down');
    expect(checkOf(noToken, 'token')?.detail).toBe('Not saved. Messages cannot be sent.');

    const view = await whatsappView();
    await t.call('PUT', '/settings/channels/whatsapp', {
      token: admin,
      body: { ...view.config, enabled: false },
    });
    expect(await light('whatsapp')).toMatchObject({ state: 'off', summary: 'Switched off' });
  });
});
