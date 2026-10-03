import { Injectable } from '@nestjs/common';
import { baseLanguage } from '@tms/shared';
import { ChannelConfigService } from '../../settings/channel-config.service';

const TIMEOUT_MS = 10_000;

export interface PhoneTranscript {
  turns: Array<{ role: 'caller' | 'agent'; text: string }>;
  seconds: number | null;
  language: string | null;
}

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
    const path = ['api/analytics/v1', c.orgId, c.workspaceId, c.appId, 'transcripts', interactionId]
      .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
      .join('/');
    const res = await fetch(new URL(`/${path}`, this.channels.sarvamAgentsUrl), {
      headers: { 'X-API-Key': c.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sarvam answered HTTP ${res.status} for the transcript`);
    return parseTranscript(await res.json());
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
  const language = [root.language, root.language_code, root.language_name].find(
    (v): v is string => typeof v === 'string',
  );
  return {
    turns,
    seconds: seconds === undefined ? null : Math.round(seconds),
    language: baseLanguage(language),
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
