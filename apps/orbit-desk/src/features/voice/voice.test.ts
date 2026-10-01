import type { VoiceCallView } from '@tms/shared';
import { describe, expect, it } from 'vitest';
import { answeredByText, callLine } from './logic';
import { downsampleToPcm16, Framer, frameLevel, pcm16ToFloat } from './voice-audio';

const call = (over: Partial<VoiceCallView> = {}): VoiceCallView => ({
  id: 'c1',
  ticketId: 't1',
  conversationId: 'v1',
  status: 'ended',
  state: null,
  startedAt: '2026-10-01T14:05:00Z',
  endedAt: '2026-10-01T14:08:20Z',
  durationSeconds: 200,
  language: 'hi',
  endedReason: 'caller_hung_up',
  answeredBy: 'ai',
  agent: null,
  recording: null,
  ...over,
});

describe('call summary', () => {
  it('says when, how long and in which language', () => {
    const line = callLine(call());
    expect(line).toMatch(/^Call on 1 Oct, \d{2}:\d{2} · 3m 20s · Hindi$/);
    expect(callLine(call({ durationSeconds: 42, language: null }))).toMatch(/ · 42s$/);
    expect(callLine(call({ durationSeconds: 120, language: 'en' }))).toMatch(/ · 2m · English$/);
  });

  it('says who answered', () => {
    expect(answeredByText(call())).toBe('Answered by the AI');
    expect(
      answeredByText(call({ answeredBy: 'both', agent: { id: 'u', name: 'Jonah Reyes' } })),
    ).toBe('Answered by the AI, then Jonah Reyes');
    expect(answeredByText(call({ answeredBy: 'human', agent: null }))).toBe('Answered by a person');
    expect(answeredByText(call({ answeredBy: null }))).toBe('Nobody spoke for us');
  });
});

describe('voice audio', () => {
  it('downsamples 48 kHz microphone audio to 16 kHz PCM', () => {
    const input = new Float32Array(480).fill(0.5);
    const out = downsampleToPcm16(input, 48_000, 16_000);
    expect(out).toHaveLength(160);
    expect(out[0]).toBe(Math.round(0.5 * 0x7fff - 0.5));
    // Loud input is clipped, not wrapped around.
    expect(downsampleToPcm16(new Float32Array([2, -2]), 16_000, 16_000)).toEqual(
      new Int16Array([0x7fff, -0x8000]),
    );
  });

  it('cuts a stream into 100 ms frames and carries the rest over', () => {
    const framer = new Framer();
    expect(framer.push(new Int16Array(1000))).toHaveLength(0);
    const frames = framer.push(new Int16Array(2500));
    expect(frames.map((f) => f.length)).toEqual([1600, 1600]);
    expect(framer.push(new Int16Array(1300))).toHaveLength(1);
  });

  it('turns PCM back into samples for playback and measures loudness', () => {
    expect(pcm16ToFloat(new Int16Array([0, 16384, -32768]))).toEqual(
      new Float32Array([0, 0.5, -1]),
    );
    expect(frameLevel(new Int16Array(160))).toBe(0);
    expect(frameLevel(new Int16Array(160).fill(16384))).toBe(1);
    expect(frameLevel(new Int16Array(0))).toBe(0);
  });
});
