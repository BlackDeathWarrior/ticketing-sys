import { Injectable, Logger } from '@nestjs/common';
import {
  type AttachmentRef,
  type MessageEnvelope,
  WA_MEDIA_MAX_BYTES,
  type WaConversationMeta,
} from '@tms/shared';
import { ConversationsService } from '../../conversations/conversations.service';
import { CustomersService } from '../../customers/customers.service';
import {
  ChannelConfigService,
  type ResolvedWhatsappConfig,
} from '../../settings/channel-config.service';
import { StorageService } from '../../storage/storage.service';
import { InboundService } from '../inbound.service';
import { downloadMedia, getMediaUrl } from './meta-api';
import { explainStatusError } from './meta-errors';
import {
  hasUsableIdentity,
  identityDisplayName,
  resolveInboundIdentity,
  type WaIdentity,
} from './wa-identity';
import {
  contactFor,
  isIgnorable,
  mediaFilename,
  messageContent,
  messageTime,
  normalizeMimeType,
  type WaChangeValue,
  type WaContent,
  type WaMessage,
  type WaStatus,
  type WaWebhookPayload,
} from './webhook-payload';
import { parseAppSecrets, tokensEqual, verifyMetaWebhookSignature } from './webhook-signature';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

export interface WebhookOutcome {
  messages: number;
  duplicates: number;
  statuses: number;
  /** Status reports for messages we don't know (yet): the caller may retry. */
  unknownStatuses: number;
  skipped: number;
}

