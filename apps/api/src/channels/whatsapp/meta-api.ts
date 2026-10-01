/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/meta-api.ts and
 * src/app/api/whatsapp/templates/sync/route.ts at commit 47100ad.
 * MIT License, Copyright (c) 2026 Arnas Donauskas. See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the Graph base URL and version come from settings (the
 * original pinned v21.0), every call has a timeout, template components are
 * built by the caller, and only the calls a helpdesk needs are kept.
 */
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

interface SendArgs extends Credentials {
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
