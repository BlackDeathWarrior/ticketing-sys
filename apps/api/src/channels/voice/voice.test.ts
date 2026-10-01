import type { AddressInfo } from 'node:net';
import { VOICE_SAMPLE_RATE, type VoiceCaption, type VoiceState } from '@tms/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { ScriptedSpeech, until } from '../../../test/voice-double';
import { assess } from '../../ai/policy';
import type { Env } from '../../config/env';
import type { ChannelConfigService } from '../../settings/channel-config.service';
import { CallRecorder, pcmFromWav, speechChunks, wavHeader } from './audio';
import { SarvamSpeech } from './sarvam-speech';
import { SpeechUnavailableError } from './speech';
import { type CallerTurn, type SessionHooks, VoiceSession } from './voice-session';

const pcm = (ms: number, value = 1000) => {
  const b = Buffer.alloc((VOICE_SAMPLE_RATE / 1000) * ms * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return b;
};

describe('audio helpers', () => {
  it('writes a WAV header and reads the samples back', () => {
    const data = pcm(10);
    const wav = Buffer.concat([wavHeader(data.length, 16000, 1), data]);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(pcmFromWav(wav).equals(data)).toBe(true);
    // Bare samples pass through untouched.
    expect(pcmFromWav(data)).toBe(data);
  });

  it('splits a reply into sentences, joining very short ones', () => {
    expect(speechChunks('Your order shipped on Monday. It arrives in 3 days. Thanks!')).toEqual([
      'Your order shipped on Monday. It arrives in 3 days. Thanks!',
    ]);
    const long = `${'First sentence that is fairly long and goes on for a while. '.repeat(4)}Short one.`;
    const chunks = speechChunks(long, 130);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 130)).toBe(true);
    expect(chunks.join(' ')).toBe(long.trim());
    // Hindi sentences end with a danda.
    expect(speechChunks('आपका रिफंड जारी हो गया है। यह पाँच दिनों में पहुँचेगा।', 30)).toHaveLength(
      2,
    );
    expect(speechChunks('   ')).toEqual([]);
  });

  it('cuts a sentence that is longer than the limit at a space', () => {
    const chunks = speechChunks('word '.repeat(100).trim(), 60);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
    expect(chunks.join(' ').split(' ')).toHaveLength(100);
  });
});

describe('call recorder', () => {
  const sample = (wav: Buffer, ms: number, channel: 0 | 1) =>
    wav.readInt16LE(44 + (VOICE_SAMPLE_RATE / 1000) * ms * 4 + channel * 2);

  it('puts the caller on the left and our side on the right, where it was heard', () => {
    const r = new CallRecorder(VOICE_SAMPLE_RATE, 60);
    r.caller(pcm(100, 100)); // 0–100 ms: caller talks
    r.ours(pcm(50, 900)); // generated at 100 ms: heard 100–150 ms
    r.caller(pcm(100, 100)); // 100–200 ms
    const wav = r.wav()!;
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.length).toBe(44 + (VOICE_SAMPLE_RATE / 1000) * 200 * 4);
    expect(sample(wav, 50, 0)).toBe(100);
    expect(sample(wav, 50, 1)).toBe(0);
    expect(sample(wav, 120, 1)).toBe(900);
    expect(sample(wav, 170, 1)).toBe(0);
  });

  it('queues bursts one after another, and drops what the caller interrupted', () => {
    const r = new CallRecorder(VOICE_SAMPLE_RATE, 60);
    r.caller(pcm(100));
    r.ours(pcm(200, 500)); // heard 100–300 ms
    r.ours(pcm(200, 700)); // queued: 300–500 ms
    r.caller(pcm(100)); // the clock is at 200 ms when the caller interrupts
    r.cut();
    r.caller(pcm(300));
    const wav = r.wav()!;
    expect(sample(wav, 150, 1)).toBe(500);
    expect(sample(wav, 250, 1)).toBe(0);
    expect(sample(wav, 400, 1)).toBe(0);
  });

  it('stops growing at its limit and is empty when nothing was said', () => {
    expect(new CallRecorder(VOICE_SAMPLE_RATE, 60).wav()).toBeNull();
    const r = new CallRecorder(VOICE_SAMPLE_RATE, 1);
    for (let i = 0; i < 30; i++) r.caller(pcm(100));
    expect(r.seconds).toBeLessThanOrEqual(1.1);
  });
});

