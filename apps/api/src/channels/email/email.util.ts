import type { AttachmentRef, MessageEnvelope } from '@tms/shared';
import type { ParsedMail } from 'mailparser';
import { formatTicketNumber } from '@tms/shared';

/** Pure helpers for the email channel, kept free of I/O so they are easy to test. */

export function normalizeMessageId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

/** Splits In-Reply-To / References values into individual <message-ids>. */
export function splitReferences(...values: Array<string | string[] | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const part of Array.isArray(v) ? v : v ? [v] : []) {
      for (const m of part.match(/<[^<>\s]+>/g) ??
        (part.trim() ? [normalizeMessageId(part)] : [])) {
        if (!out.includes(m)) out.push(m);
      }
    }
  }
  return out;
}

const TICKET_REF = /\[TMS-(\d+)\]/i;

export function extractTicketNumber(subject: string | undefined): number | null {
  const m = subject ? TICKET_REF.exec(subject) : null;
  return m ? Number(m[1]) : null;
}

/** "Re: <subject> [TMS-12]", without stacking prefixes or references. */
export function replySubject(subject: string, ticketNumber: number): string {
  const base = subject.replace(/^((re|fw|fwd|aw)\s*:\s*)+/i, '').trim() || '(no subject)';
  const ref = `[${formatTicketNumber(ticketNumber)}]`;
  return `Re: ${base.includes(ref) ? base : `${base} ${ref}`}`;
}

type HeaderLookup = (name: string) => string | undefined;

/** Auto-replies, bounces and bulk mail must not create tickets or trigger replies (mail loops). */
export function autoReplyReason(get: HeaderLookup, fromAddress?: string): string | null {
  const autoSubmitted = get('auto-submitted')?.toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return `auto-submitted: ${autoSubmitted}`;
  if (get('x-autoreply') || get('x-autorespond')) return 'x-autoreply header';
  const precedence = get('precedence')?.toLowerCase();
  if (precedence && ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) {
    return `precedence: ${precedence}`;
  }
  if (fromAddress && /^(mailer-daemon|postmaster)@/i.test(fromAddress)) return 'bounce';
  return null;
}

const QUOTE_MARKERS = [
  /^On .+wrote:\s*$/i, // Gmail, Apple Mail
  /^-{2,}\s*Original Message\s*-{2,}/i, // Outlook (classic)
  /^From:\s.+/i, // Outlook: "From: ... Sent: ..." block
  /^_{10,}\s*$/, // Outlook web separator
];

/** Keeps only the new part of a reply; returns the original text if nothing would remain. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (QUOTE_MARKERS.some((re) => re.test(line))) {
      cut = i;
      break;
    }
  }
  // Drop a trailing block of "> quoted" lines.
  while (cut > 0 && /^\s*(>.*)?$/.test(lines[cut - 1]!)) cut--;
  const result = lines.slice(0, cut).join('\n').trim();
  return result || text.trim();
}

export type EnvelopeResult =
  { ok: true; envelope: MessageEnvelope } | { ok: false; reason: string };

/** Converts a parsed email into a channel envelope, or explains why it is skipped. */
export function emailToEnvelope(
  mail: ParsedMail,
  opts: { ourAddress: string; attachments: AttachmentRef[]; fallbackId: string },
): EnvelopeResult {
  const from = mail.from?.value[0];
  const address = from?.address?.toLowerCase();
  if (!address) return { ok: false, reason: 'no sender address' };
  if (address === opts.ourAddress.toLowerCase())
    return { ok: false, reason: 'sent by our own address' };

  const get: HeaderLookup = (name) => {
    const v = mail.headers.get(name);
    return v === undefined || v === null
      ? undefined
      : String(typeof v === 'object' ? JSON.stringify(v) : v);
  };
  const auto = autoReplyReason(get, address);
  if (auto) return { ok: false, reason: auto };

  const messageId = mail.messageId ? normalizeMessageId(mail.messageId) : opts.fallbackId;
  const references = splitReferences(mail.references, mail.inReplyTo);
  const text = stripQuotedReply(mail.text ?? '') || (mail.attachments.length ? '(attachment)' : '');

  return {
    ok: true,
    envelope: {
      channel: 'email',
      threadKey: references[0] ?? messageId,
      channelMessageId: messageId,
      from: { identity: { type: 'email', value: address }, displayName: from?.name || undefined },
      subject: mail.subject?.trim() || '(no subject)',
      text,
      attachments: opts.attachments,
      references,
      receivedAt: (mail.date ?? new Date()).toISOString(),
      metadata: {
        to: mail.to ? [mail.to].flat().flatMap((a) => a.value.map((v) => v.address)) : [],
        cc: mail.cc ? [mail.cc].flat().flatMap((a) => a.value.map((v) => v.address)) : [],
      },
    },
  };
}
