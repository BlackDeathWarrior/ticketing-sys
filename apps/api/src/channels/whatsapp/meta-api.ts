/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/meta-api.ts and
 * src/app/api/whatsapp/templates/sync/route.ts and src/lib/whatsapp/waba-pairing.ts at commit 47100ad.
 * MIT License, Copyright (c) 2026 Arnas Donauskas. See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the Graph base URL and version come from settings (the
 * original pinned v21.0), every call has a timeout, template components are
 * built by the caller, and only the calls a helpdesk needs are kept.
 */
import {
  CARD_LIKE,
  CARD_VIEW,
  cardBody,
  cardButtonId,
  MAX_CARDS,
  type MessageCard,
  WA_CAROUSEL_BODY_MAX,
} from '@tms/shared';
import { isBusinessScopedUserId } from './wa-identity';

/** Where the Graph API lives and which version to call. */
export interface GraphTarget {
  /** e.g. https://graph.facebook.com */
  baseUrl: string;
  /** e.g. v23.0 */
  version: string;
}

const TIMEOUT_MS = 15_000;
const MEDIA_TIMEOUT_MS = 60_000;

const endpoint = (graph: GraphTarget, path: string) =>
  `${graph.baseUrl.replace(/\/+$/, '')}/${graph.version}/${path}`;

export interface MetaSendResult {
  messageId: string;
}

export interface MetaPhoneInfo {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
}

interface MetaErrorResponse {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    type?: string;
    fbtrace_id?: string;
    /** WhatsApp-specific envelope: `details` is the readable part. */
    error_data?: { messaging_product?: string; details?: string };
  };
}

/** A Graph API failure with Meta's structured envelope preserved. */
export class MetaApiError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;
  readonly httpStatus: number;
  /** `error.error_data.details`: WhatsApp endpoints put the useful text here. */
  readonly details: string | null;

  constructor(
    message: string,
    fields: {
      code?: number | null;
      subcode?: number | null;
      type?: string | null;
      fbtraceId?: string | null;
      httpStatus: number;
      details?: string | null;
    },
  ) {
    super(message);
    this.name = 'MetaApiError';
    this.code = fields.code ?? null;
    this.subcode = fields.subcode ?? null;
    this.type = fields.type ?? null;
    this.fbtraceId = fields.fbtraceId ?? null;
    this.httpStatus = fields.httpStatus;
    this.details = fields.details ?? null;
  }
}

/** Reads a failed Graph response into a MetaApiError. Consumes the body. */
async function readMetaError(response: Response, fallback: string): Promise<MetaApiError> {
  let message = fallback;
  let envelope: MetaErrorResponse['error'] | undefined;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    envelope = data.error;
    if (envelope?.message) message = envelope.message;
  } catch {
    // The body wasn't JSON; keep the fallback.
  }
  return new MetaApiError(message, {
    code: typeof envelope?.code === 'number' ? envelope.code : null,
    subcode: typeof envelope?.error_subcode === 'number' ? envelope.error_subcode : null,
    type: envelope?.type ?? null,
    fbtraceId: envelope?.fbtrace_id ?? null,
    httpStatus: response.status,
    details: envelope?.error_data?.details ?? null,
  });
}

async function graphFetch(
  url: string,
  accessToken: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    // A redirect would carry the token to another host.
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw await readMetaError(response, `Meta API error: ${response.status}`);
  return response;
}

// ---- Phone number and account ----

interface Credentials {
  graph: GraphTarget;
  accessToken: string;
}

/** Reads a phone number's public details; proves the id and token belong together. */
export async function verifyPhoneNumber(
  args: Credentials & { phoneNumberId: string },
): Promise<MetaPhoneInfo> {
  const url = endpoint(
    args.graph,
    `${args.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`,
  );
  return (await (await graphFetch(url, args.accessToken)).json()) as MetaPhoneInfo;
}

