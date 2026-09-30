import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import {
  autoReplyReason,
  emailToEnvelope,
  extractTicketNumber,
  replySubject,
  splitReferences,
  stripQuotedReply,
} from './email.util';

describe('splitReferences', () => {
  it('merges References and In-Reply-To without duplicates', () => {
    expect(splitReferences('<a@x> <b@x>', '<b@x>')).toEqual(['<a@x>', '<b@x>']);
    expect(splitReferences(['<a@x>', '<c@x>'], undefined)).toEqual(['<a@x>', '<c@x>']);
    expect(splitReferences(undefined, 'bare@id')).toEqual(['<bare@id>']);
  });
});

describe('subjects', () => {
  it('extracts the ticket tag', () => {
    expect(extractTicketNumber('Re: Refund [TMS-42]')).toBe(42);
    expect(extractTicketNumber('Refund TMS-42')).toBeNull();
  });

  it('builds reply subjects without stacking prefixes or tags', () => {
    expect(replySubject('Refund please', 7)).toBe('Re: Refund please [TMS-7]');
    expect(replySubject('RE: Fwd: Refund please [TMS-7]', 7)).toBe('Re: Refund please [TMS-7]');
    expect(replySubject('', 7)).toBe('Re: (no subject) [TMS-7]');
  });
});

describe('autoReplyReason', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it('flags auto-replies, bulk mail and bounces', () => {
    expect(autoReplyReason(headers({ 'auto-submitted': 'auto-replied' }))).toMatch(
      /auto-submitted/,
    );
    expect(autoReplyReason(headers({ precedence: 'bulk' }))).toMatch(/precedence/);
    expect(autoReplyReason(headers({ 'x-autoreply': 'yes' }))).toBeTruthy();
    expect(autoReplyReason(headers({}), 'MAILER-DAEMON@mx.example.com')).toBe('bounce');
  });

  it('lets normal mail through', () => {
    expect(autoReplyReason(headers({ 'auto-submitted': 'no' }), 'a@b.com')).toBeNull();
  });
});

describe('stripQuotedReply', () => {
  it('cuts Gmail-style quotes', () => {
    const text =
      'Thanks, that works.\n\nOn Tue, 29 Sep 2026, Support <s@x> wrote:\n> Hello\n> there';
    expect(stripQuotedReply(text)).toBe('Thanks, that works.');
  });

  it('cuts Outlook headers and trailing quote blocks', () => {
    expect(stripQuotedReply('Done.\r\n\r\nFrom: Support\r\nSent: Monday')).toBe('Done.');
    expect(stripQuotedReply('Yes please\n\n> earlier text\n>')).toBe('Yes please');
  });

  it('keeps the text when everything would be removed', () => {
    expect(stripQuotedReply('> only quoted')).toBe('> only quoted');
  });
});

describe('emailToEnvelope', () => {
  const raw = (headers: string, body = 'Hello') =>
    Buffer.from(`${headers}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`);

  it('builds an envelope threaded on the first reference', async () => {
    const mail = await simpleParser(
      raw(
        'From: Priya <Priya@Example.com>\r\nTo: support@tms.local\r\nSubject: Re: Order\r\n' +
          'Message-ID: <m2@example.com>\r\nIn-Reply-To: <m1@tms.local>\r\nReferences: <m0@example.com> <m1@tms.local>',
      ),
    );
    const r = emailToEnvelope(mail, {
      ourAddress: 'support@tms.local',
      attachments: [],
      fallbackId: '<f@x>',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope).toMatchObject({
      channel: 'email',
      threadKey: '<m0@example.com>',
      channelMessageId: '<m2@example.com>',
      from: { identity: { type: 'email', value: 'priya@example.com' }, displayName: 'Priya' },
      subject: 'Re: Order',
      references: ['<m0@example.com>', '<m1@tms.local>'],
    });
  });

  it('skips mail from our own address', async () => {
    const mail = await simpleParser(raw('From: support@tms.local\r\nSubject: Loop'));
    expect(
      emailToEnvelope(mail, {
        ourAddress: 'support@tms.local',
        attachments: [],
        fallbackId: '<f@x>',
      }),
    ).toEqual({ ok: false, reason: 'sent by our own address' });
  });
});
