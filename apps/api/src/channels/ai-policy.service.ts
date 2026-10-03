import { Injectable, Logger } from '@nestjs/common';
import { LlmClientService } from '../llm/llm-client.service';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { aiIsAnswering } from './ai-answering';

/**
 * Decides who owns a new conversation: the AI when its channel mode is not
 * `off` and some chat model can serve it right now; otherwise nobody (the
 * human queue). Without any AI model configured the helpdesk behaves exactly
 * as before Phase 5.
 */
@Injectable()
export class AiPolicyService {
  private readonly logger = new Logger(AiPolicyService.name);

  constructor(
    private readonly behaviour: AiBehaviourService,
    private readonly llm: LlmClientService,
  ) {}

  async takesNewConversations(channel: string): Promise<boolean> {
    if ((await this.behaviour.modeFor(channel)) === 'off') return false;
    try {
      await this.llm.order('chat_agent');
      return true;
    } catch (err) {
      this.logger.debug(`AI not taking ${channel}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Whether a conversation the customer has just written in is being answered by the AI by itself. */
  async answering(channel: string, controller: string): Promise<boolean> {
    return aiIsAnswering({
      heldBy: controller,
      mode: await this.behaviour.modeFor(channel),
      customerWroteLast: true,
    });
  }
}
