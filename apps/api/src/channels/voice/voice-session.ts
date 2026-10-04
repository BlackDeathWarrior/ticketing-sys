import {
  speechLanguage,
  VOICE_SAMPLE_RATE,
  type VoiceCaption,
  type VoiceEndReason,
  type VoiceState,
} from '@tms/shared';
import { CallRecorder, speechChunks } from './audio';
import type { SpeechProvider, Transcriber } from './speech';

/** What the AI (or the queue) did with something the caller said. */
export interface CallerTurn {
  /** What to say back, in order. Empty when a person is handling the call. */
  replies: string[];
  /** The language to speak in, e.g. `hi`; null keeps the current one. */
  language: string | null;
  /** The call now waits for a person. */
  handedOver: boolean;
}

export interface SessionHooks {
  /** Audio for the caller's page to play. */
  audio(pcm: Buffer): void;
  /** Stop playing at once and drop what is queued (the caller interrupted). */
  clear(): void;
  state(state: VoiceState): void;
  caption(caption: VoiceCaption): void;
  /** The caller's audio, for an agent who has joined. */
  toAgent(pcm: Buffer): void;
  /** Stores what the caller said and lets the AI answer. */
  callerSaid(text: string, language: string | null): Promise<CallerTurn>;
  /** Stores what the agent said. */
  agentSaid(text: string): Promise<void>;
  ended(result: {
    reason: VoiceEndReason;
    recording: Buffer | null;
    seconds: number;
    language: string | null;
  }): Promise<void>;
  warn(message: string): void;
}

export interface SessionOptions {
  greeting: string;
  maxSeconds: number;
  record: boolean;
}

const SAMPLES_PER_MS = VOICE_SAMPLE_RATE / 1000;
const APOLOGY =
  "I'm sorry, something went wrong on our side. Please stay on the line for a colleague.";

/**
 * One voice call in progress (ADR 0018): the caller's audio goes to speech
 * to text; each finished utterance becomes a message and gets an answer,
 * which is spoken back. The caller can interrupt at any time (barge-in). An
 * agent can join, after which the AI is silent and the two are connected.
 *
 * The session knows nothing about sockets, the database or Sarvam: those are
 * the hooks and the speech provider, so every path here can be unit-tested.
 */
export class VoiceSession {
  private state: VoiceState = 'greeting';
  private readonly recorder: CallRecorder | null;
  private callerEars?: Transcriber;
  private agentEars?: Transcriber;
  /** The reply being spoken; aborting it is how a caller interrupts. */
  private speaking?: AbortController;
  /** When the audio already sent will have finished playing on the caller's side. */
  private playbackEnds = 0;
  /** Utterances are answered one at a time, in order. */
  private turns: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private language: string | null = null;
  private agentOn = false;
  private over = false;
  private readonly startedAt = Date.now();

  constructor(
    private readonly speech: SpeechProvider,
    private readonly hooks: SessionHooks,
    private readonly options: SessionOptions,
  ) {
    this.recorder = options.record ? new CallRecorder(VOICE_SAMPLE_RATE, options.maxSeconds) : null;
  }

  get current(): VoiceState {
    return this.state;
  }

  get hasAgent(): boolean {
    return this.agentOn;
  }

  /** Opens the caller's speech-to-text stream and speaks the greeting. Throws if speech is unavailable. */
  async start(): Promise<void> {
    this.callerEars = await this.speech.transcribe({
      onSpeechStart: () => this.interrupt(),
      onSpeechEnd: () => undefined,
      onTranscript: (t) => this.heard(t.text, t.language),
      onError: (err) => {
        this.hooks.warn(`caller speech-to-text stopped: ${err.message}`);
        void this.end('error');
      },
    });
    this.timer = setTimeout(() => void this.end('time_limit'), this.options.maxSeconds * 1000);
    this.turns = this.turns.then(async () => {
      await this.say(this.options.greeting, 'en-IN', 'ai');
      if (this.state === 'greeting' || this.state === 'speaking') this.setState('listening');
    });
  }

  /** A frame of the caller's microphone. */
  callerAudio(pcm: Buffer): void {
    if (this.over) return;
    this.recorder?.caller(pcm);
    this.callerEars?.send(pcm);
    if (this.agentOn) this.hooks.toAgent(pcm);
  }

