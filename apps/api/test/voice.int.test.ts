import type { INestApplicationContext } from '@nestjs/common';
import type { VoiceCallView, VoiceCaption, VoiceStartResult, VoiceState } from '@tms/shared';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VoiceCallsService } from '../src/channels/voice/voice-calls.service';
import { VoiceService } from '../src/channels/voice/voice.service';
import type { Env } from '../src/config/env';
import { ENV } from '../src/infra/tokens';
import { ChannelSignalsService } from '../src/settings/channel-signals.service';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { FAKE_LLM_BASE_URL } from './test-env';
import { ScriptedSpeech } from './voice-double';

/**
 * Voice calls over the real sockets, with the helpdesk behind them: tickets,
 * the AI agent, handover, an agent joining, the recording and its retention.
 * Speech itself is scripted (ScriptedSpeech): the test says what was said.
 * The Sarvam client is tested on its own in src/channels/voice/voice.test.ts.
 */
let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let other: Awaited<ReturnType<typeof makeUser>>;
let supervisor: Awaited<ReturnType<typeof makeUser>>;
let providerId: string;
let speech: ScriptedSpeech;
const sockets: Socket[] = [];

const frame = (ms = 100) => Buffer.alloc(16 * ms * 2, 3);

function connect(namespace: '/voice' | '/agent', auth: Record<string, unknown> = {}): Socket {
  const s = io(`${t.baseUrl}${namespace}`, { auth, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

/** A caller's page: connects, starts a call and collects what the server sends. */
async function call(start: Record<string, unknown> = {}) {
  speech = new ScriptedSpeech();
  t.app.get(VoiceService).useSpeech(speech);
  const socket = connect('/voice');
  const log = {
    states: [] as VoiceState[],
    captions: [] as VoiceCaption[],
    audio: [] as Buffer[],
    clears: 0,
    ended: null as string | null,
  };
  socket.on('state', (s: VoiceState) => log.states.push(s));
  socket.on('caption', (c: VoiceCaption) => log.captions.push(c));
  socket.on('audio', (b: Buffer) => log.audio.push(b));
  socket.on('clear', () => log.clears++);
  socket.on('ended', (e: { reason: string }) => (log.ended = e.reason));
  const result = (await socket.emitWithAck('start', {
    name: 'Vera Voice',
    consent: true,
    ...start,
  })) as VoiceStartResult;
  return { socket, log, result };
}

const calls = async (ticketId: string, token = admin) =>
  (await t.call<VoiceCallView[]>('GET', `/tickets/${ticketId}/voice-calls`, { token })).body;

interface Conv {
  id: string;
  controller: string;
  messages: Array<{
    authorType: string;
    authorName: string | null;
    body: string;
    deliveryStatus: string | null;
  }>;
}
const conversation = async (ticketId: string) =>
  (
    (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body as Conv[]
  )[0]!;

/** The ticket of a call, once the caller has spoken. */
async function ticketOf(callId: string): Promise<string> {
  const records = t.app.get(VoiceCallsService);
  return waitFor(async () => (await records.get(callId)).ticketId, 'the call’s ticket');
}

beforeAll(async () => {
  t = await startApp({ listen: true });
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent', { name: 'Jonah Voice' });
  other = await makeUser(t, admin, 'agent', { name: 'Olga Other' });
  supervisor = await makeUser(t, admin, 'supervisor', { name: 'Sana Voice' });
  worker = await startWorker();

  const p = await t.call('POST', '/settings/llm/providers', {
    token: admin,
    body: {
      provider: 'openai_compatible',
      label: `Voice fake ${uniq()}`,
      apiKey: 'fake-voice-key-0000000',
      baseUrl: FAKE_LLM_BASE_URL,
    },
  });
  providerId = p.body.id;
  await t.call('POST', '/settings/llm/models', {
    token: admin,
    body: {
      providerId,
      model: 'scripted-cheap',
      inputCostPerMTok: 0.1,
      outputCostPerMTok: 0.4,
      supportsTools: true,
      supportsJson: true,
    },
  });
  const faq = await t.call('POST', '/kb/documents', {
    token: admin,
    body: {
      source: 'faq',
      title: 'When will my refund reach my card?',
      content: 'Refunds reach your card 5 to 7 business days after we receive the return.',
      visibility: 'public',
    },
  });
  await waitFor(
    async () =>
      (await t.call('GET', `/kb/documents/${faq.body.id}`, { token: admin })).body.indexState ===
      'indexed'
        ? true
        : undefined,
    'FAQ indexed',
    30_000,
  );
  await t.call('POST', `/kb/documents/${faq.body.id}/status`, {
    token: admin,
    body: { status: 'approved' },
  });
}, 90_000);

afterEach(() => {
  while (sockets.length) sockets.pop()!.disconnect();
});

afterAll(async () => {
  await t.call('PUT', '/settings/channels/sarvam', { token: admin, body: { enabled: false } });
  await t.call('DELETE', '/settings/secrets/sarvam.api_key', { token: admin });
  if (providerId) await t.call('DELETE', `/settings/llm/providers/${providerId}`, { token: admin });
  await worker?.close();
  await t?.close();
});

describe('before voice is set up', () => {
  it('tells the caller that calls are not available, and needs the recording notice', async () => {
    const off = await call();
    expect(off.result).toEqual({
      ok: false,
      error: 'Voice calls are not available right now. Please use the chat.',
    });
    const noConsent = await call({ consent: false });
    expect(noConsent.result.ok).toBe(false);
  });
});

describe('voice calls', () => {
  beforeAll(async () => {
    const saved = await t.call('PUT', '/settings/channels/sarvam', {
      token: admin,
      body: { enabled: true, greeting: 'Hello from the test desk. This call is recorded.' },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await t.call('PUT', '/settings/secrets/sarvam.api_key', {
      token: admin,
      body: { value: `test-sarvam-key-${uniq()}` },
    });
  });

  it('greets the caller, answers from the knowledge base and keeps the transcript', async () => {
    const { socket, log, result } = await call();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.sampleRate).toBe(16000);
    await waitFor(() => log.states.includes('listening'), 'listening');
    expect(speech.spoken[0]!.text).toBe('Hello from the test desk. This call is recorded.');
    expect(log.audio.length).toBeGreaterThan(0);

    socket.emit('audio', frame());
    await waitFor(
      () => speech.ears[0]!.heard.length === 1,
      'the caller’s audio reaching speech to text',
    );
    speech.callerSays('When will my refund reach my card? I returned the helmet last week.');
    await waitFor(
      () => log.captions.find((c) => c.who === 'ai' && /5 to 7 business days/.test(c.text)),
      'the spoken answer',
      20_000,
    );
    expect(log.states).toEqual(expect.arrayContaining(['thinking', 'speaking']));

    const ticketId = await ticketOf(result.callId);
    const ticket = (await t.call('GET', `/tickets/${ticketId}`, { token: admin })).body;
    expect(ticket.channel).toBe('voice');
    expect(ticket.customer.displayName).toBe('Vera Voice');
    const conv = await conversation(ticketId);
    expect(conv.controller).toBe('ai');
    expect(conv.messages.map((m) => m.authorType)).toEqual(['customer', 'ai']);
    // Spoken replies are stored as sent: there is nothing left to deliver.
    expect(conv.messages[1]).toMatchObject({ deliveryStatus: 'sent' });
    expect(conv.messages[1]!.body).toMatch(/5 to 7 business days/);

    const live = await calls(ticketId);
    expect(live[0]).toMatchObject({ id: result.callId, status: 'active', recording: null });
    expect(['listening', 'speaking']).toContain(live[0]!.state);

    socket.emit('audio', frame(300));
    await socket.emitWithAck('hangup');
    await waitFor(() => log.ended === 'caller_hung_up', 'ended');
    const done = await waitFor(async () => {
      const [c] = await calls(ticketId);
      return c?.status === 'ended' ? c : undefined;
    }, 'the call record closing');
    expect(done).toMatchObject({ endedReason: 'caller_hung_up', answeredBy: 'ai', state: null });
    expect(done.recording!.bytes).toBeGreaterThan(44);
    expect(done.durationSeconds).toBeGreaterThanOrEqual(0);
    // A queued AI turn must not answer a voice message a second time.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await conversation(ticketId)).messages).toHaveLength(2);
  });

  it('answers a Hindi caller in Hindi', async () => {
    const { log, result } = await call();
    if (!result.ok) throw new Error(result.error);
    await waitFor(() => log.states.includes('listening'), 'listening');
    speech.callerSays('मेरा रिफंड कब आएगा?', 'hi-IN');
    await waitFor(() => speech.spoken.length >= 2, 'a spoken answer', 20_000);
    expect(speech.spoken.at(-1)!.language).toBe('hi-IN');
  });

  it('stops speaking when the caller interrupts', async () => {
    const { socket, log, result } = await call();
    if (!result.ok) throw new Error(result.error);
    await waitFor(() => log.states.includes('listening'), 'listening');
    speech.hold = new Promise(() => undefined);
    speech.callerSays('When will my refund reach my card?');
    await waitFor(() => log.states.at(-1) === 'speaking', 'speaking', 20_000);
    speech.callerStartsTalking();
    await waitFor(() => log.clears === 1, 'the page told to stop playing');
    await waitFor(() => log.states.at(-1) === 'listening', 'listening again');
    await socket.emitWithAck('hangup');
  });

  it('hands over on request; an agent joins and the two talk; listening is for supervisors', async () => {
    const { socket, log, result } = await call();
    if (!result.ok) throw new Error(result.error);
    await waitFor(() => log.states.includes('listening'), 'listening');
    speech.callerSays('I would like to talk to a real person please.');
    await waitFor(() => log.states.at(-1) === 'waiting', 'waiting for a person', 20_000);
    expect(speech.spoken.map((x) => x.text).join(' ')).toMatch(/stay on the line/i);
    const ticketId = await ticketOf(result.callId);
    expect((await t.call('GET', `/tickets/${ticketId}`, { token: admin })).body.handling).toBe(
      'handed_over',
    );

    // Joining needs a signed-in agent, and only one person can be on the call.
    const desk = connect('/agent', { token: agent.token });
    const heard: Buffer[] = [];
    const agentCaptions: VoiceCaption[] = [];
    desk.on('voice:audio', (m: { pcm: Buffer }) => heard.push(m.pcm));
    desk.on('voice:caption', (m: { caption: VoiceCaption }) => agentCaptions.push(m.caption));
    await new Promise<void>((r) => desk.once('connect', () => r()));
    const joined = await waitFor(async () => {
      const r = (await desk.emitWithAck('voice:join', { callId: result.callId })) as {
        ok: boolean;
      };
      return r.ok ? r : undefined;
    }, 'the agent joining');
    expect(joined).toMatchObject({ ok: true, sampleRate: 16000 });
    await waitFor(() => log.states.at(-1) === 'human', 'with a person');

    const second = connect('/agent', { token: other.token });
    await new Promise<void>((r) => second.once('connect', () => r()));
    const refused = await waitFor(async () => {
      const r = (await second.emitWithAck('voice:join', { callId: result.callId })) as {
        ok: boolean;
        error?: string;
      };
      return r.error === 'Not allowed' ? undefined : r;
    }, 'the second agent’s answer');
    expect(refused.ok).toBe(false);

    // On a call people talk: a typed reply would never be heard, so it is refused.
    const voiceConv = await conversation(ticketId);
    const typed = await t.call('POST', `/conversations/${voiceConv.id}/messages`, {
      token: agent.token,
      body: { body: 'Can you hear me?' },
    });
    expect(typed.status).toBe(400);
    expect(typed.body.message).toMatch(/Join the call/);

    // Audio both ways.
    const before = log.audio.length;
    desk.emit('voice:audio', { callId: result.callId, pcm: frame() });
    await waitFor(() => log.audio.length > before, 'the caller hearing the agent');
    socket.emit('audio', frame());
    await waitFor(() => heard.length > 0, 'the agent hearing the caller');

    // Both sides are transcribed; the AI stays quiet.
    speech.agentSays('Hi, this is Jonah. I can see your order.');
    speech.callerSays('Thanks, the bike arrived damaged.');
    const conv = await waitFor(async () => {
      const c = await conversation(ticketId);
      return c.messages.length >= 4 ? c : undefined;
    }, 'both transcripts');
    const said = conv.messages.find((m) => m.authorType === 'agent')!;
    expect(said).toMatchObject({ authorName: 'Jonah Voice', deliveryStatus: 'sent' });
    expect(conv.controller).toBe('human');
    expect(conv.messages.filter((m) => m.authorType === 'ai')).toHaveLength(1);
    expect(agentCaptions.some((c) => c.who === 'caller')).toBe(true);

    // The agent ends the call.
    await desk.emitWithAck('voice:leave', { callId: result.callId, end: true });
    await waitFor(() => log.ended === 'agent_ended', 'ended by the agent');
    const done = await waitFor(async () => {
      const [c] = await calls(ticketId);
      return c?.status === 'ended' ? c : undefined;
    }, 'the call record closing');
    expect(done).toMatchObject({ answeredBy: 'both', agent: { name: 'Jonah Voice' } });

    // The recording: a stereo WAV, for supervisors, and listening is audited.
    const path = `/api/v1/voice/calls/${result.callId}/recording`;
    const denied = await t.app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect(denied.statusCode).toBe(403);
    const file = await t.app.inject({
      method: 'GET',
      url: path,
      headers: { authorization: `Bearer ${supervisor.token}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.rawPayload.toString('ascii', 0, 4)).toBe('RIFF');
    expect(file.rawPayload.readUInt16LE(22)).toBe(2);
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'voice.recording_played', targetId: ticketId },
    });
    expect(audit.body).toHaveLength(1);
  });

  it('deletes recordings after the retention period and keeps the transcript', async () => {
    const { socket, log, result } = await call();
    if (!result.ok) throw new Error(result.error);
    await waitFor(() => log.states.includes('listening'), 'listening');
    socket.emit('audio', frame(200));
    speech.callerSays('When will my refund reach my card?');
    const ticketId = await ticketOf(result.callId);
    await waitFor(() => speech.spoken.length >= 2, 'the answer', 20_000);
    await socket.emitWithAck('hangup');
    await waitFor(async () => (await calls(ticketId))[0]?.recording, 'the recording');

    const records = t.app.get(VoiceCallsService);
    expect(await records.purgeRecordings(30, new Date())).toBe(0);
    const later = new Date(Date.now() + 31 * 86_400_000);
    expect(await records.purgeRecordings(30, later)).toBeGreaterThanOrEqual(1);
    expect((await calls(ticketId))[0]!.recording).toBeNull();
    const gone = await t.app.inject({
      method: 'GET',
      url: `/api/v1/voice/calls/${result.callId}/recording`,
      headers: { authorization: `Bearer ${supervisor.token}` },
    });
    expect(gone.statusCode).toBe(404);
    expect((await conversation(ticketId)).messages.length).toBeGreaterThanOrEqual(2);
  });

  it('ends the call when the page goes away, and keeps nothing of a silent call', async () => {
    const { socket, log, result } = await call();
    if (!result.ok) throw new Error(result.error);
    await waitFor(() => log.states.includes('listening'), 'listening');
    socket.disconnect();
    const records = t.app.get(VoiceCallsService);
    const row = await waitFor(async () => {
      const r = await records.get(result.callId);
      return r.status === 'ended' ? r : undefined;
    }, 'the call ending');
    expect(row).toMatchObject({
      endedReason: 'caller_hung_up',
      ticketId: null,
      recordingKey: null,
    });
  });

  it('refuses a call politely when every line is busy or speech is refused', async () => {
    const env = t.app.get<Env>(ENV);
    const max = env.VOICE_MAX_CALLS;
    env.VOICE_MAX_CALLS = 1;
    try {
      const first = await call();
      expect(first.result.ok).toBe(true);
      const held = speech;
      const second = connect('/voice');
      const busy = (await second.emitWithAck('start', { consent: true })) as VoiceStartResult;
      expect(busy).toEqual({
        ok: false,
        error: 'All our lines are busy. Please try again in a few minutes.',
      });
      await first.socket.emitWithAck('hangup');
      expect(held.ears[0]!.closed).toBe(true);
    } finally {
      env.VOICE_MAX_CALLS = max;
    }

    const refusing = new ScriptedSpeech();
    refusing.refuse = new Error('Sarvam rejected the API key');
    t.app.get(VoiceService).useSpeech(refusing);
    const s = connect('/voice');
    const result = (await s.emitWithAck('start', { consent: true })) as VoiceStartResult;
    expect(result.ok).toBe(false);
  });

  it('shows the voice channel’s light and lines in the channel status', async () => {
    await t.app.get(ChannelSignalsService).clear('sarvam', 'probe');
    const health = (await t.call('GET', '/channels/health', { token: admin })).body as Array<{
      channel: string;
      state: string;
      checks: Array<{ key: string; detail: string }>;
    }>;
    const voice = health.find((h) => h.channel === 'voice')!;
    // Never tested against Sarvam here, so it asks for a connection test.
    expect(voice.state).toBe('warning');
    expect(voice.checks.find((c) => c.key === 'lines')!.detail).toMatch(/^\d+ of \d+ in use$/);
  });
});
