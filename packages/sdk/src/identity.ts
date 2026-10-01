import { createHmac } from 'node:crypto';

export interface ChatIdentity {
  /** Your own id for the signed-in person: the same id your API calls use as `customer.externalId`. */
  sub?: string;
  email?: string;
  name?: string;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/**
 * A token that vouches for a signed-in visitor to the chat widget
 * (`TMSChat.init({ identityToken })`). Sign it on your server with the
 * integration's chat identity secret, per page load: it is short-lived on
 * purpose. Never ship the secret to a browser.
 */
export function signChatIdentity(
  identity: ChatIdentity,
  secret: string,
  opts: { ttlSeconds?: number; nowSeconds?: number } = {},
): string {
  if (!identity.sub && !identity.email) {
    throw new Error('A chat identity needs a sub or an email');
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      ...(identity.sub ? { sub: identity.sub } : {}),
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      iat: now,
      exp: now + (opts.ttlSeconds ?? 300),
    }),
  );
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