describe('voice AI policy', () => {
  const base = {
    reply: 'Refunds take 5 to 7 business days.',
    citedSources: 1,
    confirmedByTool: false,
    unconfidentTurnsBefore: 0,
    behaviour: { sendAt: 0.8, handoverBelow: 0.6, maxFailedTurns: 3 },
  };

  it('never drafts on a call: an unsure answer goes to a person', () => {
    expect(assess({ ...base, selfConfidence: 0.9, mode: 'auto', spoken: true }).decision).toBe(
      'sent',
    );
    expect(assess({ ...base, selfConfidence: 0.7, mode: 'auto', spoken: true })).toMatchObject({
      decision: 'handover',
      rules: ['low_confidence'],
    });
    expect(assess({ ...base, selfConfidence: 0.9, mode: 'draft', spoken: true })).toMatchObject({
      decision: 'handover',
      rules: ['draft_channel'],
    });
    // Other channels still draft.
    expect(assess({ ...base, selfConfidence: 0.7, mode: 'auto' }).decision).toBe('drafted');
  });
});

describe('voice session', () => {
  function setup(answer: (text: string) => CallerTurn | Promise<CallerTurn>, maxSeconds = 60) {
    const speech = new ScriptedSpeech();
    const log = {
      states: [] as VoiceState[],
      captions: [] as VoiceCaption[],
      audio: [] as Buffer[],
      clears: 0,
      toAgent: [] as Buffer[],
      agentSaid: [] as string[],
      warnings: [] as string[],
      ended: null as Parameters<SessionHooks['ended']>[0] | null,
    };
    const session = new VoiceSession(
      speech,
      {
        audio: (b) => void log.audio.push(b),
        clear: () => void log.clears++,
        state: (s) => void log.states.push(s),
        caption: (c) => void log.captions.push(c),
        toAgent: (b) => void log.toAgent.push(b),
        callerSaid: async (text) => answer(text),
        agentSaid: async (text) => void log.agentSaid.push(text),
        ended: async (r) => void (log.ended = r),
        warn: (m) => void log.warnings.push(m),
      },
      { greeting: 'Hello. This call is recorded.', maxSeconds, record: true },
    );
    return { speech, session, log };
  }
  const reply = (text: string, over: Partial<CallerTurn> = {}): CallerTurn => ({
    replies: [text],
    language: 'en',
    handedOver: false,
    ...over,
  });

  it('greets, listens, answers in the caller’s language and listens again', async () => {
    const { speech, session, log } = setup(() =>
      reply('नमस्ते। आपका रिफंड जारी हो गया है।', { language: 'hi' }),
    );
    await session.start();
    await until(() => session.current === 'listening', 'listening after the greeting');
    expect(speech.spoken[0]).toMatchObject({
      text: 'Hello. This call is recorded.',
      language: 'en-IN',
    });

    session.callerAudio(pcm(100));
    expect(speech.ears[0]!.heard).toHaveLength(1);
    speech.callerSays('मेरा रिफंड कब आएगा?', 'hi-IN');
    await until(() => speech.spoken.length === 2 && session.current === 'listening', 'the answer');
    expect(speech.spoken[1]).toMatchObject({ language: 'hi-IN' });
    expect(log.states).toEqual(['listening', 'thinking', 'speaking', 'listening']);
    expect(log.captions.map((c) => c.who)).toEqual(['ai', 'caller', 'ai']);
    expect(log.audio.length).toBe(2);
  });

  it('answers in English when the caller’s language has no voice', async () => {
    const { speech, session } = setup(() =>
      reply('Sorry, I can only speak English here.', { language: 'ur' }),
    );
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    speech.callerSays('…', 'ur-IN');
    await until(() => speech.spoken.length === 2, 'the answer');
    expect(speech.spoken[1]!.language).toBe('en-IN');
  });

  it('stops talking the moment the caller interrupts', async () => {
    const { speech, session, log } = setup(() =>
      reply('A long answer that the caller does not wait for.'),
    );
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    let release!: () => void;
    speech.hold = new Promise<void>((r) => (release = r));
    speech.callerSays('Where is my order?');
    await until(() => session.current === 'speaking', 'speaking');

    speech.callerStartsTalking();
    await until(() => log.clears === 1, 'the page told to stop');
    await until(() => session.current === 'listening', 'listening again');
    expect(speech.spoken.at(-1)!.aborted).toBe(true);
    release();
    // Interrupting silence does nothing.
    speech.callerStartsTalking();
    expect(log.clears).toBe(1);
  });

  it('waits for a person after a handover, and stays quiet while waiting', async () => {
    const turns = [
      reply('Please stay on the line.', { handedOver: true }),
      reply('', { replies: [], handedOver: true }),
    ];
    const { speech, session } = setup(() => turns.shift()!);
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    speech.callerSays('I want to talk to a person');
    await until(() => session.current === 'waiting', 'waiting');
    const said = speech.spoken.length;
    speech.callerSays('Hello? Anyone there?');
    await new Promise((r) => setTimeout(r, 60));
    expect(speech.spoken).toHaveLength(said);
    expect(session.current).toBe('waiting');
  });

  it('connects an agent: the AI goes quiet, audio flows both ways, both are transcribed', async () => {
    const { speech, session, log } = setup(() => reply('', { replies: [], handedOver: true }));
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    await session.agentJoined();
    expect(session.current).toBe('human');
    expect(session.hasAgent).toBe(true);

    session.callerAudio(pcm(100));
    expect(log.toAgent).toHaveLength(1);
    const before = log.audio.length;
    session.agentAudio(pcm(100));
    expect(log.audio).toHaveLength(before + 1);
    expect(speech.ears[1]!.heard).toHaveLength(1);
    speech.agentSays('Hi, this is Jonah. I have your order here.');
    await until(() => log.agentSaid.length === 1, 'agent transcript');
    expect(log.captions.at(-1)).toMatchObject({ who: 'agent' });

    // The caller's words are stored, but the AI says nothing.
    const said = speech.spoken.length;
    speech.callerSays('Thank you');
    await new Promise((r) => setTimeout(r, 60));
    expect(speech.spoken).toHaveLength(said);

    session.agentLeft();
    expect(session.current).toBe('waiting');
    expect(speech.ears[1]!.closed).toBe(true);
  });

  it('ends once, closes its streams and hands over a stereo recording', async () => {
    const { speech, session, log } = setup(() => reply('Thanks for calling.'));
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    session.callerAudio(pcm(200));
    await session.end('caller_hung_up');
    await session.end('error');
    expect(log.ended).toMatchObject({ reason: 'caller_hung_up' });
    expect(log.ended!.recording!.readUInt16LE(22)).toBe(2);
    expect(speech.ears[0]!.closed).toBe(true);
    expect(session.current).toBe('ended');
    // Nothing more is accepted after the call is over.
    session.callerAudio(pcm(100));
    expect(speech.ears[0]!.heard).toHaveLength(1);
  });

  it('ends by itself at the time limit', async () => {
    const { session, log } = setup(() => reply('Sure.'), 0.3);
    await session.start();
    await until(() => log.ended !== null, 'the call ending');
    expect(log.ended).toMatchObject({ reason: 'time_limit' });
    expect(session.current).toBe('ended');
  });

  it('apologises and waits for a person when the answer fails', async () => {
    const { speech, session, log } = setup(() => {
      throw new Error('model down');
    });
    await session.start();
    await until(() => session.current === 'listening', 'listening');
    speech.callerSays('Hello');
    await until(() => session.current === 'waiting', 'waiting');
    expect(speech.spoken.map((x) => x.text).join(' ')).toMatch(/something went wrong/);
    expect(log.warnings.join(' ')).toMatch(/model down/);
  });

  it('refuses to start when speech is unavailable', async () => {
    const { speech, session } = setup(() => reply('x'));
    speech.refuse = new SpeechUnavailableError('The Sarvam API key is not set');
    await expect(session.start()).rejects.toThrow(/not set/);
  });
});

