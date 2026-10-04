import { Injectable } from '@nestjs/common';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { languageCode, type PhoneTranscript } from './phone-provider';

const TIMEOUT_MS = 10_000;
const RECORDING_TIMEOUT_MS = 60_000;
/** About an hour and a half of the audio Sarvam returns; anything larger is not a call. */
const RECORDING_MAX_BYTES = 120 * 1024 * 1024;

export type { PhoneTranscript };

const CALLER_ROLES = ['user', 'customer', 'caller', 'human'];
const AGENT_ROLES = ['agent', 'assistant', 'bot', 'ai', 'app'];

/**
 * Sarvam's Voice Agents API (ADR 0039), for what we need after a call. The
 * transcript is always fetched here with our own key: what a webhook says
 * was said is never taken on trust.
 */
@Injectable()
export class SarvamAgentsClient {
  constructor(private readonly channels: ChannelConfigService) {}

  /** The call's transcript, or null while Sarvam does not have it (yet). */
  async transcript(interactionId: string): Promise<PhoneTranscript | null> {
    const c = await this.channels.phone();
    if (!c?.apiKey) throw new Error('The Voice Agents API key is not set');
    const res = await fetch(this.url(c, 'transcripts', interactionId), {
      headers: { 'X-API-Key': c.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sarvam answered HTTP ${res.status} for the transcript`);
    return parseTranscript(await res.json());
  }

  /**
   * The call's recording as Sarvam keeps it (a WAV file, seen on the first
   * real call), or null when there is none, it is not ready, or it is not a
   * WAV of a sensible size.
   */
  async recording(interactionId: string): Promise<Buffer | null> {
    const c = await this.channels.phone();
    if (!c?.apiKey) return null;
    const res = await fetch(this.url(c, 'recordings', interactionId), {
      headers: { 'X-API-Key': c.apiKey },
      signal: AbortSignal.timeout(RECORDING_TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('audio/')) return null;
    const wav = Buffer.from(await res.arrayBuffer());
    const isWav = wav.subarray(0, 4).toString('latin1') === 'RIFF';
    return isWav && wav.length <= RECORDING_MAX_BYTES ? wav : null;
  }

  private url(
    c: { orgId: string; workspaceId: string; appId: string },
    kind: 'transcripts' | 'recordings',
    interactionId: string,
  ): URL {
    const path = [c.orgId, c.workspaceId, c.appId, kind, interactionId]
      .map(encodeURIComponent)
      .join('/');
    return new URL(`/api/analytics/v1/${path}`, this.channels.sarvamAgentsUrl);
  }
}

/**
 * Sarvam does not document this response. Its webhook documents
 * `interaction_transcript` as turns with a role and a text, so that is what is
 * read, wherever it sits; anything else fails loudly with the names of the
 * keys it had (never the text), so the shape can be added.
 */
export function parseTranscript(body: unknown): PhoneTranscript {
  const root = (body ?? {}) as Record<string, unknown>;
  const holder = [root, root.data, root.transcript, root.interaction_transcript].find(
    (x) => turnsOf(x) !== null,
  );
  const raw = turnsOf(holder);
  if (!raw) {
    throw new Error(`Unexpected transcript shape: ${Object.keys(root).join(', ') || 'no keys'}`);
  }
  const turns: PhoneTranscript['turns'] = [];
  for (const item of raw) {
    const t = (item ?? {}) as Record<string, unknown>;
    const said = [t.text, t.content, t.message, t.english_text].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const who = String(t.role ?? t.speaker ?? '').toLowerCase();
    const role = CALLER_ROLES.includes(who) ? 'caller' : AGENT_ROLES.includes(who) ? 'agent' : null;
    // Tool and system lines are not something either side said.
    if (said && role) turns.push({ role, text: said.trim() });
  }
  if (raw.length && !turns.length) {
    // Turns we cannot read are not "nobody spoke": say what they look like, never what was said.
    const first = (raw[0] ?? {}) as Record<string, unknown>;
    const roles = [
      ...new Set(raw.map((x) => String((x as Record<string, unknown>)?.role ?? '?'))),
    ].slice(0, 6);
    throw new Error(
      `Unexpected transcript turns: keys ${Object.keys(first).join(', ') || 'none'}; roles ${roles.join(', ')}`,
    );
  }
  const seconds = [root.duration, root.duration_in_seconds].find(
    (v): v is number => typeof v === 'number' && v >= 0,
  );
  // Sarvam names the language on each turn ("Hindi"): the call's is the caller's first.
  const firstCaller = raw.find((x) =>
    CALLER_ROLES.includes(String((x as Record<string, unknown>)?.role ?? '').toLowerCase()),
  ) as Record<string, unknown> | undefined;
  const language = [
    root.language,
    root.language_code,
    root.language_name,
    firstCaller?.language_name,
    firstCaller?.language,
  ].find((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    turns,
    seconds: seconds === undefined ? null : Math.round(seconds),
    language: languageCode(language),
  };
}

function turnsOf(x: unknown): unknown[] | null {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    for (const key of ['interaction_transcript', 'transcript', 'turns', 'messages']) {
      if (Array.isArray(o[key])) return o[key] as unknown[];
    }
  }
  return null;
}
