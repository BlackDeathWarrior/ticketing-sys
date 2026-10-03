import { Inject, Injectable, Logger } from '@nestjs/common';
import { screenInbound } from '../../ai/guard';
import { phoneQueryTranslationPrompt } from '../../ai/prompts';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { LlmClientService } from '../../llm/llm-client.service';
import { ChannelConfigService } from '../../settings/channel-config.service';

/** A letter that is not written in Latin script: Devanagari, Tamil, Bengali and the rest. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const MAX_CHARS = 1_000;
/** The caller is waiting on the line: a slow translation is not worth the silence. */
const TIMEOUT_MS = 8_000;
const SARVAM_TIMEOUT_MS = 4_000;

/**
 * Puts what a caller asked into English before it is looked up (ADR 0039).
 * The knowledge base and the shop's catalogue are in English, and the phone
 * agent passes a Hindi question on in Hindi. Text already in Latin script is
 * left as it is, so an English call costs nothing. Sarvam's translation API is
 * used when a Sarvam key is saved (the "Sarvam voice" card); otherwise the
 * small chat model. When the translation fails, the original text is used: a
 * worse search beats no search.
 */
@Injectable()
export class PhoneQueryTranslator {
  private readonly logger = new Logger(PhoneQueryTranslator.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
    private readonly llm: LlmClientService,
  ) {}

  async toEnglish(text: string): Promise<string> {
    if (!NON_LATIN_LETTER.test(text)) return text;
    // The caller's words go to a model: screened first, like every customer message.
    if (screenInbound(text)?.strength === 'strong') return text;

    // Sarvam's translation is made for Indian languages and answers in a fraction of a
    // second; the chat model took six on the first try, too long for someone on the line.
    const sarvam = await this.channels.sarvam().catch(() => null);
    if (sarvam?.apiKey) return this.withSarvam(text, sarvam.apiKey);
    return this.withChatModel(text);
  }

  private async withSarvam(text: string, apiKey: string): Promise<string> {
    try {
      const res = await fetch(new URL('/translate', this.env.SARVAM_API_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-subscription-key': apiKey },
        body: JSON.stringify({
          input: text.slice(0, MAX_CHARS),
          source_language_code: 'auto',
          target_language_code: 'en-IN',
          model: 'mayura:v1',
        }),
        signal: AbortSignal.timeout(SARVAM_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Sarvam answered HTTP ${res.status}`);
      const english = ((await res.json()) as { translated_text?: string }).translated_text?.trim();
      return english || text;
    } catch (err) {
      this.logger.warn(`a caller's question was not translated: ${(err as Error).message}`);
      return text;
    }
  }

  private async withChatModel(text: string): Promise<string> {
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
