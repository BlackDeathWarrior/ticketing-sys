import { describe, expect, it } from 'vitest';
import { authorLabel, hrefFor, parseRoute, readSession, saveSession } from './portal-logic';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe('help center routes', () => {
  it('reads the page from the URL hash', () => {
    expect(parseRoute('')).toEqual({ page: 'home' });
    expect(parseRoute('#/')).toEqual({ page: 'home' });
    expect(parseRoute('#/portal')).toEqual({ page: 'portal' });
    expect(parseRoute('#/portal/tickets/TMS-42')).toEqual({ page: 'ticket', reference: 'TMS-42' });
    expect(parseRoute('#/portal/verify/abc.DEF_-1')).toEqual({
      page: 'verify',
      token: 'abc.DEF_-1',
    });
    expect(parseRoute('#/rate/abc.DEF_-1')).toEqual({ page: 'rate', token: 'abc.DEF_-1' });
    // Incomplete links fall back to a page that works.
    expect(parseRoute('#/portal/verify')).toEqual({ page: 'portal' });
    expect(parseRoute('#/rate')).toEqual({ page: 'home' });
    expect(parseRoute('#/nonsense')).toEqual({ page: 'home' });
  });

  it('round-trips through hrefFor', () => {
    for (const route of [
      { page: 'home' as const },
      { page: 'portal' as const },
      { page: 'ticket' as const, reference: 'TMS-42' },
      { page: 'verify' as const, token: 'id.mac' },
      { page: 'rate' as const, token: 'id.mac' },
    ]) {
      expect(parseRoute(hrefFor(route))).toEqual(route);
    }
  });
});

describe('portal session', () => {
  const session = {
    token: 'jwt',
    expiresIn: 3600,
    customer: { name: 'Nora Quist', email: 'nora@example.org' },
  };

  it('is kept until it expires, then forgotten', () => {
    const storage = memoryStorage();
    saveSession(storage, session, 1_000);
    expect(readSession(storage, 2_000)).toMatchObject({ token: 'jwt', email: 'nora@example.org' });
    expect(readSession(storage, 1_000 + 3600 * 1000)).toBeNull();
  });

  it('is removed on sign-out and survives broken storage', () => {
    const storage = memoryStorage();
    saveSession(storage, session);
    saveSession(storage, null);
    expect(storage.map.size).toBe(0);
    storage.map.set('tms.portal', '{not json');
    expect(readSession(storage)).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSession(broken)).toBeNull();
  });
});

describe('messages', () => {
  it('names the author the way a customer would', () => {
    expect(authorLabel({ from: 'you', name: null })).toBe('You');
    expect(authorLabel({ from: 'assistant', name: null })).toBe('AI assistant');
    expect(authorLabel({ from: 'support', name: 'Paula' })).toBe('Paula from Support');
    expect(authorLabel({ from: 'support', name: null })).toBe('Support');
  });
});
