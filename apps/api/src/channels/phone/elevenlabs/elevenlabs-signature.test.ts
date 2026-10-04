import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyElevenLabsSignature } from './elevenlabs-signature';

const SECRET = 'wsec_test_secret';
const BODY = JSON.stringify({ type: 'post_call_transcription', data: { conversation_id: 'c1' } });
const NOW = new Date('2026-10-04T10:00:00Z');
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

/** The header ElevenLabs sends: `t=<unix seconds>,v0=<hmac of "<t>.<body>">`. */
function header(body = BODY, secret = SECRET, at = NOW): string {
  const t = seconds(at);
  return `t=${t},v0=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}
const verify = (h: string | undefined, body: Buffer | string = BODY, secret = SECRET) =>
  verifyElevenLabsSignature(h, body, secret, 1800, NOW);

describe('the signature on an ElevenLabs call event', () => {
  it('accepts a body signed with the webhook secret, as text or as bytes', () => {
    expect(verify(header())).toBe(true);
    expect(verify(header(), Buffer.from(BODY))).toBe(true);
  });

  it('refuses a body that was changed after signing', () => {
    expect(verify(header(), BODY.replace('c1', 'c2'))).toBe(false);
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(header(BODY, 'someone-elses-secret'))).toBe(false);
  });

  it('refuses a request captured earlier and sent again after half an hour', () => {
    const old = new Date(NOW.getTime() - 31 * 60_000);
    expect(verify(header(BODY, SECRET, old))).toBe(false);
    const recent = new Date(NOW.getTime() - 29 * 60_000);
    expect(verify(header(BODY, SECRET, recent))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['no timestamp', `v0=${'a'.repeat(64)}`],
    ['no signature', `t=${seconds(NOW)}`],
    ['a timestamp that is not a number', `t=now,v0=${'a'.repeat(64)}`],
    ['a signature of another length', `t=${seconds(NOW)},v0=abc`],
  ])('refuses %s', (_what, h) => {
    expect(verify(h)).toBe(false);
  });

  it('refuses everything while no secret is saved', () => {
    expect(verify(header(BODY, ''), BODY, '')).toBe(false);
  });
});
