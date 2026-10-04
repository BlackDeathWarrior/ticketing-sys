import { API_KEY_PREFIX } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKey, looksLikeApiKey } from './api-key.util';

describe('API keys', () => {
  it('makes a key that carries the prefix and hashes to what is stored', () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    // 32 random bytes as base64url.
    expect(key.plaintext).toHaveLength(API_KEY_PREFIX.length + 43);
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key.plaintext)).toBe(key.hash);
  });

  it('shows only the start of the key', () => {
    const key = generateApiKey();
    expect(key.prefix).toHaveLength(API_KEY_PREFIX.length + 8);
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
  });

  it('never makes the same key twice', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().plaintext));
    expect(keys.size).toBe(50);
  });

  it('tells a key from a staff access token', () => {
    expect(looksLikeApiKey(generateApiKey().plaintext)).toBe(true);
    expect(looksLikeApiKey('eyJhbGciOiJIUzI1NiJ9.e30.signature')).toBe(false);
    expect(looksLikeApiKey(API_KEY_PREFIX)).toBe(false);
  });
});
