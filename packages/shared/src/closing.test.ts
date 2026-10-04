import { describe, expect, it } from 'vitest';
import { aiBehaviourSchema, quietTimeMs } from './ai';

const MINUTE = 60_000;
const behaviour = (over: Record<string, unknown> = {}) => aiBehaviourSchema.parse(over);

describe('how long a ticket the AI answered may stay silent', () => {
  it('is short on the channels where a customer is waiting, by default', () => {
    const b = behaviour();
    expect(quietTimeMs(b, 'webchat')).toBe(10 * MINUTE);
    expect(quietTimeMs(b, 'whatsapp')).toBe(10 * MINUTE);
    expect(quietTimeMs(b, 'email')).toBe(30 * MINUTE);
  });

  it('is the general setting on a channel with no time of its own', () => {
    expect(quietTimeMs(behaviour(), 'api')).toBe(72 * 60 * MINUTE);
    expect(quietTimeMs(behaviour({ autoResolveHours: 8 }), 'web_form')).toBe(8 * 60 * MINUTE);
  });

  it('is what an admin set for the channel, before any default', () => {
    const b = behaviour({ closing: { quietMinutes: { webchat: 45, api: 5 } } });
    expect(quietTimeMs(b, 'webchat')).toBe(45 * MINUTE);
    expect(quietTimeMs(b, 'api')).toBe(5 * MINUTE);
  });

  it('is never when set to 0, for one channel or in general', () => {
    expect(quietTimeMs(behaviour({ closing: { quietMinutes: { webchat: 0 } } }), 'webchat')).toBe(
      0,
    );
    expect(quietTimeMs(behaviour({ autoResolveHours: 0 }), 'api')).toBe(0);
    // The general 0 does not reach a channel that has its own default.
    expect(quietTimeMs(behaviour({ autoResolveHours: 0 }), 'webchat')).toBe(10 * MINUTE);
  });
});
