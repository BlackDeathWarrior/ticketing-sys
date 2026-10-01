import { describe, expect, it } from 'vitest';
import {
  deliveryLine,
  eventSummary,
  expiresAtFor,
  incidentLine,
  isValidSlug,
  keyStatusLabel,
  metadataLabel,
  metadataRows,
  parseRateLimit,
  scopeSummary,
  slugFromName,
  testLine,
  toggle,
  widgetSnippet,
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

describe('incidents on a ticket', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');
  const base = {
    id: 'i1',
    fingerprint: 'scraper.run_failed',
    severity: 'error' as const,
    title: 'Scraper exited with code 1',
    source: null,
    ticket: 'TMS-7',
    firstSeenAt: '2026-10-01T10:00:00.000Z',
    lastSeenAt: '2026-10-01T11:57:00.000Z',
    resolvedAt: null,
  };

  it('says whether it is still happening, how often and since when', () => {
    expect(incidentLine({ ...base, status: 'open', occurrences: 10 }, now)).toBe(
      'Still happening · reported 10 times · first 2h ago · last 3m ago',
    );
    expect(incidentLine({ ...base, status: 'open', occurrences: 1 }, now)).toBe(
      'Still happening · reported once · first 2h ago',
    );
    expect(
      incidentLine(
        { ...base, status: 'resolved', occurrences: 4, resolvedAt: '2026-10-01T11:55:00.000Z' },
        now,
      ),
    ).toBe('Recovered 5m ago · reported 4 times');
  });
});

describe('webhooks', () => {
  const delivery = {
    id: 'd1',
    eventType: 'ticket.created' as const,
    httpStatus: null,
    error: null,
    durationMs: null,
    redeliveryOf: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    deliveredAt: null,
  };

  it('describes a delivery by its outcome', () => {
    expect(
      deliveryLine({
        ...delivery,
        status: 'delivered',
        attempts: 1,
        httpStatus: 200,
        durationMs: 84,
      }),
    ).toBe('Delivered · 200 · 84 ms');
    expect(
      deliveryLine({
        ...delivery,
        status: 'delivered',
        attempts: 3,
        httpStatus: 204,
        durationMs: 9,
      }),
    ).toBe('Delivered · 204 · 9 ms · 3 attempts');
    expect(
      deliveryLine({
        ...delivery,
        status: 'failed',
        attempts: 8,
        httpStatus: 500,
        error: 'HTTP 500',
      }),
    ).toBe('Failed after 8 attempts · HTTP 500');
    expect(deliveryLine({ ...delivery, status: 'pending', attempts: 0 })).toBe(
      'Waiting to be sent',
    );
    expect(
      deliveryLine({ ...delivery, status: 'pending', attempts: 1, error: 'Could not connect' }),
    ).toBe('Trying again · 1 attempt so far · Could not connect');
  });

  it('lists a few events by name and counts many', () => {
    expect(eventSummary(['ticket.created', 'message.created'])).toBe(
      'ticket.created, message.created',
    );
    expect(
      eventSummary(['ticket.created', 'ticket.updated', 'message.created', 'csat.submitted']),
    ).toBe('4 events');
  });

  it('says how a test went', () => {
    expect(testLine({ ok: true, httpStatus: 200, durationMs: 31, error: null })).toBe(
      'The test was delivered: the receiver answered 200 in 31 ms.',
    );
    expect(testLine({ ok: false, httpStatus: 503, durationMs: 12, error: 'HTTP 503' })).toBe(
      'The test failed: HTTP 503.',
    );
  });
});

describe('the chat widget snippet', () => {
  it('loads the script from the helpdesk and names the integration', () => {
    const snippet = widgetSnippet('https://help.example.com', 'ethnic-threads');
    expect(snippet.split('\n').slice(0, 5)).toEqual([
      '<script src="https://help.example.com/widget/tms-chat.js"></script>',
      '<script>',
      '  TMSChat.init({',
      "    server: 'https://help.example.com',",
      "    integration: 'ethnic-threads',",
    ]);
    expect(snippet.endsWith('</script>')).toBe(true);
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
