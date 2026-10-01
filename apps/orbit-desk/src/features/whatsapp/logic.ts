import {
  type SendTemplateInput,
  templateVariables,
  type WaTemplateView,
  type WaWindow,
} from '@tms/shared';
import { duration } from '../../lib/format';

/** What the reply box says about WhatsApp's 24-hour rule. */
export function windowNote(w: WaWindow): string {
  if (w.open) {
    return `WhatsApp: free replies for another ${duration(Math.max(1, w.minutesLeft))}. After that, only approved templates.`;
  }
  return w.closesAt
    ? "More than 24 hours since the customer's last message. WhatsApp only allows an approved template now."
    : 'The customer has not written on WhatsApp yet. WhatsApp only allows an approved template to start.';
}

export interface TemplateField {
  /** Where the value goes in the send request. */
  key: string;
  label: string;
  kind: 'text' | 'url';
  /** Copy-code buttons fall back to the template's example. */
  optional?: boolean;
}

/** The values an agent must fill in before a template can be sent. */
export function templateFields(t: WaTemplateView): TemplateField[] {
  const fields: TemplateField[] = [];
  if (t.headerType === 'text' && templateVariables(t.headerText).length > 0) {
    fields.push({ key: 'headerText', label: 'Header {{1}}', kind: 'text' });
  }
  if (t.headerType && t.headerType !== 'text') {
    fields.push({ key: 'headerMediaUrl', label: `Link to the ${t.headerType}`, kind: 'url' });
  }
  for (const n of templateVariables(t.bodyText)) {
    fields.push({ key: `body.${n}`, label: `Message {{${n}}}`, kind: 'text' });
  }
  t.buttons.forEach((b, i) => {
    if (b.type === 'URL' && templateVariables(b.url).length > 0) {
      fields.push({ key: `button.${i}`, label: `Link ending for "${b.text}"`, kind: 'text' });
    }
    if (b.type === 'COPY_CODE') {
      fields.push({
        key: `button.${i}`,
        label: `Code for "${b.text}"`,
        kind: 'text',
        optional: true,
      });
    }
  });
  return fields;
}

/** The request body for a template send, from the picker's field values. */
export function templateInput(
  t: WaTemplateView,
  values: Record<string, string>,
): SendTemplateInput {
  const value = (key: string) => values[key]?.trim() ?? '';
  const count = Math.max(0, ...templateVariables(t.bodyText));
  const buttonParams = Object.fromEntries(
    Object.keys(values)
      .filter((k) => k.startsWith('button.') && value(k))
      .map((k) => [k.slice('button.'.length), value(k)]),
  );
  return {
    templateId: t.id,
    body: Array.from({ length: count }, (_, i) => value(`body.${i + 1}`)),
    ...(value('headerText') ? { headerText: value('headerText') } : {}),
    ...(value('headerMediaUrl') ? { headerMediaUrl: value('headerMediaUrl') } : {}),
    buttonParams,
  };
}

/** Every required field has a value. */
export function templateReady(t: WaTemplateView, values: Record<string, string>): boolean {
  return templateFields(t).every((f) => f.optional || !!values[f.key]?.trim());
}

/** "ticket_update · English (US)" style label for the picker. */
export function templateLabel(t: Pick<WaTemplateView, 'name' | 'language'>): string {
  return `${t.name.replace(/_/g, ' ')} · ${t.language}`;
}

/** Meta's template states in plain words. */
export const TEMPLATE_STATUS_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  PENDING: 'Waiting for Meta',
  REJECTED: 'Rejected by Meta',
  PAUSED: 'Paused by Meta',
  DISABLED: 'Disabled by Meta',
  IN_APPEAL: 'In appeal',
  PENDING_DELETION: 'Being deleted',
};
