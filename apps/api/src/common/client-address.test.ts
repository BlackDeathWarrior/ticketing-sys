import { describe, expect, it } from 'vitest';
import { clientAddress, isPrivateAddress } from './client-address';

describe('isPrivateAddress', () => {
  it('knows loopback, private and link-local ranges', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.10',
      '169.254.169.254',
      '::1',
      '::ffff:172.18.0.5',
      'fd12:3456::1',
      'fe80::1',
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['203.0.113.7', '172.32.0.1', '11.0.0.1', '2001:db8::1', 'unknown', '']) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe('clientAddress', () => {
  it('is the peer when nothing was forwarded', () => {
    expect(clientAddress('203.0.113.7', undefined)).toBe('203.0.113.7');
    expect(clientAddress(undefined, undefined)).toBe('unknown');
  });

  it('believes what our own proxy reports', () => {
    // nginx (private) saw the customer and appended their address.
    expect(clientAddress('172.18.0.9', '203.0.113.7')).toBe('203.0.113.7');
    // Two proxies in a row: Caddy, then nginx.
    expect(clientAddress('::ffff:172.18.0.9', '203.0.113.7, 172.18.0.4')).toBe('203.0.113.7');
  });

  it('ignores a header the caller wrote themselves', () => {
    // Straight to the API from the internet: the header is the caller's own claim.
    expect(clientAddress('203.0.113.7', '198.51.100.1')).toBe('203.0.113.7');
    // Through the proxy: the caller's claim comes first, the proxy's truth after it.
    expect(clientAddress('172.18.0.9', '198.51.100.1, 203.0.113.7')).toBe('203.0.113.7');
    expect(clientAddress('172.18.0.9', ['10.0.0.1', '203.0.113.7'])).toBe('203.0.113.7');
  });

  it('stops at anything that is not an address', () => {
    expect(clientAddress('172.18.0.9', 'not-an-address')).toBe('172.18.0.9');
    expect(clientAddress('172.18.0.9', "'; drop table, 172.18.0.4")).toBe('172.18.0.4');
  });
});
