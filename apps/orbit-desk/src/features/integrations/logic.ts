import { API_KEY_SCOPE_LABELS, type ApiKeyScope, type ApiKeyStatus } from '@tms/shared';

/** A slug suggested from the name: "Ethnic Threads (web)" → "ethnic-threads-web". */
export function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export const isValidSlug = (slug: string) => /^[a-z][a-z0-9-]{1,39}$/.test(slug);

const STATUS_LABELS: Record<ApiKeyStatus, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
};
export const keyStatusLabel = (status: ApiKeyStatus) => STATUS_LABELS[status];

/** What a key may do, as one line for the table. */
export const scopeSummary = (scopes: ApiKeyScope[]) =>
  scopes.map((s) => API_KEY_SCOPE_LABELS[s]).join(' · ');

/** Requests per minute typed in a form. */
export function parseRateLimit(text: string): number | 'invalid' {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= 6000 ? n : 'invalid';
}

export const EXPIRY_CHOICES = [
  { value: 'never', label: 'Never', days: null },
  { value: '30', label: 'In 30 days', days: 30 },
  { value: '90', label: 'In 90 days', days: 90 },
  { value: '365', label: 'In a year', days: 365 },
] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]['value'];

/** The moment a key stops working, or null for a key that doesn't expire. */
export function expiresAtFor(choice: ExpiryChoice, now = Date.now()): string | null {
  const days = EXPIRY_CHOICES.find((c) => c.value === choice)?.days ?? null;
  return days === null ? null : new Date(now + days * 86_400_000).toISOString();
}

/** "price_current" and "priceCurrent" both read "Price current". */
export function metadataLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

const METADATA_VALUE_MAX = 300;

/**
 * A ticket's metadata as rows for the drawer. Values are shown as text:
 * nested values as compact JSON, long ones cut, empty ones left out.
 */
export function metadataRows(
  metadata: Record<string, unknown>,
): Array<{ key: string; label: string; value: string }> {
  return Object.entries(metadata)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, v]) => {
      const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return {
        key,
        label: metadataLabel(key),
        value: text.length > METADATA_VALUE_MAX ? `${text.slice(0, METADATA_VALUE_MAX)}…` : text,
      };
    });
}

export function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
}
