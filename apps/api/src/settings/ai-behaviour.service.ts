import { Injectable } from '@nestjs/common';
import {
  AI_BEHAVIOUR_KEY,
  AI_CHANNELS,
  type AiBehaviour,
  aiBehaviourSchema,
  type AiChannel,
  type AiChannelMode,
  DEFAULT_AI_BEHAVIOUR,
} from '@tms/shared';
import type { RequestCtx } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AppSettingsService } from './app-settings.service';

/** The AI agent's behaviour setting (ADR 0011), with defaults when unset. */
@Injectable()
export class AiBehaviourService {
  constructor(private readonly settings: AppSettingsService) {}

  async get(): Promise<AiBehaviour> {
    return (await this.settings.get(AI_BEHAVIOUR_KEY, aiBehaviourSchema)) ?? DEFAULT_AI_BEHAVIOUR;
  }

  async save(ctx: RequestCtx, input: unknown): Promise<AiBehaviour> {
    const parsed = new ZodPipe(aiBehaviourSchema).transform(input);
    await this.settings.set(ctx, AI_BEHAVIOUR_KEY, parsed);
    return parsed;
  }

  /** The mode for a channel; channels the AI doesn't serve are `off`. */
  async modeFor(channel: string): Promise<AiChannelMode> {
    if (!(AI_CHANNELS as readonly string[]).includes(channel)) return 'off';
    return (await this.get()).channels[channel as AiChannel];
  }
}
