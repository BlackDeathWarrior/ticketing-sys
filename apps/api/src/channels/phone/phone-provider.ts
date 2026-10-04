import { baseLanguage, type PhoneProviderId, VOICE_LANGUAGES } from '@tms/shared';
import type { CallRecording } from '../voice/voice-calls.service';

export interface PhoneTranscript {
  turns: Array<{ role: 'caller' | 'agent'; text: string }>;
  seconds: number | null;
  language: string | null;
}

/** A call's audio as the provider keeps it. */
export type PhoneRecording = CallRecording;

/** A call for the provider to place, with what its agent is to know when the customer answers. */
export interface OutboundCall {
  /** The number to ring, in international form with `+`. */
  to: string;
  variables: {
    customer_name: string;
    company: string;
    about: string;
    ticket_reference: string;
    direction: 'outbound';
    greeting: string;
  };
}

/**
 * One hosted voice agent that answers phone calls (ADR 0040). The desk runs
 * none of them: this is what it needs from each once a call is over.
 * Whatever a webhook said about a call, its content is fetched here with our
 * own key.
 */
export interface PhoneAgentProvider {
  readonly id: PhoneProviderId;
  /** The call's transcript, or null while the provider does not have it (yet). */
  transcript(providerCallId: string): Promise<PhoneTranscript | null>;
  /** The call's recording, or null when there is none or it is not ready. */
  recording(providerCallId: string): Promise<PhoneRecording | null>;
  /**
   * Rings a number. Returns the provider's id for the call when it gives one at once, or
   * its id for the attempt, which its later report carries. Throws when it refuses.
   */
  placeCall(
    call: OutboundCall,
  ): Promise<{ providerCallId: string | null; attemptId: string | null }>;
}

/** `Hindi` or `hi-IN` → `hi`; a language we have no name for is left out. */
export function languageCode(value: string | undefined): string | null {
  if (!value) return null;
  const byName = Object.entries(VOICE_LANGUAGES).find(
    ([, l]) => l.name.toLowerCase() === value.trim().toLowerCase(),
  );
  if (byName) return byName[0];
  const base = baseLanguage(value);
  return base && base in VOICE_LANGUAGES ? base : null;
}
