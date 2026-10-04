import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env';
import { withinCallingHours } from './calling-hours';
import { fromSarvam } from './phone-hook.guard';

const env = (ips: string) => ({ PHONE_SARVAM_IPS: ips }) as Env;

describe("the phone hooks' address list", () => {
  it('lets every address in while no list is set', () => {
    expect(fromSarvam(env(''), '203.0.113.9')).toBe(true);
  });

  it('lets in only the listed addresses once one is set', () => {
    const listed = env('198.51.100.7, 198.51.100.8');
    expect(fromSarvam(listed, '198.51.100.8')).toBe(true);
    expect(fromSarvam(listed, '203.0.113.9')).toBe(false);
    // Part of a listed address is not that address.
    expect(fromSarvam(listed, '198.51.100')).toBe(false);
  });
});

describe('the hours in which the desk may ring a customer', () => {
  // India time is UTC+5:30 the whole year.
  it.each([
    ['08:59', '2026-10-04T03:29:00Z', false],
    ['09:00', '2026-10-04T03:30:00Z', true],
    ['20:59', '2026-10-04T15:29:00Z', true],
    ['21:00', '2026-10-04T15:30:00Z', false],
    ['00:30, the next day in India', '2026-10-04T19:00:00Z', false],
  ])('at %s India time', (_label, utc, allowed) => {
    expect(withinCallingHours(new Date(utc))).toBe(allowed);
  });
});
