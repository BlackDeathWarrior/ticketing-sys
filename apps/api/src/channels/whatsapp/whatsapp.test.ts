/*
 * Tests ported from whatsapp-crm (a fork of ArnasDon/wacrm) alongside the code
 * they cover, with TMS-specific cases added. MIT License, Copyright (c) 2026
 * Arnas Donauskas. See THIRD_PARTY_NOTICES.md.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusAdvances } from '../../conversations/conversations.service';
import {
  downloadMedia,
  getMediaUrl,
  isTrustedMediaUrl,
  listMessageTemplates,
  MetaApiError,
  sendTemplateMessage,
  sendTextMessage,
} from './meta-api';
import { explainMetaError, explainStatusError } from './meta-errors';
import {
  isValidE164,
  normalizePhone,
  parseInternationalPhone,
  phonesMatch,
  sanitizePhoneForMeta,
} from './phone-utils';
import { buildSendComponents, type SendableTemplate } from './template-send-builder';
import {
  hasUsableIdentity,
  identityDisplayName,
  isBusinessScopedUserId,
  resolveContactSendTarget,
  resolveInboundIdentity,
} from './wa-identity';
import {
  contactFor,
  isIgnorable,
  mediaFilename,
  messageContent,
  messageTime,
  normalizeMimeType,
  templateRow,
  type WaMessage,
} from './webhook-payload';
import { parseAppSecrets, tokensEqual, verifyMetaWebhookSignature } from './webhook-signature';

const GRAPH = { baseUrl: 'https://graph.facebook.com', version: 'v23.0' };
const BSUID = 'US.13491208655302741918';
const PARENT_BSUID = 'US.ENT.11815799212886844830';

describe('phone utils', () => {
  it('keeps digits only', () => {
    expect(sanitizePhoneForMeta('+370 639 49836')).toBe('37063949836');
    expect(sanitizePhoneForMeta('+1 (415) 555-1212')).toBe('14155551212');
    expect(sanitizePhoneForMeta('')).toBe('');
    expect(normalizePhone('0044 7000 0000 0000')).toBe('0044700000000000');
  });

  it('matches numbers across a trunk prefix by their last eight digits', () => {
    expect(phonesMatch('+37063949836', '37063949836')).toBe(true);
    expect(phonesMatch('370063949836', '37063949836')).toBe(true);
    expect(phonesMatch('+37063949836', '+37063949837')).toBe(false);
    expect(phonesMatch('1234567', '9991234567')).toBe(false);
  });

  it('accepts E.164-like stored numbers', () => {
    expect(isValidE164('14155551212')).toBe(true);
    expect(isValidE164('+919900055523')).toBe(true);
    expect(isValidE164('0123456789')).toBe(false);
    expect(isValidE164('1234567')).toBe(false);
    expect(isValidE164('1234567890123456')).toBe(false);
  });

  it('requires the + prefix on numbers a person typed', () => {
    expect(parseInternationalPhone('+1 (415) 555-1212')).toBe('14155551212');
    expect(parseInternationalPhone('4155551212')).toBeNull();
    expect(parseInternationalPhone('+1 415 CALL-NOW')).toBeNull();
    expect(parseInternationalPhone(null)).toBeNull();
  });
});

describe('sender identity', () => {
  const legacyContact = { profile: { name: 'Ada' }, wa_id: '15551230000' };
  const usernameOnlyContact = {
    profile: { name: 'Sheena Nelson', username: 'realsheenanelson' },
    user_id: BSUID,
    parent_user_id: PARENT_BSUID,
  };

  it('tells user ids from phone numbers', () => {
    expect(isBusinessScopedUserId(BSUID)).toBe(true);
    expect(isBusinessScopedUserId(PARENT_BSUID)).toBe(true);
    for (const phone of ['15551230000', '+1 (555) 123-0000', '37063949836', '0']) {
      expect(isBusinessScopedUserId(phone)).toBe(false);
    }
    for (const bad of ['', null, undefined, 'US.', 'USA.1349120865530274']) {
      expect(isBusinessScopedUserId(bad)).toBe(false);
    }
  });

  it('reads the phone-only payload', () => {
    expect(resolveInboundIdentity({ from: '15551230000' }, legacyContact)).toEqual({
      phone: '15551230000',
      waUserId: null,
      waParentUserId: null,
      waUsername: null,
      name: 'Ada',
    });
  });

  it('reads a username-only payload with no phone anywhere', () => {
    const identity = resolveInboundIdentity(
      { from_user_id: BSUID, from_parent_user_id: PARENT_BSUID },
      usernameOnlyContact,
    );
    expect(identity).toEqual({
      phone: '',
      waUserId: BSUID,
      waParentUserId: PARENT_BSUID,
      waUsername: 'realsheenanelson',
      name: 'Sheena Nelson',
    });
    expect(hasUsableIdentity(identity)).toBe(true);
  });

  it('refuses a malformed user id and has nothing to key on without a phone', () => {
    const identity = resolveInboundIdentity({ from_user_id: 'not-a-bsuid' });
    expect(identity.waUserId).toBeNull();
    expect(hasUsableIdentity(identity)).toBe(false);
  });

  it('labels people by name, then username, then phone, then user id', () => {
    const base = { phone: '', waUserId: BSUID, waParentUserId: null, waUsername: null, name: '' };
    expect(identityDisplayName({ ...base, name: 'Ada' })).toBe('Ada');
    expect(identityDisplayName({ ...base, waUsername: 'ada' })).toBe('@ada');
    expect(identityDisplayName({ ...base, phone: '15551230000' })).toBe('+15551230000');
    expect(identityDisplayName(base)).toBe(BSUID);
  });

  it('addresses a send by phone first, user id second', () => {
    expect(resolveContactSendTarget({ phone: '+1 555 123 0000', waUserId: BSUID })).toEqual({
      target: '15551230000',
      isPhone: true,
    });
    expect(resolveContactSendTarget({ phone: '', waUserId: BSUID })).toEqual({
      target: BSUID,
      isPhone: false,
    });
    expect(resolveContactSendTarget({ phone: '12', waUserId: null })).toBeNull();
    expect(resolveContactSendTarget(null)).toBeNull();
  });
});

describe('webhook signature', () => {
  const secret = 'app-secret-one';
  const sign = (body: string, key = secret) =>
    `sha256=${crypto.createHmac('sha256', key).update(body).digest('hex')}`;

  it('accepts a body signed with the app secret', () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account' });
    expect(verifyMetaWebhookSignature(body, sign(body), [secret])).toBe(true);
    expect(verifyMetaWebhookSignature(Buffer.from(body), sign(body), [secret])).toBe(true);
  });

  it('rejects a wrong secret, a changed body and a malformed header', () => {
    const body = '{"entry":[]}';
    expect(verifyMetaWebhookSignature(body, sign(body, 'wrong'), [secret])).toBe(false);
    expect(verifyMetaWebhookSignature('{"entry":[1]}', sign(body), [secret])).toBe(false);
    expect(verifyMetaWebhookSignature(body, null, [secret])).toBe(false);
    expect(verifyMetaWebhookSignature(body, sign(body).slice(7), [secret])).toBe(false);
    expect(verifyMetaWebhookSignature(body, 'sha256=tooshort', [secret])).toBe(false);
  });

  it('fails closed with no secret configured', () => {
    const body = '{}';
    expect(verifyMetaWebhookSignature(body, sign(body), [])).toBe(false);
    expect(verifyMetaWebhookSignature(body, sign(body, ''), parseAppSecrets(''))).toBe(false);
  });

  it('accepts any of several comma-separated secrets', () => {
    const secrets = parseAppSecrets(' app-secret-one , ,second-app-secret ');
    expect(secrets).toEqual(['app-secret-one', 'second-app-secret']);
    const body = '{"a":1}';
    expect(verifyMetaWebhookSignature(body, sign(body, 'second-app-secret'), secrets)).toBe(true);
    expect(verifyMetaWebhookSignature(body, sign(body, 'third'), secrets)).toBe(false);
  });

  it('compares verify tokens without leaking length', () => {
    expect(tokensEqual('my-verify-token', 'my-verify-token')).toBe(true);
    expect(tokensEqual('my-verify-toke', 'my-verify-token')).toBe(false);
    expect(tokensEqual(undefined, 'my-verify-token')).toBe(false);
  });
});

describe('Graph API calls', () => {
  let calls: Array<{ url: string; init: RequestInit }> = [];
  const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers,
      });
    });
  const sent = () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  const base = { graph: GRAPH, accessToken: 'tok', phoneNumberId: '1055512345' };

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends text to a phone number with to + recipient_type', async () => {
    vi.stubGlobal('fetch', respond({ messages: [{ id: 'wamid.OK' }] }));
    const result = await sendTextMessage({ ...base, to: '15551230000', text: 'hi' });
    expect(result).toEqual({ messageId: 'wamid.OK' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/1055512345/messages');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(sent()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551230000',
      type: 'text',
      text: { body: 'hi' },
    });
  });

  it('sends to a user id with `recipient` and never both fields', async () => {
    vi.stubGlobal('fetch', respond({ messages: [{ id: 'wamid.OK' }] }));
    await sendTextMessage({ ...base, to: BSUID, text: 'hi' });
    expect(sent()).toMatchObject({ recipient: BSUID, type: 'text' });
    expect(sent()).not.toHaveProperty('to');
    expect(sent()).not.toHaveProperty('recipient_type');
  });

  it('sends a template with its components, and none when it is static', async () => {
    vi.stubGlobal('fetch', respond({ messages: [{ id: 'wamid.T' }] }));
    const components = [{ type: 'body', parameters: [{ type: 'text', text: 'TMS-7' }] }];
    await sendTemplateMessage({
      ...base,
      to: '15551230000',
      templateName: 'ticket_update',
      language: 'en_US',
      components,
    });
    expect(sent()).toMatchObject({
      type: 'template',
      template: { name: 'ticket_update', language: { code: 'en_US' }, components },
    });
    calls = [];
    await sendTemplateMessage({
      ...base,
      to: '15551230000',
      templateName: 'hello',
      language: 'en',
      components: [],
    });
    expect(sent().template).toEqual({ name: 'hello', language: { code: 'en' } });
  });

  it("keeps Meta's error envelope on a failed call", async () => {
    vi.stubGlobal(
      'fetch',
      respond(
        {
          error: {
            message: '(#131047) Re-engagement message',
            code: 131047,
            type: 'OAuthException',
            fbtrace_id: 'AbC',
            error_data: { details: 'More than 24 hours have passed' },
          },
        },
        400,
      ),
    );
    const err = await sendTextMessage({ ...base, to: '15551230000', text: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ code: 131047, httpStatus: 400, fbtraceId: 'AbC' });
    expect(err.details).toMatch(/24 hours/);
  });

  it('falls back to the HTTP status when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', respond('<html>bad gateway</html>', 502));
    const err = await sendTextMessage({ ...base, to: '15551230000', text: 'hi' }).catch((e) => e);
    expect(err).toMatchObject({ message: 'Meta API error: 502', code: null, httpStatus: 502 });
  });

  it('resolves media and reads its size as a number or a numeric string', async () => {
    vi.stubGlobal(
      'fetch',
      respond({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/jpeg', file_size: '2048' }),
    );
    expect(await getMediaUrl({ graph: GRAPH, accessToken: 'tok', mediaId: '99' })).toEqual({
      url: 'https://lookaside.fbsbx.com/x',
      mimeType: 'image/jpeg',
      fileSize: 2048,
    });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v23.0/99');
  });

  it("only downloads media from Meta's hosts, and never above the size limit", async () => {
    expect(isTrustedMediaUrl('https://lookaside.fbsbx.com/a?mid=1', GRAPH.baseUrl)).toBe(true);
    expect(isTrustedMediaUrl('https://scontent.whatsapp.net/v/t1', GRAPH.baseUrl)).toBe(true);
    expect(isTrustedMediaUrl('https://graph.facebook.com/v23.0/99', GRAPH.baseUrl)).toBe(true);
    expect(isTrustedMediaUrl('http://lookaside.fbsbx.com/a', GRAPH.baseUrl)).toBe(false);
    expect(isTrustedMediaUrl('https://evilfbsbx.com/a', GRAPH.baseUrl)).toBe(false);
    expect(isTrustedMediaUrl('https://169.254.169.254/latest', GRAPH.baseUrl)).toBe(false);
    expect(isTrustedMediaUrl('not a url', GRAPH.baseUrl)).toBe(false);

    vi.stubGlobal('fetch', respond('12345678', 200, { 'content-type': 'image/png' }));
    const args = { accessToken: 'tok', graph: GRAPH, maxBytes: 100 };
    await expect(
      downloadMedia({ ...args, downloadUrl: 'https://attacker.example/x' }),
    ).rejects.toThrow(/unexpected host/);
    expect(calls).toHaveLength(0);
    const file = await downloadMedia({ ...args, downloadUrl: 'https://lookaside.fbsbx.com/x' });
    expect(file.buffer.length).toBe(8);
    expect(file.contentType).toBe('image/png');
    await expect(
      downloadMedia({ ...args, maxBytes: 4, downloadUrl: 'https://lookaside.fbsbx.com/x' }),
    ).rejects.toThrow(/size limit/);
  });

  it('lists templates across pages, following `next` only on the Graph host', async () => {
    const pages = [
      {
        data: [{ id: '1', name: 'a', language: 'en', status: 'APPROVED', category: 'UTILITY' }],
        paging: { next: 'https://graph.facebook.com/v23.0/55/message_templates?after=x' },
      },
      {
        data: [{ id: '2', name: 'b', language: 'en', status: 'PENDING', category: 'MARKETING' }],
        paging: { next: 'https://elsewhere.example/steal' },
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push({ url, init: {} });
        return new Response(JSON.stringify(pages[calls.length - 1]), { status: 200 });
      }),
    );
    const list = await listMessageTemplates({ graph: GRAPH, accessToken: 'tok', wabaId: '55' });
    expect(list.map((t) => t.name)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });
});

describe('error explanations', () => {
  const meta = (code: number, extra: Record<string, unknown> = {}) =>
    new MetaApiError(`(#${code}) error`, { code, httpStatus: 400, ...extra });

  it('says what to do about a closed window, and does not retry', () => {
    const why = explainMetaError(meta(131047));
    expect(why.retryable).toBe(false);
    expect(why.summary).toMatch(/24 hours.*template/);
  });

  it('explains token problems by subcode', () => {
    expect(explainMetaError(meta(190, { subcode: 463 })).summary).toMatch(/expired/);
    expect(explainMetaError(meta(190, { subcode: 460 })).summary).toMatch(/invalidated/);
    expect(explainMetaError(meta(190)).retryable).toBe(false);
    expect(explainMetaError(meta(10)).summary).toMatch(/not allowed/);
  });

  it('retries rate limits, temporary errors, server errors and network failures', () => {
    expect(explainMetaError(meta(130429)).retryable).toBe(true);
    expect(explainMetaError(meta(131000)).retryable).toBe(true);
    expect(
      explainMetaError(new MetaApiError('Meta API error: 503', { httpStatus: 503 })).retryable,
    ).toBe(true);
    const network = explainMetaError(new TypeError('fetch failed'));
    expect(network.retryable).toBe(true);
    expect(network.summary).toMatch(/Could not reach/);
  });

  it("does not retry what it can't explain, and keeps Meta's words and trace id", () => {
    const why = explainMetaError(meta(999999, { fbtraceId: 'TRACE1', details: 'odd' }));
    expect(why.retryable).toBe(false);
    expect(why.summary).toContain('code 999999');
    expect(why.summary).toContain('odd');
    expect(why.summary).toContain('TRACE1');
  });

  it('explains a failed status report', () => {
    expect(explainStatusError({ code: 131026, title: 'Message undeliverable' })).toMatch(
      /could not deliver/,
    );
    expect(explainStatusError({ code: 131030, title: 'x' })).toMatch(/allowed list/);
    expect(explainStatusError(undefined)).toMatch(/could not deliver/);
  });
});

describe('template send components', () => {
  const row = (overrides: Partial<SendableTemplate> = {}): SendableTemplate => ({
    headerType: null,
    headerText: null,
    bodyText: 'Your order is on its way.',
    buttons: [],
    ...overrides,
  });

  it('is empty for a fully static template', () => {
    expect(buildSendComponents(row())).toEqual([]);
    expect(buildSendComponents(row({ headerType: 'text', headerText: 'Order update' }))).toEqual(
      [],
    );
  });

  it('fills body variables, dropping extras and refusing too few', () => {
    const template = row({ bodyText: 'Hi {{1}}, order {{2}} confirmed.' });
    expect(buildSendComponents(template, { body: ['John', 'ORD-42', 'extra'] })).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'John' },
          { type: 'text', text: 'ORD-42' },
        ],
      },
    ]);
    expect(() => buildSendComponents(template, { body: ['just one'] })).toThrow(
      /2 variable\(s\) but only 1/,
    );
  });

  it('needs a value for a header variable and a link for a media header', () => {
    const text = row({ headerType: 'text', headerText: 'Hello {{1}}' });
    expect(() => buildSendComponents(text)).toThrow(/header has a variable/);
    expect(buildSendComponents(text, { headerText: 'Ada' })[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'text', text: 'Ada' }],
    });
    const image = row({ headerType: 'image' });
    expect(() => buildSendComponents(image)).toThrow(/media link/);
    expect(buildSendComponents(image, { headerMediaUrl: 'https://cdn.example/a.jpg' })[0]).toEqual({
      type: 'header',
      parameters: [{ type: 'image', image: { link: 'https://cdn.example/a.jpg' } }],
    });
  });

  it('builds button components by position', () => {
    const template = row({
      buttons: [
        { type: 'QUICK_REPLY', text: 'Yes' },
        { type: 'URL', text: 'Track', url: 'https://shop.example/track/{{1}}' },
        { type: 'URL', text: 'Help', url: 'https://shop.example/help' },
        { type: 'COPY_CODE', text: 'Copy', example: 'SAVE10' },
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+15551230000' },
      ],
    });
    expect(() => buildSendComponents(template)).toThrow(/Button 2 \("Track"\)/);
    expect(buildSendComponents(template, { buttonParams: { '1': 'DS-20517' } })).toEqual([
      {
        type: 'button',
        sub_type: 'url',
        index: '1',
        parameters: [{ type: 'text', text: 'DS-20517' }],
      },
      {
        type: 'button',
        sub_type: 'copy_code',
        index: '3',
        parameters: [{ type: 'coupon_code', coupon_code: 'SAVE10' }],
      },
    ]);
  });
});

describe('webhook payload', () => {
  const message = (over: Partial<WaMessage>): WaMessage => ({
    id: 'wamid.1',
    timestamp: '1790000000',
    type: 'text',
    from: '15551230000',
    ...over,
  });

  it('reads text, captions and media', () => {
    expect(messageContent(message({ text: { body: 'Hello' } }))).toEqual({
      text: 'Hello',
      media: null,
    });
    expect(
      messageContent(
        message({ type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'Broken' } }),
      ),
    ).toEqual({
      text: 'Broken',
      media: { id: 'm1', mimeType: 'image/jpeg', filename: null, kind: 'image' },
    });
    expect(
      messageContent(
        message({
          type: 'document',
          document: { id: 'm2', mime_type: 'application/pdf', filename: 'invoice.pdf' },
        }),
      ).media,
    ).toMatchObject({ filename: 'invoice.pdf', kind: 'document' });
    expect(
      messageContent(message({ type: 'audio', audio: { id: 'm3', mime_type: 'audio/ogg' } })),
    ).toMatchObject({ text: '', media: { kind: 'audio' } });
  });

  it('reads locations, button taps and unknown types as text', () => {
    expect(
      messageContent(
        message({
          type: 'location',
          location: { latitude: 12.97, longitude: 77.59, name: 'Depot' },
        }),
      ).text,
    ).toBe('Location: Depot - 12.97,77.59');
    expect(
      messageContent(
        message({
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } },
        }),
      ).text,
    ).toBe('Yes please');
    expect(
      messageContent(message({ type: 'button', button: { text: 'Track order', payload: 'trk' } }))
        .text,
    ).toBe('Track order');
    expect(messageContent(message({ type: 'order' })).text).toBe(
      '[Unsupported WhatsApp message: order]',
    );
  });

  it('skips reactions and system notices', () => {
    expect(isIgnorable(message({ type: 'reaction' }))).toBe(true);
    expect(isIgnorable(message({ type: 'system' }))).toBe(true);
    expect(isIgnorable(message({ type: 'text' }))).toBe(false);
  });

  it('pairs a message with its contact by phone or user id', () => {
    const contacts = [
      { wa_id: '15551230000', profile: { name: 'Ada' } },
      { user_id: BSUID, profile: { name: 'Sheena' } },
    ];
    expect(contactFor(message({}), contacts)?.profile?.name).toBe('Ada');
    expect(
      contactFor(message({ from: undefined, from_user_id: BSUID }), contacts)?.profile?.name,
    ).toBe('Sheena');
    expect(contactFor(message({ from: '1999' }), contacts)).toBeUndefined();
    expect(contactFor(message({ from: '1999' }), [contacts[0]!])?.profile?.name).toBe('Ada');
  });

  it('names files and cleans MIME types', () => {
    expect(normalizeMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(normalizeMimeType(undefined)).toBe('application/octet-stream');
    const media = { id: 'm', mimeType: 'audio/ogg; codecs=opus', filename: null, kind: 'audio' };
    expect(mediaFilename(media, '1790000000')).toBe('audio-1790000000.ogg');
    expect(mediaFilename({ ...media, filename: '../../etc/invoice.pdf' }, '1')).toBe('invoice.pdf');
    expect(mediaFilename({ ...media, mimeType: 'application/x-odd' }, '')).toBe('audio.bin');
  });

  it("uses Meta's timestamp, but never one from the future", () => {
    const now = new Date('2026-10-01T10:00:00Z');
    expect(messageTime('1790846400', now)).toBe('2026-10-01T09:20:00.000Z');
    expect(messageTime('1999999999', now)).toBe(now.toISOString());
    expect(messageTime('nonsense', now)).toBe(now.toISOString());
  });

  it("turns Meta's template into a row", () => {
    expect(
      templateRow({
        id: '901',
        name: 'ticket_update',
        language: 'en_US',
        status: 'approved',
        category: 'utility',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'Ticket {{1}}' },
          { type: 'BODY', text: 'Hi {{1}}, we have an update on {{2}}.' },
          { type: 'FOOTER', text: 'Demo Store support' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'URL', text: 'Open', url: 'https://help.example/t/{{1}}', example: ['x'] },
              { type: 'QUICK_REPLY', text: 'Thanks' },
              { type: 'OTP', text: 'Copy code' },
            ],
          },
        ],
      }),
    ).toEqual({
      metaId: '901',
      name: 'ticket_update',
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      headerType: 'text',
      headerText: 'Ticket {{1}}',
      bodyText: 'Hi {{1}}, we have an update on {{2}}.',
      footerText: 'Demo Store support',
      buttons: [
        { type: 'URL', text: 'Open', url: 'https://help.example/t/{{1}}', example: 'x' },
        { type: 'QUICK_REPLY', text: 'Thanks' },
      ],
    });
  });
});

describe('delivery status order', () => {
  it('only moves forward', () => {
    expect(statusAdvances('pending', 'sent')).toBe(true);
    expect(statusAdvances('sent', 'delivered')).toBe(true);
    expect(statusAdvances('sent', 'read')).toBe(true);
    expect(statusAdvances('read', 'delivered')).toBe(false);
    expect(statusAdvances('delivered', 'sent')).toBe(false);
    expect(statusAdvances('sent', 'sent')).toBe(false);
  });

  it('lets a message fail until it has reached the phone, and failed is final', () => {
    expect(statusAdvances('sent', 'failed')).toBe(true);
    expect(statusAdvances('delivered', 'failed')).toBe(false);
    expect(statusAdvances('failed', 'delivered')).toBe(false);
    expect(statusAdvances('draft', 'sent')).toBe(false);
    expect(statusAdvances(null, 'sent')).toBe(false);
  });
});
