/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/webhook-signature.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the app secret comes from the caller (the encrypted
 * secrets store) instead of the META_APP_SECRET environment variable.
 */
import crypto from 'node:crypto';

/**
 * Splits the stored app secret into its candidates: comma-separated, trimmed,
 * empties dropped. Each Meta app signs with its own secret, so a deployment
 * that receives webhooks from several apps accepts any of them.
 */
export function parseAppSecrets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function signatureMatches(
  rawBody: string | Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies the HMAC-SHA256 signature Meta attaches to webhook POSTs
 * (`x-hub-signature-256: sha256=<hex>`, over the raw body, keyed with the App
 * Secret). Fails closed: with no secret configured every request is rejected.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 */
export function verifyMetaWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secrets: string[],
): boolean {
  if (secrets.length === 0) return false;
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  // No early return: every candidate is compared in constant time, so the
  // cost depends on how many apps are configured, not on the secrets.
  let ok = false;
  for (const secret of secrets) {
    if (signatureMatches(rawBody, signatureHeader, secret)) ok = true;
  }
  return ok;
}

/** Constant-time comparison for the `hub.verify_token` handshake. */
export function tokensEqual(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
