import { z } from 'zod';

/**
 * Voice calls in the browser (ADR 0018). The caller's page streams microphone
 * audio to the `/voice` socket; the server transcribes it (Sarvam Saaras),
 * lets the AI or a person answer, and streams speech back (Sarvam Bulbul).
 */
export const VOICE_NAMESPACE = '/voice';
/** Audio on the wire, both ways: 16-bit little-endian mono PCM at this rate. */
export const VOICE_SAMPLE_RATE = 16_000;
/** How much audio the caller's page sends per frame. */
export const VOICE_FRAME_MS = 100;

/**
 * Who is speaking to the caller:
 * `greeting` the opening notice, `listening` waiting for the caller,
 * `thinking` the AI is working, `speaking` the AI is talking,
 * `waiting` handed over and nobody has joined yet, `human` a person is on the call.
 */
export const VOICE_STATES = [
  'greeting',
  'listening',
  'thinking',
  'speaking',
  'waiting',
  'human',
  'ended',
] as const;
export type VoiceState = (typeof VOICE_STATES)[number];

export const VOICE_STATE_LABELS: Record<VoiceState, string> = {
  greeting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  waiting: 'Waiting for a person',
  human: 'With a person',
  ended: 'Call ended',
};

/** The languages Sarvam's Bulbul voices speak (BCP-47 base code → Sarvam code). */
export const VOICE_LANGUAGES: Record<string, { code: string; name: string }> = {
  en: { code: 'en-IN', name: 'English' },
  hi: { code: 'hi-IN', name: 'Hindi' },
  bn: { code: 'bn-IN', name: 'Bengali' },
  ta: { code: 'ta-IN', name: 'Tamil' },
  te: { code: 'te-IN', name: 'Telugu' },
  gu: { code: 'gu-IN', name: 'Gujarati' },
  kn: { code: 'kn-IN', name: 'Kannada' },
  ml: { code: 'ml-IN', name: 'Malayalam' },
  mr: { code: 'mr-IN', name: 'Marathi' },
  pa: { code: 'pa-IN', name: 'Punjabi' },
  od: { code: 'od-IN', name: 'Odia' },
};

/** `hi-IN` → `hi`; `or` (ISO for Odia) → `od`, which is what Sarvam calls it. */
export function baseLanguage(code: string | null | undefined): string | null {
  const base = code?.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'unknown') return null;
  return base === 'or' ? 'od' : base;
}

/**
 * The voice to answer in. A language Bulbul can't speak falls back to
 * English, and `supported` says so, so the caller can be told why.
 */
export function speechLanguage(code: string | null | undefined): {
  code: string;
  supported: boolean;
} {
  const base = baseLanguage(code);
  const known = base ? VOICE_LANGUAGES[base] : undefined;
  return known
    ? { code: known.code, supported: true }
    : { code: 'en-IN', supported: base === null };
}

/** What the caller's page sends to start a call. Starting is the caller's consent to recording. */
export const voiceStartSchema = z.object({
  /** A chat session token, so a call from the chat widget belongs to the same visitor. */
  token: z.string().max(4000).optional(),
  name: z.string().trim().max(200).optional(),
  email: z
    .string()
    .trim()
    .email()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** The caller saw the notice that the call is recorded and transcribed. */
  consent: z.literal(true, {
    errorMap: () => ({ message: 'The call can only start after the recording notice is accepted' }),
  }),
});
export type VoiceStartInput = z.input<typeof voiceStartSchema>;

/** What the server answers to `start`. */
export type VoiceStartResult =
  | { ok: true; callId: string; token: string; sampleRate: number; maxSeconds: number }
  | { ok: false; error: string };

/** A line of the live captions. */
export interface VoiceCaption {
  who: 'caller' | 'ai' | 'agent';
  text: string;
  at: string;
}

export const VOICE_END_REASONS = [
  'caller_hung_up',
  'agent_ended',
  'time_limit',
  'error',
  'server_shutdown',
] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

export interface VoiceCallView {
  id: string;
  ticketId: string | null;
  conversationId: string | null;
  status: 'active' | 'ended';
  /** Only for calls in progress on this server. */
  state: VoiceState | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  language: string | null;
  endedReason: VoiceEndReason | null;
  /** Who spoke for us: the AI, a person, or both. */
  answeredBy: 'ai' | 'human' | 'both' | null;
  agent: { id: string; name: string } | null;
  recording: { bytes: number; expiresAt: string } | null;
}

/** Recordings are deleted after this many days (ADR 0018). */
export const VOICE_RECORDING_DAYS = 30;

/** What an agent's console sends to join a call by voice. */
export const voiceJoinSchema = z.object({ callId: z.string().uuid() });