describe('Sarvam speech client', () => {
  let server: WebSocketServer | undefined;
  afterEach(() => server?.close());

  /** A WebSocket server standing where api.sarvam.ai would be, to check what we send. */
  async function sarvam(onConnection: (path: string, socket: import('ws').WebSocket) => void) {
    const seen: Array<{ path: string; key: string | undefined; query: URLSearchParams }> = [];
    server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      verifyClient: (info, done) => {
        const key = info.req.headers['api-subscription-key'];
        done(key === 'good-key', 403, 'Forbidden');
      },
    });
    server.on('connection', (socket, req) => {
      const url = new URL(req.url ?? '/', 'http://x');
      seen.push({
        path: url.pathname,
        key: req.headers['api-subscription-key'] as string | undefined,
        query: url.searchParams,
      });
      onConnection(url.pathname, socket);
    });
    await new Promise((resolve) => server!.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const client = (apiKey: string | null, enabled = true) =>
      new SarvamSpeech(
        { SARVAM_API_URL: `http://127.0.0.1:${port}` } as Env,
        {
          sarvam: async () => ({
            enabled,
            apiKey,
            sttModel: 'saaras:v4',
            ttsModel: 'bulbul:v3',
            defaultSpeaker: 'shubh',
          }),
        } as unknown as ChannelConfigService,
      );
    return { seen, client };
  }

  it('streams audio up and reports speech events and transcripts', async () => {
    const received: unknown[] = [];
    const { seen, client } = await sarvam((_path, socket) => {
      socket.on('message', (raw) => {
        received.push(JSON.parse(String(raw)));
        socket.send(JSON.stringify({ type: 'events', data: { signal_type: 'START_SPEECH' } }));
        socket.send(
          JSON.stringify({
            type: 'data',
            data: { request_id: 'r1', transcript: ' नमस्ते ', language_code: 'hi-IN' },
          }),
        );
        socket.send(JSON.stringify({ type: 'events', data: { signal_type: 'END_SPEECH' } }));
      });
    });
    const events: string[] = [];
    const ears = await client('good-key').transcribe({
      onSpeechStart: () => events.push('start'),
      onSpeechEnd: () => events.push('end'),
      onTranscript: (t) => events.push(`${t.text}|${t.language}`),
      onError: (e) => events.push(`error:${e.message}`),
    });
    ears.send(pcm(100));
    await until(() => events.length === 3, 'events');
    expect(events).toEqual(['start', 'नमस्ते|hi-IN', 'end']);

    expect(seen[0]!.path).toBe('/speech-to-text/ws');
    expect(Object.fromEntries(seen[0]!.query)).toEqual({
      'language-code': 'unknown',
      model: 'saaras:v4',
      mode: 'transcribe',
      sample_rate: '16000',
      input_audio_codec: 'pcm_s16le',
      high_vad_sensitivity: 'true',
      vad_signals: 'true',
    });
    const sent = received[0] as { audio: { data: string; sample_rate: string; encoding: string } };
    expect(sent.audio.sample_rate).toBe('16000');
    expect(sent.audio.encoding).toBe('audio/wav');
    expect(Buffer.from(sent.audio.data, 'base64').equals(pcm(100))).toBe(true);
    ears.close();
    // Closing on purpose is not an error.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(3);
  });

  it('speaks: config, text and flush go up; audio comes back until the final event', async () => {
    const received: Array<{ type: string; data?: Record<string, unknown> }> = [];
    const { seen, client } = await sarvam((_path, socket) => {
      socket.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { type: string };
        received.push(m);
        if (m.type !== 'flush') return;
        const wav = Buffer.concat([wavHeader(pcm(20).length, 16000, 1), pcm(20)]);
        socket.send(
          JSON.stringify({
            type: 'audio',
            data: { content_type: 'audio/wav', audio: wav.toString('base64') },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'audio',
            data: { content_type: 'audio/l16', audio: pcm(30).toString('base64') },
          }),
        );
        socket.send(JSON.stringify({ type: 'event', data: { event_type: 'final' } }));
      });
    });
    const audio: Buffer[] = [];
    await client('good-key').speak({
      text: 'Your refund was issued.',
      language: 'en-IN',
      signal: new AbortController().signal,
      onAudio: (b) => audio.push(b),
    });
    expect(seen[0]!.path).toBe('/text-to-speech/ws');
    expect(Object.fromEntries(seen[0]!.query)).toEqual({
      model: 'bulbul:v3',
      send_completion_event: 'true',
    });
    expect(received.map((m) => m.type)).toEqual(['config', 'text', 'flush']);
    expect(received[0]!.data).toEqual({
      speaker: 'shubh',
      language_code: 'en-IN',
      speech_sample_rate: 16000,
      output_audio_codec: 'linear16',
    });
    expect(received[1]!.data).toEqual({ text: 'Your refund was issued.' });
    // A WAV container is unwrapped; bare samples pass through.
    expect(audio.map((b) => b.length)).toEqual([pcm(20).length, pcm(30).length]);
  });

  it('stops at once when aborted, and reports a server error', async () => {
    const { client } = await sarvam((_path, socket) => {
      socket.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { type: string; data?: { text?: string } };
        if (m.type === 'text' && m.data?.text === 'fail') {
          socket.send(JSON.stringify({ type: 'error', data: { message: 'Insufficient credits' } }));
        }
      });
    });
    const controller = new AbortController();
    const speaking = client('good-key').speak({
      text: 'A reply nobody waits for.',
      language: 'en-IN',
      signal: controller.signal,
      onAudio: () => undefined,
    });
    setTimeout(() => controller.abort(), 30);
    await expect(speaking).resolves.toBeUndefined();

    await expect(
      client('good-key').speak({
        text: 'fail',
        language: 'en-IN',
        signal: new AbortController().signal,
        onAudio: () => undefined,
      }),
    ).rejects.toThrow('Insufficient credits');
  });

  it('says why when Sarvam refuses the key, or voice is off or has no key', async () => {
    const { client } = await sarvam(() => undefined);
    const handlers = {
      onSpeechStart: () => undefined,
      onSpeechEnd: () => undefined,
      onTranscript: () => undefined,
      onError: () => undefined,
    };
    await expect(client('bad-key').transcribe(handlers)).rejects.toThrow(
      'Sarvam rejected the API key',
    );
    await expect(client(null).transcribe(handlers)).rejects.toBeInstanceOf(SpeechUnavailableError);
    await expect(client('good-key', false).transcribe(handlers)).rejects.toThrow(
      'Voice is switched off',
    );
  });
});
