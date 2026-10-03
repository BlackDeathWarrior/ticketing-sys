import { Injectable } from '@nestjs/common';
import {
  MAX_CARDS,
  type MessageCard,
  messageCardSchema,
  WA_CAROUSEL_BODY_MAX,
  WA_TEXT_MAX,
  type WaConversationMeta,
  type WaTemplateSend,
} from '@tms/shared';
import {
  type MetaSendResult,
  type SendArgs,
  sendCardMessage,
  sendCarouselMessage,
  sendTemplateMessage,
  sendTextMessage,
} from '../channels/whatsapp/meta-api';
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
 * window, or an approved template (kept on the message as `waTemplate`). A
 * reply the AI attached picture cards to (`metadata.cards`) goes out as a
 * carousel; when that cannot be, the customer still gets the text.
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
    const {
      waTemplate: template,
      cards: rawCards,
      cardsDropped,
    } = message.metadata as {
      waTemplate?: WaTemplateSend;
      cards?: unknown;
      cardsDropped?: unknown;
    };
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
    // A reply that was already sent as text once (cardsDropped) is never tried with cards again.
    const parsed = messageCardSchema.array().min(1).safeParse(rawCards);
    const cards = !template && cardsDropped === undefined && parsed.success ? parsed.data : [];
    try {
      if (template) {
        const sent = await sendTemplateMessage({
          ...base,
          templateName: template.name,
          language: template.language,
          components: template.components,
        });
        return { channelMessageId: sent.messageId };
      }
      if (cards.length && message.body.length > WA_CAROUSEL_BODY_MAX) {
        return await this.sendText(base, message.body, 'The reply is too long to carry cards');
      }
      if (cards.length) {
        try {
          const sent = await this.sendCards(base, message.body, cards.slice(0, MAX_CARDS));
          return { channelMessageId: sent.messageId };
        } catch (err) {
          const why = explainMetaError(err);
          // Another attempt may work for a rate limit or an outage; the retry tries the cards again.
          if (why.retryable) throw err;
          return await this.sendText(base, message.body, why.summary);
        }
      }
      return await this.sendText(base, message.body);
    } catch (err) {
      const why = explainMetaError(err);
      // Rate limits and outages are worth another attempt; a closed window or a bad token is not.
      if (why.retryable) throw new Error(why.summary);
      throw new PermanentDeliveryError(why.summary);
    }
  }

  /** Cards that could not be shown go as the reply alone; the receipt says why. */
  private async sendText(
    base: SendArgs,
    text: string,
    cardsDropped?: string,
  ): Promise<DeliveryReceipt> {
    const sent = await sendTextMessage({ ...base, text });
    return {
      channelMessageId: sent.messageId,
      ...(cardsDropped ? { metadata: { cardsDropped } } : {}),
    };
  }

  /** One card is a reply-button message, two or more are a carousel. */
  private sendCards(base: SendArgs, body: string, cards: MessageCard[]): Promise<MetaSendResult> {
    return cards.length === 1
      ? sendCardMessage({ ...base, body, card: cards[0]! })
      : sendCarouselMessage({ ...base, body, cards });
  }
}