/**
 * Subscribes the WhatsApp Business Account to this Meta app's webhook. Needed
 * once per account; Meta answers success when it already exists.
 */
export async function subscribeWabaToApp(args: Credentials & { wabaId: string }): Promise<void> {
  await graphFetch(endpoint(args.graph, `${args.wabaId}/subscribed_apps`), args.accessToken, {
    method: 'POST',
  });
}

export interface SubscribedApp {
  whatsapp_business_api_data?: { id?: string; name?: string; link?: string };
}

/** The apps Meta sends this account's webhooks to. Empty means nothing arrives anywhere. */
export async function getSubscribedApps(
  args: Credentials & { wabaId: string },
): Promise<SubscribedApp[]> {
  const response = await graphFetch(
    endpoint(args.graph, `${args.wabaId}/subscribed_apps`),
    args.accessToken,
  );
  return ((await response.json()) as { data?: SubscribedApp[] }).data ?? [];
}

export interface WabaPhoneNumber {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
}

/**
 * The phone numbers under a WhatsApp Business Account. Used to prove the
 * Phone Number ID belongs to the account ID that was typed: a mismatch saves
 * fine and shows up later as a webhook that never fires.
 */
export async function listWabaPhoneNumbers(
  args: Credentials & { wabaId: string },
): Promise<WabaPhoneNumber[]> {
  const out: WabaPhoneNumber[] = [];
  const graphOrigin = new URL(args.graph.baseUrl).origin;
  let next: string | undefined = endpoint(
    args.graph,
    `${args.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
  );
  for (let page = 0; next && page < 5; page++) {
    if (new URL(next).origin !== graphOrigin) break;
    const response = await graphFetch(next, args.accessToken);
    const data = (await response.json()) as {
      data?: WabaPhoneNumber[];
      paging?: { next?: string };
    };
    out.push(...(data.data ?? []));
    next = data.paging?.next;
  }
  return out;
}

/**
 * Registers a phone number with the Cloud API, using the 6-digit two-step
 * verification PIN set in WhatsApp Manager. Meta's test numbers come
 * registered; real numbers need this once. Already registered counts as done.
 */
export async function registerPhoneNumber(
  args: Credentials & { phoneNumberId: string; pin: string },
): Promise<{ alreadyRegistered: boolean }> {
  try {
    await graphFetch(endpoint(args.graph, `${args.phoneNumberId}/register`), args.accessToken, {
      method: 'POST',
      body: { messaging_product: 'whatsapp', pin: args.pin },
    });
    return { alreadyRegistered: false };
  } catch (err) {
    if (err instanceof MetaApiError && /already.*registered/i.test(err.message)) {
      return { alreadyRegistered: true };
    }
    throw err;
  }
}

/** Why a number is not under an account, naming the numbers Meta does list there. */
export function describeWabaPhoneMismatch(
  numbers: readonly WabaPhoneNumber[],
  phoneNumberId: string,
  wabaId: string,
): string {
  const head = `Phone number ID ${phoneNumberId} does not belong to WhatsApp Business account ${wabaId}.`;
  const tail =
    ' Check both values in Meta → WhatsApp → API setup: the account ID shown there must be the one that lists this number.';
  if (numbers.length === 0) return `${head} Meta lists no phone numbers under that account.${tail}`;
  const listed = numbers
    .slice(0, 5)
    .map((n) => (n.display_phone_number ? `${n.display_phone_number} (${n.id})` : n.id))
    .join(', ');
  const more = numbers.length > 5 ? ` and ${numbers.length - 5} more` : '';
  return `${head} Meta lists these numbers under it: ${listed}${more}.${tail}`;
}

// ---- Sending ----

/**
 * Meta uses two mutually exclusive fields: `to` (with `recipient_type`) for a
 * phone number, and `recipient` for a BSUID. Callers hand over whichever
 * identifier they hold.
 */
function recipientFields(to: string): Record<string, unknown> {
  return isBusinessScopedUserId(to)
    ? { recipient: to.trim() }
    : { recipient_type: 'individual', to };
}

export interface SendArgs extends Credentials {
  phoneNumberId: string;
  to: string;
  /** Meta's id of the message being replied to; WhatsApp shows a quote. */
  contextMessageId?: string;
}

async function postMessage(args: SendArgs, payload: Record<string, unknown>) {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    ...recipientFields(args.to),
    ...payload,
  };
  if (args.contextMessageId) body.context = { message_id: args.contextMessageId };
  const response = await graphFetch(
    endpoint(args.graph, `${args.phoneNumberId}/messages`),
    args.accessToken,
    { method: 'POST', body },
  );
  const data = (await response.json()) as { messages?: Array<{ id?: string }> };
  const messageId = data.messages?.[0]?.id;
  if (!messageId) throw new Error('Meta accepted the message but returned no message id');
  return { messageId };
}

/** Sends free-form text. Only works inside the 24-hour customer service window. */
export function sendTextMessage(args: SendArgs & { text: string }): Promise<MetaSendResult> {
  return postMessage(args, { type: 'text', text: { body: args.text } });
}

/**
 * Sends an approved template: required outside the 24-hour window and for
 * the first message to a customer. `components` come from buildSendComponents.
 */
export function sendTemplateMessage(
  args: SendArgs & { templateName: string; language: string; components: unknown[] },
): Promise<MetaSendResult> {
  const template: Record<string, unknown> = {
    name: args.templateName,
    language: { code: args.language },
  };
  if (args.components.length > 0) template.components = args.components;
  return postMessage(args, { type: 'template', template });
}

/**
 * The `type` Meta wants on a carousel card. "cta_url" on a card that carries
 * quick-reply buttons is what Meta's own quick-reply example showed; it looks
 * odd and no real send has proven it yet. If Meta refuses it, this is the one
 * line to change (its error names the field).
 */
const CAROUSEL_CARD_TYPE = 'cta_url';

/**
 * The buttons a card carries: "I like this", and "View product" when it can
 * open a link. Meta wants the same buttons on every card of a carousel, so
 * the caller says whether all of them have a link. The two kinds of message
 * wrap a button differently: `quick_reply` on a card, `reply` on a single card.
 */
function cardButtons(card: MessageCard, withView: boolean, shape: 'quick_reply' | 'reply') {
  const buttons = [{ id: cardButtonId('like', card.id), title: CARD_LIKE }];
  if (withView) buttons.push({ id: cardButtonId('view', card.id), title: CARD_VIEW });
  return buttons.map((button) => ({ type: shape, [shape]: button }));
}

/**
 * Sends the reply with 2 to 10 picture cards under it as one carousel. A
 * service message: it only works inside the 24-hour customer service window.
 */
export function sendCarouselMessage(
  args: SendArgs & { body: string; cards: MessageCard[] },
): Promise<MetaSendResult> {
  if (args.cards.length < 2 || args.cards.length > MAX_CARDS) {
    throw new RangeError(`A carousel holds 2 to ${MAX_CARDS} cards`);
  }
  const withView = args.cards.every((card) => !!card.url);
  return postMessage(args, {
    type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: args.body },
      action: {
        cards: args.cards.map((card, index) => ({
          card_index: index,
          type: CAROUSEL_CARD_TYPE,
          header: { type: 'image', image: { link: card.imageUrl } },
          body: { text: cardBody(card) },
          action: { buttons: cardButtons(card, withView, 'quick_reply') },
        })),
      },
    },
  });
}

/**
 * Sends the reply with one picture card, as Meta's ordinary reply-button
 * message (a carousel needs two cards). The card's text follows the reply.
 */
export function sendCardMessage(
  args: SendArgs & { body: string; card: MessageCard },
): Promise<MetaSendResult> {
  let text = `${args.body}\n\n${cardBody(args.card)}`.slice(0, WA_CAROUSEL_BODY_MAX);
  // Do not leave half of an emoji behind.
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return postMessage(args, {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'image', image: { link: args.card.imageUrl } },
      body: { text },
      action: { buttons: cardButtons(args.card, !!args.card.url, 'reply') },
    },
  });
}

/**
 * Shows "typing…" in the customer's chat until we send a message or about 25
 * seconds pass. Meta ties it to one of the customer's messages (`messageId`)
 * and marks that message as read.
 */
export async function sendTypingIndicator(
  args: Credentials & { phoneNumberId: string; messageId: string },
): Promise<void> {
  await graphFetch(endpoint(args.graph, `${args.phoneNumberId}/messages`), args.accessToken, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: args.messageId,
      typing_indicator: { type: 'text' },
    },
  });
}

// ---- Media ----

/**
 * Resolves a media id to Meta's short-lived, authenticated CDN URL. The size
 * lets the caller skip a file that is too large without downloading it.
 */
export async function getMediaUrl(
  args: Credentials & { mediaId: string },
): Promise<{ url: string; mimeType: string; fileSize: number | null }> {
  const response = await graphFetch(endpoint(args.graph, args.mediaId), args.accessToken);
  const data = (await response.json()) as { url?: string; mime_type?: string; file_size?: unknown };
  if (!data.url) throw new Error('Media URL not found in Meta response');
  // Documented as a number, but observed as a numeric string too.
  const size = Number(data.file_size);
  return {
    url: data.url,
    mimeType: data.mime_type || 'application/octet-stream',
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

const META_MEDIA_HOSTS = ['fbsbx.com', 'facebook.com', 'fbcdn.net', 'whatsapp.net'];

/**
 * The download needs the access token, so it only goes to Meta: an https
 * host under one of Meta's domains, or the configured Graph host itself.
 */
export function isTrustedMediaUrl(downloadUrl: string, graphBaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(downloadUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.origin === new URL(graphBaseUrl).origin) return true;
  if (url.protocol !== 'https:') return false;
  return META_MEDIA_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** Fetches the bytes behind a URL from getMediaUrl, up to `maxBytes`. */
export async function downloadMedia(args: {
  downloadUrl: string;
  accessToken: string;
  graph: GraphTarget;
  maxBytes: number;
}): Promise<{ buffer: Buffer; contentType: string }> {
  if (!isTrustedMediaUrl(args.downloadUrl, args.graph.baseUrl)) {
    throw new Error('Meta returned a media URL on an unexpected host');
  }
  const response = await fetch(args.downloadUrl, {
    // Redirects are followed: fetch drops the Authorization header when one leaves the host.
    headers: { Authorization: `Bearer ${args.accessToken}` },
    signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    throw new Error('The file is larger than the size limit');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > args.maxBytes) throw new Error('The file is larger than the size limit');
  return {
    buffer,
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

// ---- Templates ----

export interface MetaTemplateButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

export interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaTemplateButton[];
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
}

const TEMPLATE_PAGE_CAP = 20;

/** Every template under a WhatsApp Business Account, following Meta's paging. */
export async function listMessageTemplates(
  args: Credentials & { wabaId: string },
): Promise<MetaTemplate[]> {
  const out: MetaTemplate[] = [];
  const graphOrigin = new URL(args.graph.baseUrl).origin;
  let next: string | undefined = endpoint(
    args.graph,
    `${args.wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components`,
  );
  for (let page = 0; next && page < TEMPLATE_PAGE_CAP; page++) {
    // `paging.next` is followed only on the Graph host: it gets the token too.
    if (new URL(next).origin !== graphOrigin) break;
    const response = await graphFetch(next, args.accessToken);
    const data = (await response.json()) as { data?: MetaTemplate[]; paging?: { next?: string } };
    out.push(...(data.data ?? []));
    next = data.paging?.next;
  }
  return out;
}
