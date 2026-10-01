/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/wa-identity.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: display names show a username as `@name` and a phone as `+digits`.
 */
import { isValidE164, normalizePhone, sanitizePhoneForMeta } from './phone-utils';

/**
 * Sender identity on an inbound WhatsApp webhook.
 *
 * Until 2026 a customer was always a phone number: `messages[].from` and
 * `contacts[].wa_id`. With WhatsApp usernames, Meta gives every user a
 * business-scoped user id (BSUID). Once a user adopts a username and the
 * business has no recent history with them, Meta omits the phone number:
 *
 *   contacts: [{ profile: { name, username }, user_id, parent_user_id }]
 *   messages: [{ from_user_id, from_parent_user_id, id, ... }]
 *
 * A BSUID is stable per (user, business portfolio), so it is the better key
 * when present. Phone stays the fallback.
 *
 * Docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/
 */

/** The `contacts[]` entry Meta pairs with an inbound message. */
export interface WaContactPayload {
  profile?: { name?: string; username?: string };
  /** Phone number. Absent for a username-only sender. */
  wa_id?: string;
  /** BSUID, e.g. "US.13491208655302741918". */
  user_id?: string;
  /** Portfolio-level BSUID, e.g. "US.ENT.11815799212886844830". */
  parent_user_id?: string;
}

/** The identity fields on a `messages[]` entry. */
export interface WaMessageIdentityPayload {
  /** Phone number. Absent for a username-only sender. */
  from?: string;
  from_user_id?: string;
  from_parent_user_id?: string;
}

export interface WaIdentity {
  /** Digits-only phone, or `''` when Meta withheld it. */
  phone: string;
  /** Business-scoped user id, or null. */
  waUserId: string | null;
  /** Portfolio-level BSUID, or null. */
  waParentUserId: string | null;
  /** WhatsApp username (no `@`), or null. */
  waUsername: string | null;
  /** Profile display name, or `''`. */
  name: string;
}

/** BSUIDs are `COUNTRY.digits` or `COUNTRY.ENT.digits`. */
const BSUID_PATTERN = /^[A-Za-z]{2}\.(?:ENT\.)?[A-Za-z0-9]{4,}$/;

/**
 * True for a BSUID or parent BSUID, false for anything phone-shaped. The send
 * path uses this to choose Meta's `recipient` field over `to`. It can't
 * mistake a phone for a BSUID: a sanitized phone is digits only, and every
 * BSUID carries a two-letter prefix and a dot.
 */
export function isBusinessScopedUserId(value: string | null | undefined): boolean {
  return !!value && BSUID_PATTERN.test(value.trim());
}

function cleanUsername(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/^@/, '');
  return trimmed ? trimmed : null;
}

function cleanBsuid(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Anything that doesn't look like a BSUID is refused rather than stored: a
  // bad value would become a permanent wrong key, and the phone is still there.
  return isBusinessScopedUserId(trimmed) ? trimmed : null;
}

/**
 * Collapses a message and its paired `contacts[]` entry into one identity.
 * The message-level fields win when the two disagree, since they describe the
 * delivery being processed.
 */
export function resolveInboundIdentity(
  message: WaMessageIdentityPayload,
  contact?: WaContactPayload,
): WaIdentity {
  return {
    phone: normalizePhone(message.from ?? contact?.wa_id ?? ''),
    waUserId: cleanBsuid(message.from_user_id) ?? cleanBsuid(contact?.user_id),
    waParentUserId: cleanBsuid(message.from_parent_user_id) ?? cleanBsuid(contact?.parent_user_id),
    waUsername: cleanUsername(contact?.profile?.username),
    name: contact?.profile?.name?.trim() ?? '',
  };
}

/** False when Meta gave neither a phone nor a BSUID: there is no key to file the message under. */
export function hasUsableIdentity(identity: WaIdentity): boolean {
  return !!identity.phone || !!identity.waUserId;
}

/** Best label for the person: profile name, then username, then phone, then the BSUID. */
export function identityDisplayName(identity: WaIdentity): string {
  if (identity.name) return identity.name;
  if (identity.waUsername) return `@${identity.waUsername}`;
  if (identity.phone) return `+${identity.phone}`;
  return identity.waUserId ?? '';
}

export interface WaSendTarget {
  /** The value to hand a `meta-api` sender as `to`. */
  target: string;
  isPhone: boolean;
}

/**
 * How to address a send at a contact, or null when we can't. Phone is
 * preferred; the BSUID is the fallback, so a customer who adopted a WhatsApp
 * username can still be answered.
 */
export function resolveContactSendTarget(
  contact: { phone?: string | null; waUserId?: string | null } | null | undefined,
): WaSendTarget | null {
  const sanitized = sanitizePhoneForMeta(contact?.phone ?? '');
  if (isValidE164(sanitized)) return { target: sanitized, isPhone: true };

  const waUserId = contact?.waUserId?.trim();
  if (isBusinessScopedUserId(waUserId)) return { target: waUserId as string, isPhone: false };

  return null;
}
