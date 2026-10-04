import { describe, expect, it } from 'vitest';
import { startConversationSchema } from './channels';
import { normalizeIdentity } from './customers';
import {
  renderTemplateText,
  sendTemplateSchema,
  templatePreview,
  templateVariables,
  waWindow,
} from './whatsapp';

describe('WhatsApp 24-hour window', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('is open for 24 hours after the customer last wrote', () => {
    expect(waWindow('2026-10-01T09:30:00Z', now)).toEqual({
      open: true,
      closesAt: '2026-10-02T09:30:00.000Z',
      minutesLeft: 21 * 60 + 30,
    });
    expect(waWindow('2026-09-30T12:00:01Z', now).open).toBe(true);
  });

  it('is closed after that, and when the customer has never written', () => {
    expect(waWindow('2026-09-30T12:00:00Z', now)).toMatchObject({ open: false, minutesLeft: 0 });
    expect(waWindow(undefined, now)).toEqual({ open: false, closesAt: null, minutesLeft: 0 });
    expect(waWindow('not a date', now).open).toBe(false);
  });
});

describe('WhatsApp templates', () => {
  it('finds the distinct variables of a text', () => {
    expect(templateVariables('Hi {{1}}, order {{2}} and again {{1}}')).toEqual([1, 2]);
    expect(templateVariables('No variables')).toEqual([]);
    expect(templateVariables(null)).toEqual([]);
  });

  it('fills variables and leaves missing ones visible', () => {
    expect(renderTemplateText('Hi {{1}}, order {{2}}', ['Ada', 'DS-1'])).toBe('Hi Ada, order DS-1');
    expect(renderTemplateText('Hi {{1}}, order {{2}}', ['Ada'])).toBe('Hi Ada, order {{2}}');
  });

  it('previews header, body and footer as the customer reads them', () => {
    const template = {
      headerType: 'text' as const,
      headerText: 'Ticket {{1}}',
      bodyText: 'Hi {{1}}.',
      footerText: 'Demo Store support',
    };
    expect(templatePreview(template, { body: ['Ada'], headerText: 'TMS-7' })).toBe(
      'Ticket TMS-7\n\nHi Ada.\n\nDemo Store support',
    );
    expect(
      templatePreview({ ...template, headerType: 'image', headerText: null, footerText: null }),
    ).toBe('Hi {{1}}.');
  });

  it('validates a template send and a conversation start', () => {
    const templateId = '0b9d2f0e-6f0a-4c59-9d4d-3a4e0c1b2a3f';
    expect(sendTemplateSchema.parse({ templateId })).toEqual({
      templateId,
      body: [],
      buttonParams: {},
    });
    expect(sendTemplateSchema.safeParse({ templateId, body: [''] }).success).toBe(false);
    expect(
      startConversationSchema.safeParse({ channel: 'whatsapp', template: { templateId } }).success,
    ).toBe(true);
    // WhatsApp can't be started with free text, and email still needs a body.
    expect(startConversationSchema.safeParse({ channel: 'whatsapp', body: 'Hi' }).success).toBe(
      false,
    );
    expect(startConversationSchema.safeParse({ channel: 'email' }).success).toBe(false);
  });

  it('keeps a business-scoped user id as it is', () => {
    expect(normalizeIdentity('whatsapp_bsuid', ' US.13491208655302741918 ')).toBe(
      'US.13491208655302741918',
    );
  });
});
