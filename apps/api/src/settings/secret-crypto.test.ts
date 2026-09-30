import { randomBytes } from 'node:crypto';
import { maskedLast4 } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, masterKeyFrom } from './secret-crypto';

const key = randomBytes(32);

describe('secret encryption', () => {
  it('round-trips and never contains the plaintext', () => {
    const stored = encryptSecret(key, 'sarvam.api_key', 'sk-live-abcdef123456');
    expect(stored).not.toContain('abcdef');
    expect(stored.startsWith('v1:')).toBe(true);
    expect(decryptSecret(key, 'sarvam.api_key', stored)).toBe('sk-live-abcdef123456');
  });

  it('uses a fresh IV each time', () => {
    expect(encryptSecret(key, 'k', 'same')).not.toBe(encryptSecret(key, 'k', 'same'));
  });

  it('rejects a tampered ciphertext', () => {
    const [v, iv, ct, tag] = encryptSecret(key, 'k', 'value-to-protect').split(':');
    const flipped = Buffer.from(ct!, 'base64url');
    flipped[0]! ^= 1;
    expect(() =>
      decryptSecret(key, 'k', [v, iv, flipped.toString('base64url'), tag].join(':')),
    ).toThrow();
  });

  it('binds the ciphertext to its key name', () => {
    const stored = encryptSecret(key, 'whatsapp.access_token', 'token-value-123456');
    expect(() => decryptSecret(key, 'sarvam.api_key', stored)).toThrow();
  });

  it('fails with the wrong master key', () => {
    const stored = encryptSecret(key, 'k', 'value');
    expect(() => decryptSecret(randomBytes(32), 'k', stored)).toThrow();
  });

  it('decodes a base64 master key, falling back to the dev key', () => {
    expect(masterKeyFrom(key.toString('base64')).equals(key)).toBe(true);
    expect(masterKeyFrom(undefined)).toHaveLength(32);
  });
});

describe('masking', () => {
  it('shows the last four characters only for long values', () => {
    expect(maskedLast4('sk-ant-api03-abcdefgh1234')).toBe('1234');
    expect(maskedLast4('short-pass')).toBeNull();
  });
});
