import { waWindow, type WaTemplateView } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { deliveryLabel } from '../../data/adapters';
import { templateFields, templateInput, templateLabel, templateReady, windowNote } from './logic';

const template = (over: Partial<WaTemplateView> = {}): WaTemplateView => ({
  id: '0b9d2f0e-6f0a-4c59-9d4d-3a4e0c1b2a3f',
  name: 'ticket_update',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  headerType: null,
  headerText: null,
  bodyText: 'Hi {{1}}, we have an update on your request {{2}}.',
  footerText: null,
  buttons: [],
  syncedAt: '2026-10-01T09:00:00.000Z',
  ...over,
});

describe('WhatsApp window note', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('says how long free replies are still possible', () => {
    expect(windowNote(waWindow('2026-10-01T09:30:00Z', now))).toMatch(
      /free replies for another 21h 30m/,
    );
  });

  it('explains why only a template can be sent', () => {
    expect(windowNote(waWindow('2026-09-29T09:30:00Z', now))).toMatch(/More than 24 hours/);
    expect(windowNote(waWindow(null, now))).toMatch(/has not written on WhatsApp yet/);
  });
});

describe('template picker', () => {
  it('asks for each variable once', () => {
    expect(templateFields(template()).map((f) => f.key)).toEqual(['body.1', 'body.2']);
    expect(templateFields(template({ bodyText: 'No variables here.' }))).toEqual([]);
  });

  it('asks for header and button values when the template has them', () => {
    const fields = templateFields(
      template({
        headerType: 'text',
        headerText: 'Ticket {{1}}',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Thanks' },
          { type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}' },
          { type: 'COPY_CODE', text: 'Copy code', example: 'SAVE10' },
        ],
      }),
    );
    expect(fields.map((f) => [f.key, !!f.optional])).toEqual([
      ['headerText', false],
      ['body.1', false],
      ['body.2', false],
      ['button.1', false],
      ['button.2', true],
    ]);
    expect(templateFields(template({ headerType: 'image' }))[0]).toMatchObject({
      key: 'headerMediaUrl',
      kind: 'url',
    });
  });

  it('is ready only when every required value is filled', () => {
    const t = template();
    expect(templateReady(t, {})).toBe(false);
    expect(templateReady(t, { 'body.1': 'Ada', 'body.2': '   ' })).toBe(false);
    expect(templateReady(t, { 'body.1': 'Ada', 'body.2': 'TMS-7' })).toBe(true);
  });

  it('builds the send request in variable order', () => {
    const t = template({
      buttons: [{ type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}' }],
    });
    expect(
      templateInput(t, { 'body.2': ' TMS-7 ', 'body.1': 'Ada', 'button.0': 'DS-20517' }),
    ).toEqual({
      templateId: t.id,
      body: ['Ada', 'TMS-7'],
      buttonParams: { '0': 'DS-20517' },
    });
  });

  it('labels templates readably', () => {
    expect(templateLabel(template())).toBe('ticket update · en_US');
  });
});

describe('delivery labels', () => {
  it('names what happened to a message, and stays quiet for a plain send', () => {
    expect(deliveryLabel('pending')).toBe('Sending');
    expect(deliveryLabel('delivered')).toBe('Delivered');
    expect(deliveryLabel('read')).toBe('Read');
    expect(deliveryLabel('failed')).toBe('Not delivered');
    expect(deliveryLabel('sent')).toBeNull();
    expect(deliveryLabel('draft')).toBeNull();
    expect(deliveryLabel(null)).toBeNull();
  });
});
