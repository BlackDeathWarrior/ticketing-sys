import {
  API_KEY_SCOPE_LABELS,
  type ApiKeyScope,
  type ApiKeyStatus,
  type IncidentView,
  type WebhookDeliveryView,
  type WebhookEvent,
  type WebhookScope,
  type WebhookTestResult,
} from '@tms/shared';
import { relativeFromIso } from '../settings/logic';

/** A slug suggested from the name: "Acme Store (web)" → "acme-store-web". */
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

/** One line on an incident for the ticket drawer: is it still happening, how often, since when. */
export function incidentLine(i: IncidentView, now = Date.now()): string {
  const times = `reported ${i.occurrences === 1 ? 'once' : `${i.occurrences} times`}`;
  if (i.status === 'resolved') {
    return `Recovered ${relativeFromIso(i.resolvedAt, now)} · ${times}`;
  }
  const first = `first ${relativeFromIso(i.firstSeenAt, now)}`;
  return i.occurrences === 1
    ? `Still happening · ${times} · ${first}`
    : `Still happening · ${times} · ${first} · last ${relativeFromIso(i.lastSeenAt, now)}`;
}

export const SCOPE_LABELS: Record<WebhookScope, string> = {
  own: 'This integration’s tickets and incidents',
  all: 'Every ticket in the workspace',
};

/** "ticket.created, message.created", or a count once the list is long. */
export function eventSummary(events: WebhookEvent[]): string {
  return events.length <= 3 ? events.join(', ') : `${events.length} events`;
}

const attempts = (n: number) => `${n} ${n === 1 ? 'attempt' : 'attempts'}`;

/** One line on a delivery: what happened, and how hard it was. */
export function deliveryLine(d: WebhookDeliveryView): string {
  if (d.status === 'delivered') {
    const tries = d.attempts > 1 ? ` · ${attempts(d.attempts)}` : '';
    return `Delivered · ${d.httpStatus ?? 200}${d.durationMs !== null ? ` · ${d.durationMs} ms` : ''}${tries}`;
  }
  if (d.status === 'failed') {
    return `Failed after ${attempts(d.attempts)}${d.error ? ` · ${d.error}` : ''}`;
  }
  return d.attempts === 0
    ? 'Waiting to be sent'
    : `Trying again · ${attempts(d.attempts)} so far${d.error ? ` · ${d.error}` : ''}`;
}

/** What "Send a test" came back with, in words. */
export function testLine(r: WebhookTestResult): string {
  return r.ok
    ? `The test was delivered: the receiver answered ${r.httpStatus} in ${r.durationMs} ms.`
    : `The test failed: ${r.error ?? 'no answer'}.`;
}

/** What a site pastes to get the chat: the script, then `init` with its integration. */
export function widgetSnippet(origin: string, slug: string): string {
  return [
    `<script src="${origin}/widget/tms-chat.js"></script>`,
    '<script>',
    '  TMSChat.init({',
    `    server: '${origin}',`,
    `    integration: '${slug}',`,
    "    // theme: { primary: '#7a1f3d' },",
    "    // context: { product_id: '…' },",
    "    // identityToken: '<signed on your server for a logged-in visitor>',",
    '  });',
    '</script>',
  ].join('\n');
}

export function toggle<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
}