const PROVIDER_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * The WhatsApp Cloud API adapter: checks Meta's webhook calls and turns their
 * content into message envelopes, delivery reports and template updates.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly channels: ChannelConfigService,
    private readonly inbound: InboundService,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly storage: StorageService,
    private readonly templates: WhatsAppTemplatesService,
  ) {}

  /** Meta's subscription handshake: true when the token matches the one saved in Settings. */
  async verifyToken(given: string | undefined): Promise<boolean> {
    const { verifyToken } = await this.channels.whatsappWebhook();
    return !!verifyToken && tokensEqual(given, verifyToken);
  }

  /** True when the body was signed with the app secret saved in Settings. */
  async verifySignature(rawBody: Buffer, header: string | undefined): Promise<boolean> {
    const { appSecret } = await this.channels.whatsappWebhook();
    return verifyMetaWebhookSignature(rawBody, header, parseAppSecrets(appSecret));
  }

  /** Handles one verified webhook body. Safe to run again: messages and reports are idempotent. */
  async process(payload: WaWebhookPayload): Promise<WebhookOutcome> {
    const outcome: WebhookOutcome = {
      messages: 0,
      duplicates: 0,
      statuses: 0,
      unknownStatuses: 0,
      skipped: 0,
    };
    if (payload.object !== 'whatsapp_business_account') return outcome;
    const config = await this.channels.whatsapp();

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        if (change.field === 'message_template_status_update') {
          if (value.event && value.message_template_name && value.message_template_language) {
            await this.templates.applyStatus(
              value.message_template_name,
              value.message_template_language,
              value.event,
            );
          }
          continue;
        }
        if (change.field !== 'messages') continue;
        if (!config?.enabled || value.metadata?.phone_number_id !== config.phoneNumberId) {
          // Another number on the same Meta app, or the channel is switched off.
          outcome.skipped += (value.messages?.length ?? 0) + (value.statuses?.length ?? 0);
          continue;
        }
        for (const message of value.messages ?? []) {
          const result = await this.receive(config, value, message);
          if (result === 'stored') outcome.messages++;
          else if (result === 'duplicate') outcome.duplicates++;
          else outcome.skipped++;
        }
        for (const status of value.statuses ?? []) {
          const result = await this.report(status);
          if (result === 'unknown') outcome.unknownStatuses++;
          else outcome.statuses++;
        }
      }
    }
    return outcome;
  }

  private async receive(
    config: ResolvedWhatsappConfig,
    value: WaChangeValue,
    message: WaMessage,
  ): Promise<'stored' | 'duplicate' | 'skipped'> {
    if (isIgnorable(message)) return 'skipped';
    const identity = resolveInboundIdentity(message, contactFor(message, value.contacts));
    if (!hasUsableIdentity(identity)) {
      this.logger.warn(`message ${message.id} has neither a phone number nor a user id`);
      return 'skipped';
    }
    // Checked before any download, so a redelivery doesn't fetch the file again.
    if (await this.conversations.hasChannelMessage('whatsapp', message.id)) return 'duplicate';

    const content = messageContent(message);
    const { attachments, mediaError } = await this.fetchMedia(config, content, message);
    const receivedAt = messageTime(message.timestamp);
    const conversation: WaConversationMeta = {
      waPhone: identity.phone || undefined,
      waUserId: identity.waUserId ?? undefined,
      waUsername: identity.waUsername ?? undefined,
      profileName: identity.name || undefined,
      phoneNumberId: config.phoneNumberId,
      lastInboundAt: receivedAt,
    };

    const envelope: MessageEnvelope = {
      channel: 'whatsapp',
      threadKey: identity.phone || identity.waUserId!,
      channelMessageId: message.id,
      from: await this.sender(identity),
      text: content.text || (mediaError ? `[${content.media?.kind ?? 'file'}]` : ''),
      attachments,
      receivedAt,
      metadata: {
        conversation,
        waType: message.type,
        ...(message.context?.id ? { waReplyTo: message.context.id } : {}),
        ...(mediaError ? { waMediaError: mediaError } : {}),
      },
    };
    const result = await this.inbound.handle(envelope);
    return result.duplicate ? 'duplicate' : 'stored';
  }

  /**
   * Who the message is from. A user id we already know wins, so a customer
   * first seen without a phone number keeps one record when Meta later shows
   * the number. Otherwise the phone is the key and the user id is attached.
   */
  private async sender(identity: WaIdentity): Promise<MessageEnvelope['from']> {
    const displayName = identityDisplayName(identity);
    const phone = identity.phone ? { type: 'whatsapp' as const, value: identity.phone } : null;
    const bsuid = identity.waUserId
      ? { type: 'whatsapp_bsuid' as const, value: identity.waUserId }
      : null;
    const bsuidKnown = bsuid ? await this.customers.lookup(bsuid.type, bsuid.value) : null;
    const [primary, extra] = bsuid && (bsuidKnown || !phone) ? [bsuid, phone] : [phone!, bsuid];
    return {
      identity: primary,
      displayName,
      // Meta vouches for both, so the second one may link to this customer.
      extraIdentities: extra ? [{ ...extra, verified: true }] : [],
    };
  }

  /** Copies the customer's file into our storage: Meta deletes media after about 30 days. */
  private async fetchMedia(
    config: ResolvedWhatsappConfig,
    content: WaContent,
    message: WaMessage,
  ): Promise<{ attachments: AttachmentRef[]; mediaError?: string }> {
    const media = content.media;
    if (!media) return { attachments: [] };
    try {
      if (!config.accessToken) throw new Error('The WhatsApp access token is not set');
      if (!this.storage.enabled) throw new Error('Object storage is not configured');
      const info = await getMediaUrl({
        graph: config.graph,
        accessToken: config.accessToken,
        mediaId: media.id,
      });
      if (info.fileSize !== null && info.fileSize > WA_MEDIA_MAX_BYTES) {
        throw new Error('The file is larger than the size limit');
      }
      const file = await downloadMedia({
        downloadUrl: info.url,
        accessToken: config.accessToken,
        graph: config.graph,
        maxBytes: WA_MEDIA_MAX_BYTES,
      });
      const ref = await this.storage.putAttachment({
        filename: mediaFilename(media, message.timestamp),
        contentType: normalizeMimeType(media.mimeType || info.mimeType || file.contentType),
        content: file.buffer,
      });
      return { attachments: [ref] };
    } catch (err) {
      // The message still matters without its file; a failing webhook would be retried forever.
      const reason = (err as Error).message;
      this.logger.warn(`media ${media.id} of message ${message.id} was not saved: ${reason}`);
      return { attachments: [], mediaError: reason };
    }
  }

  private async report(status: WaStatus): Promise<'applied' | 'ignored' | 'unknown'> {
    if (!PROVIDER_STATUSES.has(status.status)) return 'ignored';
    return this.conversations.applyProviderStatus(
      'whatsapp',
      status.id,
      status.status as 'sent' | 'delivered' | 'read' | 'failed',
      {
        at: new Date(messageTime(status.timestamp)),
        error: status.status === 'failed' ? explainStatusError(status.errors?.[0]) : undefined,
      },
    );
  }
}
