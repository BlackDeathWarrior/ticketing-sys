import { Injectable, Logger } from '@nestjs/common';
import { screenInbound } from '../../ai/guard';
import { phoneQueryTranslationPrompt } from '../../ai/prompts';
import { LlmClientService } from '../../llm/llm-client.service';

/** A letter that is not written in Latin script: Devanagari, Tamil, Bengali and the rest. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const MAX_CHARS = 1_000;
/** The caller is waiting on the line: a slow translation is not worth the silence. */
const TIMEOUT_MS = 8_000;

/**
 * Puts what a caller asked into English before it is looked up (ADR 0039).
 * The knowledge base and the shop's catalogue are in English, and the phone
 * agent passes a Hindi question on in Hindi. Text already in Latin script is
 * left as it is, so an English call costs no model call. When the translation
 * fails, the original text is used: a worse search beats no search.
 */
@Injectable()
export class PhoneQueryTranslator {
  private readonly logger = new Logger(PhoneQueryTranslator.name);

  constructor(private readonly llm: LlmClientService) {}

  async toEnglish(text: string): Promise<string> {
    if (!NON_LATIN_LETTER.test(text)) return text;
    // The caller's words go to a model: screened first, like every customer message.
    if (screenInbound(text)?.strength === 'strong') return text;
    try {
      const { completion } = await this.llm.chat({
        role: 'classifier',
        messages: [
          { role: 'system', content: phoneQueryTranslationPrompt() },
          { role: 'user', content: `<text>\n${text.slice(0, MAX_CHARS)}\n</text>` },
        ],
        // Room for a model that reasons before it answers.
        maxTokens: 1500,
        temperature: 0,
        timeoutMs: TIMEOUT_MS,
      });
      const english = completion.choices[0]?.message?.content?.trim();
      return english && english.length <= MAX_CHARS ? english : text;
    } catch (err) {
      this.logger.warn(`a caller's question was not translated: ${(err as Error).message}`);
      return text;
    }
  }

  /**
   * The same for a tool's arguments: each text value that is not in Latin
   * script is translated ("लाल कुर्ता" → "red kurta"); ids, numbers and English
   * stay untouched. Arguments that are not a JSON object are passed on as they are,
   * for the gateway to refuse with its own message.
   */
  async argumentsToEnglish(args: string): Promise<string> {
    if (!NON_LATIN_LETTER.test(args)) return args;
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch {
      return args;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return args;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = typeof value === 'string' ? await this.toEnglish(value) : value;
    }
    return JSON.stringify(out);
  }
}
