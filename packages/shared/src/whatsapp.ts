import { z } from 'zod';

/** Meta lets a business answer freely for 24 hours after the customer's last message. */
export const WA_WINDOW_HOURS = 24;
/** The longest text body Meta accepts. */
export const WA_TEXT_MAX = 4096;
/** Inbound media above this size is not copied into storage. */
export const WA_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export interface WaWindow {
  open: boolean;
  /** When the window closes (or closed); null when the customer has never written. */
  closesAt: string | null;
  minutesLeft: number;
}

/** The customer-service window, from the customer's last message time. */
export function waWindow(lastInboundAt: string | null | undefined, now = new Date()): WaWindow {
  const last = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  if (Number.isNaN(last)) return { open: false, closesAt: null, minutesLeft: 0 };
  const closes = last + WA_WINDOW_HOURS * 3_600_000;
  const minutesLeft = Math.max(0, Math.floor((closes - now.getTime()) / 60_000));
  return { open: closes > now.getTime(), closesAt: new Date(closes).toISOString(), minutesLeft };
}

/** What a WhatsApp conversation remembers about the person on the other end. */
export interface WaConversationMeta {
  /** Digits-only phone number; absent or null for a username-only sender. */
  waPhone?: string | null;
  /** Business-scoped user id (BSUID). */
  waUserId?: string;
  waUsername?: string;
  profileName?: string;
  /** Our number the customer wrote to. */
  phoneNumberId?: string;
  /** Meta's timestamp of the customer's last message; opens the 24-hour window. */
  lastInboundAt?: string;
}

// ---- Templates ----

/** Meta's template states, stored as sent. Only APPROVED templates can be sent. */
export const WA_TEMPLATE_STATUSES = [
  'APPROVED',
  'PENDING',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
] as const;
export type WaTemplateStatus = (typeof WA_TEMPLATE_STATUSES)[number];

export type WaTemplateButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone_number: string }
  | { type: 'COPY_CODE'; text: string; example: string };

export type WaHeaderType = 'text' | 'image' | 'video' | 'document';

export interface WaTemplateView {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  headerType: WaHeaderType | null;
  headerText: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: WaTemplateButton[];
  syncedAt: string;
}

/** The distinct `{{N}}` placeholders in a template text, in ascending order. */
export function templateVariables(text: string | null | undefined): number[] {
  const seen = new Set<number>();
  for (const m of (text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/** Fills `{{N}}` placeholders; missing values stay visible as `{{N}}`. */
export function renderTemplateText(text: string, values: string[]): string {
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => values[Number(n) - 1] ?? whole);
}

/** The message as the customer will read it, for the conversation history. */
export function templatePreview(
  t: Pick<WaTemplateView, 'headerType' | 'headerText' | 'bodyText' | 'footerText'>,
  values: { body?: string[]; headerText?: string } = {},
): string {
  const header =
    t.headerType === 'text' && t.headerText
      ? renderTemplateText(t.headerText, values.headerText ? [values.headerText] : [])
      : null;
  return [header, renderTemplateText(t.bodyText, values.body ?? []), t.footerText]
    .filter((part): part is string => !!part)
    .join('\n\n');
}

const variable = z.string().trim().min(1).max(1000);

export const sendTemplateSchema = z.object({
  templateId: z.string().uuid(),
  /** Values for body {{1}}, {{2}}, … in order. */
  body: z.array(variable).max(20).default([]),
  /** Value for a text header's {{1}}. */
  headerText: variable.optional(),
  /** Public link for an image, video or document header. */
  headerMediaUrl: z.string().trim().url().max(2000).optional(),
  /** Values for URL or copy-code buttons, keyed by the button's position. */
  buttonParams: z.record(z.string().regex(/^\d$/), variable).default({}),
});
export type SendTemplateInput = z.input<typeof sendTemplateSchema>;
export type ParsedSendTemplate = z.output<typeof sendTemplateSchema>;

export interface WaTemplateSyncResult {
  total: number;
  approved: number;
  removed: number;
}

/** Stored on an outbound template message; the sender posts exactly this. */
export interface WaTemplateSend {
  name: string;
  language: string;
  components: unknown[];
}
