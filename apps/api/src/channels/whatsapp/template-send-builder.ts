/*
 * Ported from whatsapp-crm (a fork of ArnasDon/wacrm), src/lib/whatsapp/template-send-builder.ts
 * at commit 47100ad. MIT License, Copyright (c) 2026 Arnas Donauskas.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Changed for TMS: it reads the TMS template row, and a media header needs a
 * link at send time (TMS does not store a media URL per template).
 */
import { templateVariables, type WaTemplateButton } from '@tms/shared';

/** The fields of a stored template that decide what a send must carry. */
export interface SendableTemplate {
  headerType: string | null;
  headerText: string | null;
  bodyText: string;
  buttons: WaTemplateButton[];
}

export interface SendTimeParams {
  /** Values for body {{1}}, {{2}}, … by position. */
  body?: string[];
  /** Value for a text header's {{1}}. */
  headerText?: string;
  /** Public link for an image, video or document header. */
  headerMediaUrl?: string;
  /** Values for URL and copy-code buttons, keyed by the button's position. */
  buttonParams?: Record<string, string>;
}

type MetaSendParameter =
  | { type: 'text'; text: string }
  | { type: 'image'; image: { link: string } }
  | { type: 'video'; video: { link: string } }
  | { type: 'document'; document: { link: string } }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string };

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | {
      type: 'button';
      sub_type: 'url' | 'quick_reply' | 'copy_code';
      index: string;
      parameters: MetaSendParameter[];
    };

function buildHeaderComponent(
  template: SendableTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const headerType = template.headerType;
  if (!headerType) return null;

  if (headerType === 'text') {
    // A static text header rides along inside the template itself.
    if (templateVariables(template.headerText).length === 0) return null;
    const value = params.headerText;
    if (!value || !value.trim()) {
      throw new Error('The header has a variable {{1}}: give it a value.');
    }
    return { type: 'header', parameters: [{ type: 'text', text: value }] };
  }

  // Meta requires the media component on every send.
  const link = params.headerMediaUrl;
  if (!link) throw new Error(`This template has a ${headerType} header: give it a media link.`);
  return {
    type: 'header',
    parameters: [
      headerType === 'image'
        ? { type: 'image', image: { link } }
        : headerType === 'video'
          ? { type: 'video', video: { link } }
          : { type: 'document', document: { link } },
    ],
  };
}

function buildBodyComponent(
  template: SendableTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const varCount = templateVariables(template.bodyText).length;
  const body = params.body ?? [];
  if (varCount === 0) return null;
  if (body.length < varCount) {
    throw new Error(
      `The message has ${varCount} variable(s) but only ${body.length} value(s) were given.`,
    );
  }
  // Extra values are dropped.
  return {
    type: 'body',
    parameters: body.slice(0, varCount).map((text) => ({ type: 'text', text: String(text) })),
  };
}

function buildButtonComponent(
  button: WaTemplateButton,
  index: number,
  override: string | undefined,
): MetaSendComponent | null {
  switch (button.type) {
    case 'URL': {
      if (templateVariables(button.url).length === 0) return null;
      if (!override || !override.trim()) {
        throw new Error(`Button ${index + 1} ("${button.text}") has a variable: give it a value.`);
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: override }],
      };
    }
    case 'COPY_CODE':
      // Always sent, so the customer gets a real code: the given one, or the template's example.
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: override?.trim() || button.example }],
      };
    case 'QUICK_REPLY':
      if (override === undefined) return null;
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override }],
      };
    case 'PHONE_NUMBER':
      // Never takes send-time values.
      return null;
  }
}

/**
 * Builds the `components` array for sending an approved template. Empty when
 * the template is fully static, which is a valid request. Throws with a
 * readable message when a value is missing, instead of a 400 from Meta that
 * doesn't say which field broke.
 */
export function buildSendComponents(
  template: SendableTemplate,
  params: SendTimeParams = {},
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];
  const header = buildHeaderComponent(template, params);
  if (header) out.push(header);
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  template.buttons.forEach((button, i) => {
    const component = buildButtonComponent(button, i, params.buttonParams?.[String(i)]);
    if (component) out.push(component);
  });
  return out;
}

/**
 * The components for a copy-code authentication template: the code goes in the
 * body and again in the button, which is where Meta documents it.
 */
export function authenticationComponents(code: string): MetaSendComponent[] {
  return [
    { type: 'body', parameters: [{ type: 'text', text: code }] },
    {
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: code }],
    },
  ];
}
