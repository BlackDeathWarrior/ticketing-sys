import { isIP } from 'node:net';

/**
 * Loopback, private-network and link-local addresses: where our own reverse
 * proxies live (nginx and Caddy sit on the same Docker network as the API).
 */
export function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, '').toLowerCase();
  if (isIP(a) === 4) {
    const [x, y] = a.split('.').map(Number) as [number, number];
    return (
      x === 10 ||
      x === 127 ||
      (x === 172 && y >= 16 && y <= 31) ||
      (x === 192 && y === 168) ||
      (x === 169 && y === 254)
    );
  }
  if (isIP(a) === 6) return a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

/**
 * Who is really calling (ADR 0021). `X-Forwarded-For` is only believed as far
 * as our own proxies wrote it: starting from the connection's peer, each entry
 * (right to left) counts only while the address that reported it is private.
 * A caller can put anything in the header; what they can't do is make a
 * private proxy vouch for it, so rate limits and lockouts count the real
 * address.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | string[] | undefined,
): string {
  let current = peer ?? 'unknown';
  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isPrivateAddress(current) || isIP(chain[i]!.replace(/^::ffff:/i, '')) === 0) break;
    current = chain[i]!;
  }
  return current;
}
