/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/api-keys/keys.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: the `tms_sk_` prefix (from @tms/shared), and the
 * constant-time compare is dropped because keys are looked up by a unique
 * index on the hash.
 */
import { createHash, randomBytes } from 'node:crypto';
import { API_KEY_PREFIX } from '@tms/shared';

/** Characters of the random part shown in Settings, after the prefix. */
const DISPLAY_BODY_CHARS = 8;

export interface GeneratedApiKey {
  /** The key itself: returned to its creator once, never stored. */
  plaintext: string;
  /** SHA-256 hex digest, stored in `api_keys.key_hash`. */
  hash: string;
  /** Not secret: stored in `api_keys.prefix` and shown in Settings. */
  prefix: string;
}

/**
 * A new key, its hash and its display prefix. The body is 32 random bytes, so
 * a fast hash is the right choice: there is nothing to guess, and a slow one
 * would only slow every request down.
 */
export function generateApiKey(): GeneratedApiKey {
  const body = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}${body}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: `${API_KEY_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** A cheap check before hashing and reading the database. */
export function looksLikeApiKey(value: string): boolean {
  return value.startsWith(API_KEY_PREFIX) && value.length > API_KEY_PREFIX.length;
}
