import { Injectable, Logger } from '@nestjs/common';
import type { ChatCompletionContentPart } from 'openai/resources/chat/completions';
import { ConversationsService } from '../conversations/conversations.service';
import { LlmClientService } from '../llm/llm-client.service';
import { StorageService } from '../storage/storage.service';
import { voiceNotePrompt } from './prompts';

/** A stored message as far as a voice note goes. `body` is filled in with what was said. */
interface HeardRow {
  id: string;
  authorType: string;
  body: string;
  attachments: Array<{ key: string; size: number; contentType: string }>;
  metadata: unknown;
}

/** What `noteTranscript` keeps on a message; `text` is null when nothing could be made out. */
interface StoredTranscript {
  text: string | null;
}

/** The largest recording sent to the model; a WhatsApp voice note is far smaller. */
const MAX_BYTES = 8 * 1024 * 1024;
/** How many unheard recordings one turn listens to: the ones the customer has just sent. */
const MAX_PER_TURN = 3;
const UNCLEAR = /^\W*unclear\W*$/i;

const storedOf = (metadata: unknown): StoredTranscript | undefined =>
  (metadata as { transcript?: StoredTranscript } | null)?.transcript;

/**
 * Voice messages (ADR 0038). A customer who sends a recording instead of text
 * is heard: the chat model writes down what is said, once, and the words are
 * kept on the message, where the AI reads them as the customer's message and
 * an agent sees them under the file. The recording is the customer's message:
 * what is said in it is data, like typed text.
 */
@Injectable()
export class VoiceNotesService {
  private readonly logger = new Logger(VoiceNotesService.name);

  constructor(
    private readonly llm: LlmClientService,
    private readonly storage: StorageService,
    private readonly conversations: ConversationsService,
  ) {}

  /**
   * Fills in what was said for the wordless recordings among these messages
   * (oldest first): from the message when it was heard before, by listening
   * now for the newest ones. A recording that cannot be heard is left without
   * words, and the turn says so instead of guessing.
   */
  async hear(rows: HeardRow[]): Promise<void> {
    let listened = 0;
    for (const row of [...rows].reverse()) {
      if (row.authorType !== 'customer' || row.body.trim()) continue;
      const recording = row.attachments.find((a) => a.contentType.startsWith('audio/'));
      if (!recording) continue;
      const stored = storedOf(row.metadata);
      if (stored) {
        row.body = stored.text ?? '';
        continue;
      }
      if (listened >= MAX_PER_TURN) continue;
      listened++;
      const heard = await this.transcribe(recording);
      if (!heard) continue;
      await this.conversations
        .noteTranscript(row.id, { text: heard.text, model: heard.model })
        .catch((err: Error) => this.logger.warn(`transcript not kept: ${err.message}`));
      row.metadata = { ...(row.metadata as object | null), transcript: { text: heard.text } };
      row.body = heard.text ?? '';
    }
  }

  /** What is said in a recording; `text` null when it is unclear; null when it could not be listened to. */
  private async transcribe(recording: {
    key: string;
    size: number;
    contentType: string;
  }): Promise<{ text: string | null; model: string } | null> {
    if (recording.size > MAX_BYTES) return null;
    // Only the kind of audio goes into the address: the stored type came from outside.
    const type = /^audio\/[a-z0-9.+-]+/i.exec(recording.contentType)?.[0] ?? 'audio/ogg';
    try {
      const audio = await this.storage.getBuffer(recording.key);
      const part: ChatCompletionContentPart = {
        type: 'file',
        file: { file_data: `data:${type};base64,${audio.toString('base64')}` },
      };
      const r = await this.llm.chat({
        role: 'chat_agent',
        messages: [
          { role: 'system', content: voiceNotePrompt() },
          { role: 'user', content: [part] },
        ],
        // Room for a model that reasons before it answers.
        maxTokens: 1500,
        temperature: 0,
        timeoutMs: 30_000,
      });
      const said = (r.completion.choices[0]?.message.content ?? '').trim().slice(0, 5000);
      return { text: said && !UNCLEAR.test(said) ? said : null, model: r.model };
    } catch (err) {
      // A model that takes no audio, or none at all: the customer is asked to type instead.
      this.logger.warn(`voice message not heard: ${(err as Error).message.slice(0, 200)}`);
      return null;
    }
  }
}
