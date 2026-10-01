/**
 * What a voice call needs from a speech service. Sarvam is the one
 * implementation (sarvam-speech.ts); the call logic only knows this
 * interface, so it can be tested without a network.
 */

export const SPEECH_PROVIDER = Symbol('SPEECH_PROVIDER');

export interface TranscriberHandlers {
  /** The caller started talking: stop anything we are saying (barge-in). */
  onSpeechStart(): void;
  onSpeechEnd(): void;
  /** A finished utterance, with the language it was spoken in when known (e.g. `hi-IN`). */
  onTranscript(t: { text: string; language: string | null }): void;
  /** The stream failed and will not recover; the session decides what to do. */
  onError(error: Error): void;
}

/** A live speech-to-text stream for one speaker. */
export interface Transcriber {
  /** 16-bit mono PCM at the call's sample rate. */
  send(pcm: Buffer): void;
  close(): void;
}

export interface SpeakOptions {
  text: string;
  /** A Sarvam language code such as `en-IN`. */
  language: string;
  /** Aborting stops the audio at once (the caller interrupted, or the call ended). */
  signal: AbortSignal;
  /** Called with each piece of 16-bit mono PCM as it is ready. */
  onAudio(pcm: Buffer): void;
}

export interface SpeechProvider {
  /** Opens a transcriber; rejects when the service refuses us (bad key, limit reached). */
  transcribe(handlers: TranscriberHandlers): Promise<Transcriber>;
  /** Speaks a text; resolves when all its audio has been delivered, or it was aborted. */
  speak(options: SpeakOptions): Promise<void>;
}

/** The speech service can't be used: no key, switched off, or it refused us. */
export class SpeechUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpeechUnavailableError';
  }
}