  /** An agent joined by voice: the AI goes quiet and the two are connected. */
  async agentJoined(): Promise<void> {
    if (this.over || this.agentOn) return;
    this.agentOn = true;
    this.interrupt();
    this.setState('human');
    try {
      this.agentEars = await this.speech.transcribe({
        onSpeechStart: () => undefined,
        onSpeechEnd: () => undefined,
        onTranscript: (t) => {
          this.hooks.caption({ who: 'agent', text: t.text, at: new Date().toISOString() });
          this.hooks
            .agentSaid(t.text)
            .catch((err: Error) => this.hooks.warn(`agent transcript not stored: ${err.message}`));
        },
        // The call goes on without the agent's transcript; the audio is still relayed.
        onError: (err) => this.hooks.warn(`agent speech-to-text stopped: ${err.message}`),
      });
    } catch (err) {
      this.hooks.warn(`agent speech-to-text unavailable: ${(err as Error).message}`);
    }
  }

  /** A frame of the agent's microphone: the caller hears it, and it is transcribed. */
  agentAudio(pcm: Buffer): void {
    if (this.over || !this.agentOn) return;
    this.recorder?.ours(pcm);
    this.hooks.audio(pcm);
    this.agentEars?.send(pcm);
  }

  /** The agent left without ending the call: the caller waits for a person again. */
  agentLeft(): void {
    if (!this.agentOn) return;
    this.agentOn = false;
    this.agentEars?.close();
    this.agentEars = undefined;
    if (!this.over) this.setState('waiting');
  }

  async end(reason: VoiceEndReason): Promise<void> {
    if (this.over) return;
    this.over = true;
    clearTimeout(this.timer);
    this.speaking?.abort();
    this.callerEars?.close();
    this.agentEars?.close();
    this.setState('ended');
    await this.hooks.ended({
      reason,
      recording: this.recorder?.wav() ?? null,
      seconds: Math.round((Date.now() - this.startedAt) / 1000),
      language: this.language,
    });
  }

  /** The caller started talking: whatever we are saying stops, here and on their side. */
  private interrupt(): void {
    const talking = Date.now() < this.playbackEnds || !!this.speaking;
    this.speaking?.abort();
    if (!talking) return;
    this.playbackEnds = 0;
    this.recorder?.cut();
    this.hooks.clear();
  }

  private heard(text: string, language: string | null): void {
    if (this.over) return;
    if (language) this.language = language;
    this.hooks.caption({ who: 'caller', text, at: new Date().toISOString() });
    this.turns = this.turns
      .then(() => this.answer(text, language))
      .catch((err: Error) => this.hooks.warn(`voice turn failed: ${err.message}`));
  }

  private async answer(text: string, language: string | null): Promise<void> {
    if (this.over) return;
    const withPerson = this.agentOn || this.state === 'waiting';
    if (!withPerson) this.setState('thinking');
    let turn: CallerTurn;
    try {
      turn = await this.hooks.callerSaid(text, language);
    } catch (err) {
      this.hooks.warn(`could not answer the caller: ${(err as Error).message}`);
      turn = { replies: withPerson ? [] : [APOLOGY], language: 'en', handedOver: true };
    }
    if (this.over || this.agentOn) return;
    const voice = speechLanguage(turn.language ?? language ?? this.language);
    for (const reply of turn.replies) {
      if (this.over || this.agentOn) return;
      await this.say(reply, voice.code, 'ai');
    }
    if (this.over || this.agentOn) return;
    this.setState(turn.handedOver || this.state === 'waiting' ? 'waiting' : 'listening');
  }

  /** Speaks a text piece by piece, and waits until the caller has heard it (or interrupted). */
  private async say(text: string, language: string, who: 'ai'): Promise<void> {
    if (this.over) return;
    const controller = new AbortController();
    this.speaking = controller;
    if (this.state !== 'greeting') this.setState('speaking');
    this.hooks.caption({ who, text, at: new Date().toISOString() });
    try {
      for (const chunk of speechChunks(text)) {
        if (controller.signal.aborted) break;
        await this.speech.speak({
          text: chunk,
          language,
          signal: controller.signal,
          onAudio: (pcm) => {
            if (controller.signal.aborted || this.over) return;
            this.recorder?.ours(pcm);
            this.hooks.audio(pcm);
            const ms = pcm.length / 2 / SAMPLES_PER_MS;
            this.playbackEnds = Math.max(Date.now(), this.playbackEnds) + ms;
          },
        });
      }
      // Speech is generated faster than it plays: wait out the rest, unless interrupted.
      await waitUntil(() => this.playbackEnds, controller.signal);
    } catch (err) {
      this.hooks.warn(`text to speech failed: ${(err as Error).message}`);
    } finally {
      if (this.speaking === controller) this.speaking = undefined;
    }
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.state(state);
  }
}

/** Resolves when the clock passes `deadline()` (re-read each time, as it can move) or on abort. */
function waitUntil(deadline: () => number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const left = deadline() - Date.now();
      if (left <= 0 || signal.aborted) return resolve();
      timer = setTimeout(tick, Math.min(left, 250));
    };
    let timer: NodeJS.Timeout | undefined;
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    tick();
  });
}
