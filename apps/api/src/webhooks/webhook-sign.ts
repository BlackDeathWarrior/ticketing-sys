/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/webhooks/sign.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the header is X-TMS-Signature, the tolerance comes from
 * @tms/shared, and a `whsec_` secret generator is added.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK_SECRET_PREFIX, WEBHOOK_TOLERANCE_SECONDS } from '@tms/shared';

/** A new signing secret: 32 random bytes, recognisable by its prefix. */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/**
 * The `X-TMS-Signature` value for `rawBody`: `t=<unix seconds>,v1=<hex HMAC-SHA256>`.
 * The signed text is `<t>.<rawBody>`. The time is passed in so the result is
 * testable and the caller owns the clock.
 */
export function buildSignatureHeader(
  rawBody: string,
  secret: string,
  timestampSeconds: number,
): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}

/**
 * Checks a signature header the way a receiver should: recompute the HMAC
 * over the raw body as received, compare in constant time, and refuse a
 * timestamp too far from now (a replay).
 */
export function verifySignatureHeader(
  header: string,
  rawBody: string,
  secret: string,
  nowSeconds: number,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1)];
    }),
  );
  const t = Number(parts.t);
  // Hex is case-insensitive and a header may carry stray spaces.
  const v1 = typeof parts.v1 === 'string' ? parts.v1.trim().toLowerCase() : '';
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  if (expected.length !== v1.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}
