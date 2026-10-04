import type { ChannelActivity } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import {
  ago,
  emailHealth,
  type EmailFacts,
  mergeActivity,
  NO_ACTIVITY,
  voiceHealth,
  webchatHealth,
  webFormHealth,
  whatsappHealth,
  type WhatsappFacts,
} from './health-rules';

const now = new Date('2026-10-01T12:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const check = (h: { checks: Array<{ key: string; state: string; detail: string }> }, key: string) =>
  h.checks.find((c) => c.key === key);

describe('ago', () => {
  it('reads like a person would say it', () => {
    expect(ago(at(0), now)).toBe('just now');
    expect(ago(at(1), now)).toBe('1 minute ago');
    expect(ago(at(59), now)).toBe('59 minutes ago');
    expect(ago(at(90), now)).toBe('2 hours ago');
    expect(ago(at(60 * 72), now)).toBe('3 days ago');
  });
});

describe('email light', () => {
  const working: EmailFacts = {
    config: { enabled: true, address: 'support@tms.example' },
    poller: { state: 'watching', at: at(0) },
    probe: { ok: true, at: at(2), facts: { imap: 'ok', smtp: 'ok' } },
    workerUp: true,
    activity: NO_ACTIVITY,
    now,
  };

  it('is green when the mailbox is watched and the mail server accepts us', () => {
    const h = emailHealth(working);
    expect(h.state).toBe('ok');
    expect(h.summary).toBe('Reading and sending as support@tms.example');
    expect(h.checkedAt).toBe(at(2));
    expect(h.checks.map((c) => c.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  it('is grey when it is not set up or switched off', () => {
    expect(emailHealth({ ...working, config: null })).toMatchObject({
      state: 'off',
      summary: 'Not set up',
    });
    expect(
      emailHealth({ ...working, config: { enabled: false, address: 'a@b.example' } }),
    ).toMatchObject({ state: 'off', summary: 'Switched off' });
  });

  it('is red when the mail server refuses the login, and says which half', () => {
    const smtp = emailHealth({
      ...working,
      probe: { ok: false, at: at(1), error: 'x', facts: { imap: 'ok', smtp: 'Invalid login' } },
    });
    expect(smtp.state).toBe('down');
    expect(check(smtp, 'smtp')).toMatchObject({ state: 'down', detail: 'Invalid login' });
    expect(check(smtp, 'imap')?.state).toBe('ok');
    expect(smtp.summary).toBe('Invalid login');

    const imap = emailHealth({
      ...working,
      probe: { ok: false, at: at(1), facts: { imap: 'Connection refused', smtp: 'ok' } },
    });
    expect(check(imap, 'imap')).toMatchObject({ state: 'down', detail: 'Connection refused' });
  });

  it('is red when the mailbox reader reports an error or the worker is gone', () => {
    const errored = emailHealth({
      ...working,
      poller: { state: 'error', detail: 'mail.example:993: timed out', at: at(0) },
    });
    expect(check(errored, 'imap')).toMatchObject({
      state: 'down',
      detail: 'mail.example:993: timed out',
    });

    const noWorker = emailHealth({ ...working, workerUp: false, poller: undefined });
    expect(noWorker.state).toBe('down');
    expect(check(noWorker, 'worker')?.state).toBe('down');
    expect(check(noWorker, 'imap')?.detail).toBe('Waiting for the background worker');
  });

  it('is amber while unchecked, when the reader has gone quiet, or after failed sends', () => {
    expect(emailHealth({ ...working, probe: undefined }).state).toBe('warning');
    const quiet = emailHealth({ ...working, poller: { state: 'watching', at: at(5) } });
    expect(check(quiet, 'imap')).toMatchObject({
      state: 'warning',
      detail: 'The mailbox reader has not connected yet',
    });

    const failed = emailHealth({
      ...working,
      activity: {
        ...NO_ACTIVITY,
        failed24h: 2,
        lastFailure: { at: at(30), reason: 'Mailbox full' },
      },
    });
    expect(failed.state).toBe('warning');
    expect(failed.summary).toBe(
      '2 emails could not be delivered in the last 24 hours. Latest: Mailbox full',
    );
  });
});

describe('WhatsApp light', () => {
  const working: WhatsappFacts = {
    config: { enabled: true, phoneNumberId: '1055512345', wabaId: '2055512345' },
    secrets: { accessToken: true, appSecret: true, verifyToken: true },
    probe: {
      ok: true,
      at: at(1),
      facts: {
        displayPhoneNumber: '+1 555 010 0199',
        verifiedName: 'Demo Store',
        quality: 'GREEN',
        subscribed: true,
      },
    },
    webhookAt: at(4),
    workerUp: true,
    activity: NO_ACTIVITY,
    now,
  };

  it('is green when Meta accepts the token, sends webhooks and nothing failed', () => {
    const h = whatsappHealth(working);
    expect(h.state).toBe('ok');
    expect(h.summary).toBe('Connected to +1 555 010 0199 (Demo Store)');
    expect(check(h, 'webhook')?.detail).toBe('Meta last called the webhook 4 minutes ago');
    expect(h.checks.every((c) => c.state === 'ok')).toBe(true);
  });

  it('is grey before it is connected and when switched off', () => {
    expect(whatsappHealth({ ...working, config: null })).toMatchObject({
      state: 'off',
      summary: 'Not connected yet',
    });
    expect(
      whatsappHealth({ ...working, config: { ...working.config!, enabled: false } }).state,
    ).toBe('off');
  });

  it('is red without a token, with a rejected token, or without the app secret', () => {
    const noToken = whatsappHealth({
      ...working,
      secrets: { ...working.secrets, accessToken: false },
    });
    expect(noToken.state).toBe('down');
    expect(noToken.summary).toBe('Not saved. Messages cannot be sent.');
    expect(check(noToken, 'meta')).toBeUndefined();

    const rejected = whatsappHealth({
      ...working,
      probe: { ok: false, at: at(1), error: 'The WhatsApp access token has expired.' },
    });
    expect(rejected.state).toBe('down');
    expect(rejected.summary).toBe('The WhatsApp access token has expired.');

    const noSecret = whatsappHealth({
      ...working,
      secrets: { ...working.secrets, appSecret: false },
    });
    expect(check(noSecret, 'security')).toMatchObject({ state: 'down' });
  });

  it('is red when Meta is not sending the account’s messages anywhere', () => {
    const h = whatsappHealth({
      ...working,
      probe: { ...working.probe!, facts: { ...working.probe!.facts, subscribed: false } },
    });
    expect(check(h, 'subscription')).toMatchObject({ state: 'down' });
    expect(h.summary).toMatch(/Subscribe to webhooks/);
  });

  it('is amber before the first check, before Meta ever called, and on poor quality', () => {
    expect(whatsappHealth({ ...working, probe: undefined }).state).toBe('warning');

    const silent = whatsappHealth({ ...working, webhookAt: undefined });
    expect(check(silent, 'webhook')).toMatchObject({ state: 'warning' });
    expect(silent.summary).toMatch(/Meta has not called the webhook yet/);

    const yellow = whatsappHealth({
      ...working,
      probe: { ...working.probe!, facts: { ...working.probe!.facts, quality: 'YELLOW' } },
    });
    expect(check(yellow, 'quality')?.state).toBe('warning');
  });

  it('counts a verified address or an earlier customer message as heard from Meta', () => {
    const verified = whatsappHealth({ ...working, webhookAt: undefined, handshakeAt: at(10) });
    expect(check(verified, 'webhook')).toMatchObject({ state: 'ok' });
    expect(check(verified, 'webhook')?.detail).toMatch(/verified the webhook address 10 minutes/);

    const earlier = whatsappHealth({
      ...working,
      webhookAt: undefined,
      activity: { ...NO_ACTIVITY, lastInboundAt: at(120) },
    });
    expect(check(earlier, 'webhook')?.detail).toBe('Meta last called the webhook 2 hours ago');
  });

  it('is amber after failed deliveries, with the latest reason', () => {
    const h = whatsappHealth({
      ...working,
      activity: {
        ...NO_ACTIVITY,
        failed24h: 1,
        lastFailure: { at: at(5), reason: 'Number not on WhatsApp' },
      },
    });
    expect(h.state).toBe('warning');
    expect(h.summary).toBe(
      '1 message could not be delivered in the last 24 hours. Latest: Number not on WhatsApp',
    );
  });
});

describe('web chat, form and voice lights', () => {
  it('web chat is green while the worker runs, and counts visitors', () => {
    expect(webchatHealth({ workerUp: true, visitors: 2, activity: NO_ACTIVITY })).toMatchObject({
      state: 'ok',
      summary: 'Accepting chats, 2 visitors connected now',
    });
    expect(webchatHealth({ workerUp: true, visitors: null, activity: NO_ACTIVITY }).summary).toBe(
      'Accepting chats',
    );
    expect(webchatHealth({ workerUp: false, visitors: 0, activity: NO_ACTIVITY }).state).toBe(
      'down',
    );
  });

  it('the form follows the email channel it replies through', () => {
    const form = (email: 'ok' | 'warning' | 'down' | 'off') =>
      webFormHealth({ workerUp: true, email, activity: NO_ACTIVITY });
    expect(form('ok').state).toBe('ok');
    expect(form('warning').state).toBe('warning');
    expect(form('down').state).toBe('down');
    expect(form('off')).toMatchObject({ state: 'warning' });
    expect(form('off').summary).toMatch(/Email is off/);
  });

  it('voice is off until it is set up, then follows the key, the last test and the lines', () => {
    const voice = (over: Partial<Parameters<typeof voiceHealth>[0]> = {}) =>
      voiceHealth({
        enabled: true,
        keySaved: true,
        probe: { ok: true, at: at(3) },
        lines: { active: 1, max: 5 },
        activity: NO_ACTIVITY,
        ...over,
      });
    expect(voice({ enabled: null, keySaved: false })).toMatchObject({
      state: 'off',
      summary: 'Not set up',
    });
    expect(voice({ enabled: false }).state).toBe('off');
    expect(voice()).toMatchObject({ state: 'ok', summary: 'Ready for calls' });
    expect(check(voice(), 'lines')?.detail).toBe('1 of 5 in use');

    const noKey = voice({ keySaved: false });
    expect(noKey).toMatchObject({ state: 'down', summary: 'Not saved. Calls cannot start.' });
    expect(voice({ probe: undefined }).state).toBe('warning');
    expect(
      voice({ probe: { ok: false, at: at(1), error: 'Sarvam answered HTTP 403' } }),
    ).toMatchObject({ state: 'down', summary: 'Sarvam answered HTTP 403' });
    expect(voice({ lines: { active: 5, max: 5 } })).toMatchObject({ state: 'warning' });
  });
});

describe('mergeActivity', () => {
  it('adds failures and keeps the latest times', () => {
    const a: ChannelActivity = {
      lastInboundAt: at(60),
      lastOutboundAt: at(30),
      failed24h: 1,
      lastFailure: { at: at(50), reason: 'older' },
    };
    const b: ChannelActivity = {
      lastInboundAt: null,
      lastOutboundAt: at(10),
      failed24h: 2,
      lastFailure: { at: at(5), reason: 'newer' },
    };
    expect(mergeActivity(a, undefined, b)).toEqual({
      lastInboundAt: at(60),
      lastOutboundAt: at(10),
      failed24h: 3,
      lastFailure: { at: at(5), reason: 'newer' },
    });
    expect(mergeActivity(undefined)).toEqual(NO_ACTIVITY);
  });
});
