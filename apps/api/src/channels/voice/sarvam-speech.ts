import { Inject, Injectable, Logger } from '@nestjs/common';
import { VOICE_SAMPLE_RATE } from '@tms/shared';
import WebSocket from 'ws';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { pcmFromWav } from './audio';
import {
  type SpeakOptions,
  type SpeechProvider,
  SpeechUnavailableError,
  type Transcriber,
  type TranscriberHandlers,
} from './speech';

const CONNECT_TIMEOUT_MS = 8_000;
/** Sarvam closes an idle text-to-speech socket after about a minute. */
const SPEAK_TIMEOUT_MS = 45_000;

interface SttMessage {
  type?: string;
  data?: {
    transcript?: string;
    language_code?: string | null;
    signal_type?: string;
    error?: string;
    code?: string;
  };
}

interface TtsMessage {
  type?: string;
  data?: { audio?: string; content_type?: string; event_type?: string; message?: string };
}

/**
 * Sarvam speech over its streaming WebSockets (ADR 0018):
 *
 * - Speech to text: `/speech-to-text/ws` (Saaras), language auto-detected,
 *   with voice-activity events for barge-in. Audio goes up as base64 PCM.
 * - Text to speech: `/text-to-speech/ws` (Bulbul). One socket per utterance:
 *   the API has no "stop" message, so interrupting means closing the socket.
 *
 * Message shapes follow https://docs.sarvam.ai/api-reference (checked 2026-10-01).
 */
@Injectable()
export class SarvamSpeech implements SpeechProvider {
  private readonly logger = new Logger(SarvamSpeech.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
  ) {}

  async transcribe(handlers: TranscriberHandlers): Promise<Transcriber> {
    const config = await this.config();
    const url = this.socketUrl('/speech-to-text/ws', {
      'language-code': 'unknown',
      model: config.sttModel,
      mode: 'transcribe',
      sample_rate: String(VOICE_SAMPLE_RATE),
      input_audio_codec: 'pcm_s16le',
      high_vad_sensitivity: 'true',
      vad_signals: 'true',
    });
    const socket = await this.open(url, config.apiKey);
    let closed = false;

    socket.on('message', (raw) => {
      const message = parse<SttMessage>(raw);
      if (!message) return;
      if (message.type === 'events') {
        if (message.data?.signal_type === 'START_SPEECH') handlers.onSpeechStart();
        if (message.data?.signal_type === 'END_SPEECH') handlers.onSpeechEnd();
      } else if (message.type === 'data') {
        const text = message.data?.transcript?.trim();
        if (text) handlers.onTranscript({ text, language: message.data?.language_code ?? null });
      } else if (message.type === 'error') {
        handlers.onError(new Error(message.data?.error ?? 'Speech to text failed'));
      }
    });
    socket.on('error', (err) => {
      if (!closed) handlers.onError(err);
    });
    socket.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      handlers.onError(new Error(closeText('Speech to text', code, reason)));
    });

    return {
      send: (pcm) => {
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        socket.send(
          JSON.stringify({
            audio: {
              data: pcm.toString('base64'),
              sample_rate: String(VOICE_SAMPLE_RATE),
              encoding: 'audio/wav',
            },
          }),
        );
      },
      close: () => {
        closed = true;
        socket.close(1000);
      },
    };
  }

  async speak(options: SpeakOptions): Promise<void> {
    if (options.signal.aborted) return;
    const config = await this.config();
    const url = this.socketUrl('/text-to-speech/ws', {
      model: config.ttsModel,
      send_completion_event: 'true',
    });
    const socket = await this.open(url, config.apiKey);
    if (options.signal.aborted) {
      socket.close(1000);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', abort);
        socket.close(1000);
        if (err) reject(err);
        else resolve();
      };
      const abort = () => finish();
      const timer = setTimeout(
        () => finish(new Error('Text to speech took too long')),
        SPEAK_TIMEOUT_MS,
      );
      options.signal.addEventListener('abort', abort, { once: true });

      socket.on('message', (raw) => {
        const message = parse<TtsMessage>(raw);
        if (!message || done) return;
        if (message.type === 'audio' && message.data?.audio) {
          // linear16 arrives as bare samples; a WAV container is unwrapped if Sarvam sends one.
          options.onAudio(pcmFromWav(Buffer.from(message.data.audio, 'base64')));
        } else if (message.type === 'event' && message.data?.event_type === 'final') {
          finish();
        } else if (message.type === 'error') {
          finish(new Error(message.data?.message ?? 'Text to speech failed'));
        }
      });
      socket.on('error', (err) => finish(err));
      socket.on('close', (code, reason) => {
        // Closing before the "final" event means the reply was cut short.
        finish(new Error(closeText('Text to speech', code, reason)));
      });

      socket.send(
        JSON.stringify({
          type: 'config',
          data: {
            speaker: config.defaultSpeaker,
            language_code: options.language,
            speech_sample_rate: VOICE_SAMPLE_RATE,
            output_audio_codec: 'linear16',
          },
        }),
      );
      socket.send(JSON.stringify({ type: 'text', data: { text: options.text.slice(0, 2500) } }));
      socket.send(JSON.stringify({ type: 'flush' }));
    });
  }

  private async config() {
    const config = await this.channels.sarvam();
    if (!config?.enabled) throw new SpeechUnavailableError('Voice is switched off');
    if (!config.apiKey) throw new SpeechUnavailableError('The Sarvam API key is not set');
    return { ...config, apiKey: config.apiKey };
  }

  private socketUrl(path: string, query: Record<string, string>): string {
    const url = new URL(path, this.env.SARVAM_API_URL);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return url.toString();
  }

  /** Opens a socket; a refused handshake (bad key, limit reached) becomes a clear error. */
  private open(url: string, apiKey: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { 'Api-Subscription-Key': apiKey },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });
      const fail = (reason: string) => {
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.terminate();
        this.logger.warn(`Sarvam refused a connection: ${reason}`);
        reject(new SpeechUnavailableError(reason));
      };
      socket.once('open', () => {
        socket.removeAllListeners('error');
        socket.removeAllListeners('unexpected-response');
        resolve(socket);
      });
      socket.once('unexpected-response', (_req, res) => {
        fail(
          res.statusCode === 401 || res.statusCode === 403
            ? 'Sarvam rejected the API key'
            : res.statusCode === 429
              ? 'Sarvam is at its limit of live calls or requests; try again shortly'
              : `Sarvam answered HTTP ${res.statusCode}`,
        );
      });
      socket.once('error', (err) => fail(`Could not reach Sarvam: ${err.message}`));
    });
  }
}

function parse<T>(raw: WebSocket.RawData): T | null {
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

function closeText(what: string, code: number, reason: Buffer): string {
  const detail = reason.toString('utf8').trim();
  return `${what} closed (${code}${detail ? `: ${detail}` : ''})`;
}
