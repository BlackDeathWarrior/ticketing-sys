import { BadGatewayException, ConflictException, Injectable } from '@nestjs/common';
import { waWindow } from '@tms/shared';
import { ConversationsService } from '../../conversations/conversations.service';
import { BrandingService } from '../../settings/branding.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { sendTemplateMessage, sendTextMessage } from './meta-api';
import { explainMetaError } from './meta-errors';
import { authenticationComponents } from './template-send-builder';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

/**
 * Sends a phone-verification code to a number over the desk's WhatsApp
 * connection. This sends inside the request on purpose (an exception to the
 * rule against calling external services in a request), so the calling app can
 * show Meta's refusal at once. The code is never logged.
 */
@Injectable()
export class WhatsAppCodeSender {
  constructor(
    private readonly channelConfig: ChannelConfigService,
    private readonly templates: WhatsAppTemplatesService,
    private readonly conversations: ConversationsService,
    private readonly branding: BrandingService,
  ) {}

  /**
   * Sends the code to `phone` (digits only). An approved authentication
   * template works at any time; without one, plain text works only while the
   * customer's 24-hour window is open.
   */
  async send(phone: string, code: string): Promise<'template' | 'text'> {
    // Read per send, so a new token or a switch-off applies to the next code.
    const config = await this.channelConfig.whatsapp();
    if (!config?.enabled || !config.accessToken) {
      throw new ConflictException('WhatsApp is not connected');
    }
    const base = {
      graph: config.graph,
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      to: phone,
    };

    const template = await this.templates.authentication();
    if (template) {
      try {
        await sendTemplateMessage({
          ...base,
          templateName: template.name,
          language: template.language,
          components: authenticationComponents(code),
        });
      } catch (err) {
        throw new BadGatewayException(explainMetaError(err).summary);
      }
      return 'template';
    }

    if (waWindow(await this.conversations.lastWhatsappInboundAt(phone)).open) {
      const { companyName } = await this.branding.get();
      try {
        await sendTextMessage({
          ...base,
          text: `${code} is your ${companyName} verification code. It is valid for 10 minutes. Do not share it.`,
        });
      } catch (err) {
        throw new BadGatewayException(explainMetaError(err).summary);
      }
      return 'text';
    }

    throw new ConflictException(
      'No approved authentication template. Create one in WhatsApp Manager and sync templates.',
    );
  }
}
