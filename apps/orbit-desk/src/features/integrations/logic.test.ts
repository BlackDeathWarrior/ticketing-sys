import { describe, expect, it } from 'vitest';
import {
  expiresAtFor,
  isValidSlug,
  keyStatusLabel,
  metadataLabel,
  metadataRows,
  parseRateLimit,
  scopeSummary,
  slugFromName,
  toggle,
} from './logic';

describe('integration slugs', () => {
  it('suggests a slug from the name', () => {
    expect(slugFromName('Ethnic Threads (web)')).toBe('ethnic-threads-web');
    expect(slugFromName('  3rd-party CRM  ')).toBe('rd-party-crm');
    expect(slugFromName('A'.repeat(60))).toHaveLength(40);
    expect(slugFromName('!!!')).toBe('');
  });

  it('accepts what the API accepts', () => {
    expect(isValidSlug('ethnic-threads')).toBe(true);
    expect(isValidSlug(slugFromName('Ethnic Threads (web)'))).toBe(true);
    expect(isValidSlug('a')).toBe(false);
    expect(isValidSlug('9lives')).toBe(false);
    expect(isValidSlug('Has Space')).toBe(false);
  });
});

describe('ticket context', () => {
  it('turns keys into labels', () => {
    expect(metadataLabel('price_current')).toBe('Price current');
    expect(metadataLabel('productUrl')).toBe('Product url');
    expect(metadataLabel('scraped-at')).toBe('Scraped at');
    expect(metadataLabel('_')).toBe('_');
  });

  it('shows values as text, leaving out empty ones and cutting long ones', () => {
    const rows = metadataRows({
      source: 'Myntra',
      price_current: 1499,
      in_stock: false,
      rating: null,
      note: '',
      other_sources: [{ source: 'Amazon', price: 1399 }],
      html: '<script>alert(1)</script>'.repeat(20),
    });
    expect(rows.map((r) => r.key)).toEqual([
      'source',
      'price_current',
      'in_stock',
      'other_sources',
      'html',
    ]);
    expect(rows[1]).toEqual({ key: 'price_current', label: 'Price current', value: '1499' });
    expect(rows[2]!.value).toBe('false');
    expect(rows[3]!.value).toBe('[{"source":"Amazon","price":1399}]');
    expect(rows[4]!.value).toHaveLength(301);
  });
});

describe('API key forms', () => {
  it('reads a rate limit within the allowed range', () => {
    expect(parseRateLimit(' 120 ')).toBe(120);
    expect(parseRateLimit('0')).toBe('invalid');
    expect(parseRateLimit('6001')).toBe('invalid');
    expect(parseRateLimit('1.5')).toBe('invalid');
    expect(parseRateLimit('lots')).toBe('invalid');
  });

  it('turns an expiry choice into a date', () => {
    const now = Date.parse('2026-10-01T00:00:00.000Z');
    expect(expiresAtFor('never', now)).toBeNull();
    expect(expiresAtFor('30', now)).toBe('2026-10-31T00:00:00.000Z');
    expect(expiresAtFor('365', now)).toBe('2027-10-01T00:00:00.000Z');
  });

  it('describes scopes and status in words', () => {
    expect(scopeSummary(['integration:event', 'kb:read'])).toBe(
      'Report incidents and recoveries · Search the knowledge base',
    );
    expect(keyStatusLabel('revoked')).toBe('Revoked');
  });

  it('toggles a scope in a list', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});
