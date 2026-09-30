import { webFormSchema, type WebFormInput } from '@tms/shared';

export type FieldName = 'name' | 'email' | 'subject' | 'description' | 'orderNumber' | 'files';
export type FieldErrors = Partial<Record<FieldName, string>>;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** A problem with the chosen files, or null when they can be sent. */
export function checkFiles(
  files: Array<{ name: string; size: number }>,
  maxFiles: number,
  maxBytes: number,
): string | null {
  if (files.length > maxFiles) return `Attach up to ${maxFiles} file${maxFiles === 1 ? '' : 's'}.`;
  const big = files.find((f) => f.size > maxBytes);
  if (big) return `${big.name} is larger than ${formatBytes(maxBytes)}.`;
  return null;
}

/** Validates with the API's own schema, keyed by field for inline messages. */
export function validate(input: WebFormInput): FieldErrors {
  const result = webFormSchema.safeParse(input);
  if (result.success) return {};
  return issuesToErrors(
    result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

/** The API's validation issues ({ path, message }) keyed by field; the first message wins. */
export function issuesToErrors(issues: Array<{ path: string; message: string }>): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const field = i.path as FieldName;
    if (['name', 'email', 'subject', 'description', 'orderNumber'].includes(field)) {
      out[field] ??= i.message;
    }
  }
  return out;
}

/** A readable message from an API error body. */
export function errorMessage(body: unknown, status: number): string {
  const b = body as { message?: unknown } | null;
  if (typeof b?.message === 'string' && b.message !== 'Validation failed') return b.message;
  if (status === 413) return 'Those files are too large to send.';
  if (status >= 500) return 'Something went wrong on our side. Please try again in a minute.';
  return 'Please check the form and try again.';
}

/** A v4 UUID; crypto.randomUUID needs a secure context, so fall back to getRandomValues. */
export function submissionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
