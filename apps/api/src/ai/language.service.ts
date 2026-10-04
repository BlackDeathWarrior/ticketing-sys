import { Inject, Injectable, Logger } from '@nestjs/common';
import { guessLanguage, readsAsEnglish } from '@tms/shared';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { ChannelConfigService } from '../settings/channel-config.service';

/**
 * The customer's language: Sarvam language identification when a Sarvam key
 * is configured, otherwise a guess from the writing system (Devanagari → hi,
 * Tamil → ta, Latin → en, …). Returns a base code such as `hi`.
 */
@Injectable()
export class LanguageService {
  private readonly logger = new Logger(LanguageService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
  ) {}

  async detect(text: string): Promise<string | null> {
    const guess = guessLanguage(text);
    // Latin script is ambiguous (English, Hinglish, …); other scripts are decisive.
    if (guess && guess !== 'en') return guess;
    // Plain English is settled here: asked about "payment methods", Sarvam answers Malayalam.
    if (guess === 'en' && readsAsEnglish(text)) return guess;
    const sarvam = await this.channels.sarvam().catch(() => null);
    if (!sarvam?.apiKey || !sarvam.enabled) return guess;
    try {
      const res = await fetch(new URL('/text-lid', this.env.SARVAM_API_URL), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-subscription-key': sarvam.apiKey },
        body: JSON.stringify({ input: text.slice(0, 1000) }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { language_code?: string };
      return body.language_code?.split('-')[0] ?? guess;
    } catch (err) {
      this.logger.warn(`Sarvam language detection failed: ${(err as Error).message}`);
      return guess;
    }
  }
}
