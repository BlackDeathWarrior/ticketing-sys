import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookPayload } from './types';

export const SIGNATURE_HEADER = 'x-tms-signature';
export const EVENT_HEADER = 'x-tms-event';
export const DELIVERY_HEADER = 'x-tms-delivery';
/** How far a signature's timestamp may be from your clock, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** The header TMS sends for `rawBody` at `timestampSeconds`: `t=<unix>,v1=<hex HMAC-SHA256>`. */
export function signWebhook(rawBody: string, secret: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

/**
 * Whether a webhook really came from TMS. Pass the **raw** request body,
 * exactly as received: a parsed and re-serialised copy will not match.
 * A timestamp too far from now is refused, which stops replays.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!signatureHeader) return false;
  const parts = new Map(
    signatureHeader.split(',').map((kv): [string, string] => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = (parts.get('v1') ?? '').toLowerCase();
  if (!Number.isFinite(t) || !v1) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false;

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('The webhook signature is missing, wrong or too old');
    this.name = 'WebhookSignatureError';
  }
}

/**
 * Verifies and parses a webhook in one step. Throws `WebhookSignatureError`
 * when it is not from TMS: answer 401 and do nothing else with the body.
 * Deliveries can repeat: use `payload.id` to do each one's work once.
 */
export function parseWebhook<T = Record<string, unknown>>(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): WebhookPayload<T> {
  if (!verifyWebhookSignature(rawBody, signatureHeader, secret, opts)) {
    throw new WebhookSignatureError();
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return JSON.parse(body) as WebhookPayload<T>;
}
