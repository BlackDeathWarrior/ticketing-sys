import { Injectable, Logger } from '@nestjs/common';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { sendTypingIndicator } from './meta-api';
import { explainMetaError } from './meta-errors';

/**
 * WhatsApp's "typing…" while the AI writes an answer it will send by itself.
 * Meta shows it under one of the customer's messages, marks that message as
 * read, and clears it when our answer arrives or after about 25 seconds.
 */
@Injectable()
export class WhatsAppTypingService {
  private readonly logger = new Logger(WhatsAppTypingService.name);

  constructor(private readonly channelConfig: ChannelConfigService) {}

  /**
   * Shows it for the customer message with Meta's id `messageId`. Does nothing
   * on other channels, and never throws: the answer does not depend on it.
   */
  async show(channel: string, messageId: string | null): Promise<void> {
    if (channel !== 'whatsapp' || !messageId) return;
    try {
      // Read per call, so a new token or a switch-off applies at once.
      const config = await this.channelConfig.whatsapp();
      if (!config?.enabled || !config.accessToken) return;
      await sendTypingIndicator({
        graph: config.graph,
        accessToken: config.accessToken,
        phoneNumberId: config.phoneNumberId,
        messageId,
      });
    } catch (err) {
      this.logger.debug(`typing indicator not shown: ${explainMetaError(err).summary}`);
    }
  }
}
