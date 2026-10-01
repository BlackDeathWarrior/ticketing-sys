import { Injectable } from '@nestjs/common';
import { WA_TEXT_MAX, type WaConversationMeta, type WaTemplateSend } from '@tms/shared';
import { sendTemplateMessage, sendTextMessage } from '../channels/whatsapp/meta-api';
import { explainMetaError } from '../channels/whatsapp/meta-errors';
import { resolveContactSendTarget } from '../channels/whatsapp/wa-identity';
import { ChannelConfigService } from '../settings/channel-config.service';
import {
  type ChannelSender,
  type DeliveryItem,
  type DeliveryReceipt,
  PermanentDeliveryError,
} from './senders';

/**
 * Sends replies through the WhatsApp Cloud API: free text inside the 24-hour
 * window, or an approved template (kept on the message as `waTemplate`).
 * Settings are read per send, so a new token applies to the next message.
 */
@Injectable()
export class WhatsAppSender implements ChannelSender {
  readonly channels = ['whatsapp'];

  constructor(private readonly channelConfig: ChannelConfigService) {}

  async send({ message, conversation }: DeliveryItem): Promise<DeliveryReceipt> {
    const config = await this.channelConfig.whatsapp();
    if (!config?.enabled) {
      throw new PermanentDeliveryError(
        'WhatsApp is not connected. Turn the channel on in Settings → Channels.',
      );
    }
    if (!config.accessToken) {
      throw new PermanentDeliveryError(
        'WhatsApp is not connected. Add the access token in Settings → Channels.',
      );
    }
    const meta = conversation.metadata as WaConversationMeta;
    const target = resolveContactSendTarget({ phone: meta.waPhone, waUserId: meta.waUserId });
    if (!target) {
      throw new PermanentDeliveryError('This conversation has no WhatsApp number to send to.');
    }
    const template = (message.metadata as { waTemplate?: WaTemplateSend }).waTemplate;
    if (!template && message.body.length > WA_TEXT_MAX) {
      throw new PermanentDeliveryError(
        `WhatsApp messages can be up to ${WA_TEXT_MAX.toLocaleString('en')} characters.`,
      );
    }

    const base = {
      graph: config.graph,
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      to: target.target,
    };
    try {
      const sent = template
        ? await sendTemplateMessage({
            ...base,
            templateName: template.name,
            language: template.language,
            components: template.components,
          })
        : await sendTextMessage({ ...base, text: message.body });
      return { channelMessageId: sent.messageId };
    } catch (err) {
      const why = explainMetaError(err);
      // Rate limits and outages are worth another attempt; a closed window or a bad token is not.
      if (why.retryable) throw new Error(why.summary);
      throw new PermanentDeliveryError(why.summary);
    }
  }
}
