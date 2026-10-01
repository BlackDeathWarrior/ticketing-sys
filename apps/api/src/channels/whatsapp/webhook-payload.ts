/*
 * Adapted from whatsapp-crm (a fork of ArnasDon/wacrm), src/app/api/whatsapp/webhook/route.ts
 * and src/app/api/whatsapp/templates/sync/route.ts at commit 47100ad.
 * MIT License, Copyright (c) 2026 Arnas Donauskas. See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: only the payload shapes and the pure parsing are kept; the
 * Supabase writes, flows and broadcasts are not.
 */
import type { WaHeaderType, WaTemplateButton } from '@tms/shared';
import type { MetaStatusError } from './meta-errors';
import type { MetaTemplate, MetaTemplateButton } from './meta-api';
import type { WaContactPayload, WaMessageIdentityPayload } from './wa-identity';

interface WaMedia {
  id: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

export interface WaMessage extends WaMessageIdentityPayload {
  id: string;
  /** Epoch seconds, as a string. */
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: WaMedia;
  video?: WaMedia;
  document?: WaMedia;
  audio?: WaMedia;
  sticker?: WaMedia;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  reaction?: { message_id: string; emoji?: string };
  /** The customer tapped a button or list row on an interactive message. */
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  /** The customer tapped a quick-reply button on a template message. */
  button?: { text?: string; payload?: string };
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id?: string };
  /** Present on `type: 'unsupported'`. */
  errors?: MetaStatusError[];
}

export interface WaStatus {
  /** The id Meta returned when we sent the message. */
  id: string;
  status: string;
  timestamp: string;
  recipient_id?: string;
  /** Only on `failed`. */
  errors?: MetaStatusError[];
}

export interface WaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WaContactPayload[];
  messages?: WaMessage[];
  statuses?: WaStatus[];
  /** `message_template_status_update` changes. */
  event?: string;
  message_template_name?: string;
  message_template_language?: string;
}

export interface WaWebhookPayload {
  object?: string;
  entry?: Array<{ id: string; changes?: Array<{ field: string; value: WaChangeValue }> }>;
}

export interface WaContent {
  /** Message text, caption or a readable stand-in. */
  text: string;
  media: { id: string; mimeType: string; filename: string | null; kind: string } | null;
}

/** Messages that are not something a customer said: no ticket is opened for them. */
export function isIgnorable(message: WaMessage): boolean {
  return (
    message.type === 'reaction' || message.type === 'system' || message.type === 'request_welcome'
  );
}

/** The paired `contacts[]` entry for a message, matched on phone or BSUID. */
export function contactFor(
  message: WaMessage,
  contacts: WaContactPayload[] | undefined,
): WaContactPayload | undefined {
  if (!contacts?.length) return undefined;
  return (
    contacts.find(
      (c) =>
        (!!message.from && c.wa_id === message.from) ||
        (!!message.from_user_id && c.user_id === message.from_user_id),
    ) ?? (contacts.length === 1 ? contacts[0] : undefined)
  );
}

/** What the customer sent, as text plus at most one media file. */
export function messageContent(message: WaMessage): WaContent {
  const media = (kind: 'image' | 'video' | 'document' | 'audio' | 'sticker', m?: WaMedia) =>
    m?.id
      ? {
          id: m.id,
          mimeType: m.mime_type || 'application/octet-stream',
          filename: m.filename ?? null,
          kind,
        }
      : null;

  switch (message.type) {
    case 'text':
      return { text: message.text?.body ?? '', media: null };
    case 'image':
      return { text: message.image?.caption ?? '', media: media('image', message.image) };
    case 'video':
      return { text: message.video?.caption ?? '', media: media('video', message.video) };
    case 'document':
      return { text: message.document?.caption ?? '', media: media('document', message.document) };
    case 'audio':
      return { text: '', media: media('audio', message.audio) };
    case 'sticker':
      return { text: '', media: media('sticker', message.sticker) };
    case 'location': {
      const loc = message.location;
      if (!loc) return { text: '[Location]', media: null };
      const parts = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`].filter(Boolean);
      return { text: `Location: ${parts.join(' - ')}`, media: null };
    }
    case 'interactive': {
      const reply = message.interactive?.button_reply ?? message.interactive?.list_reply;
      return { text: reply?.title || reply?.id || '[Interactive reply]', media: null };
    }
    case 'button':
      // `text` is the visible label; `payload` the value set on the template's button.
      return { text: message.button?.text || message.button?.payload || '[Button]', media: null };
    default:
      return { text: `[Unsupported WhatsApp message: ${message.type}]`, media: null };
  }
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** `audio/ogg; codecs=opus` (what Meta sends for a voice note) → `audio/ogg`. */
export function normalizeMimeType(value: string | null | undefined): string {
  const base = (value ?? '').split(';')[0]!.trim().toLowerCase();
  return base.includes('/') ? base : 'application/octet-stream';
}

/** A file name for media that arrived without one: `image-1790000000.jpg`. */
export function mediaFilename(
  media: NonNullable<WaContent['media']>,
  messageTimestamp: string,
): string {
  if (media.filename?.trim()) return media.filename.trim().split(/[\\/]/).pop()!;
  const ext = EXTENSIONS[normalizeMimeType(media.mimeType)] ?? 'bin';
  const stamp = messageTimestamp.replace(/\D/g, '');
  return `${media.kind}${stamp ? `-${stamp}` : ''}.${ext}`;
}

/** Meta's epoch-seconds timestamp as ISO, or now when it is missing or nonsense. */
export function messageTime(timestamp: string | undefined, now = new Date()): string {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return now.toISOString();
  const at = new Date(seconds * 1000);
  // A clock ahead of ours would hold the 24-hour window open too long.
  return (at > now ? now : at).toISOString();
}

function parseButtons(metaButtons: MetaTemplateButton[] | undefined): WaTemplateButton[] {
  const out: WaTemplateButton[] = [];
  for (const b of metaButtons ?? []) {
    const example = Array.isArray(b.example) ? b.example[0] : b.example;
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text });
        break;
      case 'URL':
        out.push({ type: 'URL', text: b.text, url: b.url ?? '', ...(example ? { example } : {}) });
        break;
      case 'PHONE_NUMBER':
        out.push({ type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number ?? '' });
        break;
      case 'COPY_CODE':
        out.push({ type: 'COPY_CODE', text: b.text, example: example ?? '' });
        break;
      // OTP, FLOW and others can't be sent from TMS; they are left out.
    }
  }
  return out;
}

/** A template from Meta's list in the shape TMS stores. */
export function templateRow(meta: MetaTemplate) {
  const component = (type: string) => meta.components?.find((c) => c.type?.toUpperCase() === type);
  const header = component('HEADER');
  const format = header?.format?.toLowerCase();
  const headerType: WaHeaderType | null =
    format === 'text' || format === 'image' || format === 'video' || format === 'document'
      ? format
      : null;
  return {
    metaId: meta.id,
    name: meta.name,
    language: meta.language,
    status: meta.status.toUpperCase(),
    category: meta.category.toUpperCase(),
    headerType,
    headerText: headerType === 'text' ? (header?.text ?? null) : null,
    bodyText: component('BODY')?.text ?? '',
    footerText: component('FOOTER')?.text ?? null,
    buttons: parseButtons(component('BUTTONS')?.buttons),
  };
}
