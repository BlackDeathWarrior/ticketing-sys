import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checks the `ElevenLabs-Signature` header of a post-call webhook, as
 * ElevenLabs' own SDK does (`constructEvent` in elevenlabs-js, read
 * 2026-10-04): the header is `t=<unix seconds>,v0=<hex>`, and the hex is the
 * HMAC-SHA256 of `<t>.<raw body>` under the webhook's secret. A signature
 * older than `maxAgeSeconds` is refused, so a captured request cannot be sent
 * again later.
 */
export function verifyElevenLabsSignature(
  header: string | undefined,
  rawBody: Buffer | string,
  secret: string,
  maxAgeSeconds: number,
  now = new Date(),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim());
  const time = parts.find((p) => p.startsWith('t='))?.slice(2);
  const given = parts.find((p) => p.startsWith('v0='))?.slice(3);
  if (!time || !given || !/^\d{1,12}$/.test(time)) return false;
  if (Number(time) * 1000 < now.getTime() - maxAgeSeconds * 1000) return false;
  const expected = createHmac('sha256', secret).update(`${time}.`).update(rawBody).digest('hex');
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
