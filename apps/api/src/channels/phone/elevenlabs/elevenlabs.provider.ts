import { Injectable } from '@nestjs/common';
import {
  languageCode,
  type PhoneAgentProvider,
  type PhoneRecording,
  type PhoneTranscript,
} from '../phone-provider';
import { ElevenLabsClient } from './elevenlabs.client';

/** An ElevenLabs agent on a number connected at ElevenLabs (ADR 0040). */
@Injectable()
export class ElevenLabsProvider implements PhoneAgentProvider {
  readonly id = 'elevenlabs' as const;

  constructor(private readonly client: ElevenLabsClient) {}

  async transcript(conversationId: string): Promise<PhoneTranscript | null> {
    const body = await this.client.conversation(conversationId);
    return body === null ? null : parseConversation(body);
  }

  recording(conversationId: string): Promise<PhoneRecording | null> {
    return this.client.conversationAudio(conversationId);
  }
}

/** ElevenLabs is still writing the conversation up in any other state. */
const FINISHED = ['done', 'failed'];

/**
 * Reads `GET /v1/convai/conversations/{id}`. Null while the call is not
 * written up yet. A body without a transcript fails loudly with the names of
 * the keys it had (never the text), so the shape can be added.
 */
export function parseConversation(body: unknown): PhoneTranscript | null {
  const root = (body ?? {}) as Record<string, unknown>;
  if (!FINISHED.includes(String(root.status ?? ''))) return null;
  if (!Array.isArray(root.transcript)) {
    throw new Error(`Unexpected conversation shape: ${Object.keys(root).join(', ') || 'no keys'}`);
  }
  const turns: PhoneTranscript['turns'] = [];
  for (const item of root.transcript) {
    const t = (item ?? {}) as Record<string, unknown>;
    const said = typeof t.message === 'string' ? t.message.trim() : '';
    const role = t.role === 'user' ? 'caller' : t.role === 'agent' ? 'agent' : null;
    // A turn with no words is a tool call or its result: nothing either side said.
    if (said && role) turns.push({ role, text: said });
  }
  const meta = (root.metadata ?? {}) as Record<string, unknown>;
  const seconds = meta.call_duration_secs;
  return {
    turns,
    seconds: typeof seconds === 'number' && seconds >= 0 ? Math.round(seconds) : null,
    language: languageCode(typeof meta.main_language === 'string' ? meta.main_language : undefined),
  };
}
