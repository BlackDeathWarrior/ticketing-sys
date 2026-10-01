import { describe, expect, it } from 'vitest';
import { HEALTH_LABELS, whatsappConnectSchema, worstState } from './channel-health';

describe('channel status', () => {
  it('shows the worst check', () => {
    expect(worstState(['ok', 'ok'])).toBe('ok');
    expect(worstState(['ok', 'warning', 'ok'])).toBe('warning');
    expect(worstState(['warning', 'down', 'ok'])).toBe('down');
  });

  it('ignores checks that are off, and is off when nothing is on', () => {
    expect(worstState(['off', 'ok'])).toBe('ok');
    expect(worstState(['off', 'off'])).toBe('off');
    expect(worstState([])).toBe('off');
  });

  it('has a plain label for every light', () => {
    expect(HEALTH_LABELS).toEqual({
      ok: 'Working',
      warning: 'Needs attention',
      down: 'Not working',
      off: 'Off',
    });
  });
});

describe('WhatsApp connect form', () => {
  const ids = { phoneNumberId: '1055512345', wabaId: '2055512345' };

  it('needs both IDs as digits and defaults the Graph version', () => {
    expect(whatsappConnectSchema.parse(ids)).toEqual({ ...ids, graphVersion: 'v23.0' });
    expect(whatsappConnectSchema.safeParse({ ...ids, phoneNumberId: '+1 555 0100' }).success).toBe(
      false,
    );
    expect(whatsappConnectSchema.safeParse({ phoneNumberId: ids.phoneNumberId }).success).toBe(
      false,
    );
  });

  it('takes keys only when given, and a six-digit PIN', () => {
    const parsed = whatsappConnectSchema.parse({ ...ids, accessToken: ' token ', pin: '123456' });
    expect(parsed.accessToken).toBe('token');
    expect(parsed.appSecret).toBeUndefined();
    expect(whatsappConnectSchema.safeParse({ ...ids, pin: '1234' }).success).toBe(false);
    expect(whatsappConnectSchema.safeParse({ ...ids, accessToken: '' }).success).toBe(false);
  });
});
