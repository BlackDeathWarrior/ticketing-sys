import type {
  SpeakOptions,
  SpeechProvider,
  Transcriber,
  TranscriberHandlers,
} from '../src/channels/voice/speech';

/**
 * A speech service for tests: nothing is recognised or synthesised. The test
 * says what each speaker "said", and every reply is recorded as text with a
 * short burst of silence as its audio. It stands in at the SpeechProvider
 * interface, inside the test process; the real client is tested separately
 * against a WebSocket server (sarvam-speech.test.ts).
 */
export class ScriptedSpeech implements SpeechProvider {
  /** One entry per open transcriber, in the order they were opened: caller first, then agent. */
  readonly ears: Array<{ handlers: TranscriberHandlers; heard: Buffer[]; closed: boolean }> = [];
  readonly spoken: Array<{ text: string; language: string; aborted: boolean }> = [];
  /** Milliseconds of audio produced per reply. */
  audioMs = 20;
  /** While set, `speak` stays "talking" until released or interrupted. */
  hold?: Promise<void>;
  refuse?: Error;

  async transcribe(handlers: TranscriberHandlers): Promise<Transcriber> {
    if (this.refuse) throw this.refuse;
    const ear = { handlers, heard: [] as Buffer[], closed: false };
    this.ears.push(ear);
    return {
      send: (pcm) => void ear.heard.push(pcm),
      close: () => void (ear.closed = true),
    };
  }

  async speak(options: SpeakOptions): Promise<void> {
    const entry = { text: options.text, language: options.language, aborted: false };
    this.spoken.push(entry);
    if (options.signal.aborted) {
      entry.aborted = true;
      return;
    }
    options.onAudio(Buffer.alloc(Math.round(16 * this.audioMs) * 2, 1));
    if (this.hold) {
      await Promise.race([
        this.hold,
        new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    }
    entry.aborted = options.signal.aborted;
  }

  /** The caller finishes saying something. */
  callerSays(text: string, language: string | null = 'en-IN'): void {
    this.ears[0]!.handlers.onSpeechStart();
    this.ears[0]!.handlers.onTranscript({ text, language });
  }

  /** The caller starts talking (no words yet): the barge-in signal. */
  callerStartsTalking(): void {
    this.ears[0]!.handlers.onSpeechStart();
  }

  agentSays(text: string): void {
    this.ears[1]!.handlers.onTranscript({ text, language: 'en-IN' });
  }
}

/** Polls until `check` is truthy. */
export async function until<T>(
  check: () => T | undefined | null | false,
  what: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
