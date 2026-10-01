/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/phone-utils.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 */

/** Meta wants digits only: no + prefix, spaces or dashes. "+370 63949836" → "37063949836". */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

/** Digits only, for comparing numbers written in different formats. */
export function normalizePhone(phone: string): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

/**
 * Compares two numbers, allowing for a trunk prefix: "370063949836" (with the
 * domestic 0) matches "37063949836" by their last eight digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1);
  const n2 = normalizePhone(phone2);
  if (n1 === n2) return true;
  if (n1.length >= 8 && n2.length >= 8) return n1.slice(-8) === n2.slice(-8);
  return false;
}

/**
 * True for a stored or inbound number that is E.164-like: 8–15 digits starting
 * with a non-zero digit, with an optional + prefix. It cannot tell a national
 * number from an international one, so numbers typed by a person must go
 * through `parseInternationalPhone` instead.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{7,14}$/.test(phone);
}

/**
 * Parses a number as typed by a person. The international + prefix is
 * required so the country code is explicit; spaces, dots, dashes and
 * parentheses are tolerated. Returns the digits-only form, or null.
 *
 * Without the + requirement a national number passes `isValidE164` and is
 * delivered to whichever country its leading digits happen to spell.
 */
export function parseInternationalPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (!compact.startsWith('+')) return null;
  const digits = compact.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  return isValidE164(digits) ? digits : null;
}
