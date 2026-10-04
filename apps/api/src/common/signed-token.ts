import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Links we email to customers (portal sign-in, rating a ticket) carry a token
 * made from a row id and a MAC of it. Nothing secret is stored: the database
 * holds the id, and only this server can make the matching MAC.
 */
function mac(secret: string, purpose: string, id: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${id}`).digest('base64url');
}

export function signToken(secret: string, purpose: string, id: string): string {
  return `${id}.${mac(secret, purpose, id)}`;
}

/** The id inside a token made for this purpose, or null when it is not ours. */
export function readToken(secret: string, purpose: string, token: string): string | null {
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(secret, purpose, id));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return id;
}
