import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for stored secrets. Format: `v1:<iv>:<ciphertext>:<tag>`, each
 * part base64url. GCM authenticates the ciphertext, so a tampered row fails to
 * decrypt instead of yielding a garbled credential. The `key` (a secret's
 * name) is bound as additional authenticated data, so a ciphertext can't be
 * copied onto another key's row.
 *
 * Adapted from whatsapp-crm `src/lib/whatsapp/encryption.ts`
 * (MIT, Copyright (c) 2026 Arnas Donauskas).
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function encryptSecret(masterKey: Buffer, key: string, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(key, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ct, tag]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join(':');
}

export function decryptSecret(masterKey: Buffer, key: string, stored: string): string {
  const [version, iv, ct, tag] = stored.split(':');
  if (version !== VERSION || !iv || ct === undefined || !tag) {
    throw new Error('Unrecognised secret format');
  }
  const ivBuf = Buffer.from(iv, 'base64url');
  const tagBuf = Buffer.from(tag, 'base64url');
  if (ivBuf.length !== IV_BYTES || tagBuf.length !== TAG_BYTES) {
    throw new Error('Unrecognised secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, ivBuf);
  decipher.setAAD(Buffer.from(key, 'utf8'));
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}

/** A fixed, clearly-labelled key for development and tests when TMS_SECRETS_KEY is unset. */
export const DEV_MASTER_KEY = createHash('sha256').update('tms-dev-only-secrets-key').digest();

export function masterKeyFrom(base64: string | undefined): Buffer {
  return base64 ? Buffer.from(base64, 'base64') : DEV_MASTER_KEY;
}
