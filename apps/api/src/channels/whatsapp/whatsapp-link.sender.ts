import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import { AuditService } from '../../audit/audit.service';
import { waWindow } from '@tms/shared';
import { AI_CTX } from '../../common/request-context';
import { ConversationsService } from '../../conversations/conversations.service';
import { DB } from '../../infra/tokens';
import { BrandingService } from '../../settings/branding.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { sendTemplateMessage, sendTextMessage } from './meta-api';
import { explainMetaError } from './meta-errors';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

export type LinkSendOutcome =
  /** `as`: a plain message inside the 24-hour window, or a template outside it. */
  | { sent: true; as: 'text' | 'template' }
  /** `reason` is for the log and the audit entry, in plain words. */
  | { sent: false; reason: string };

/**
 * Sends a link to a number over the desk's WhatsApp connection. For a caller
 * on a phone call, who cannot be read a web address (ADR 0039). As a plain
 * message when that number wrote to us on WhatsApp in the last 24 hours (the
 * only time WhatsApp allows one, and the only way on an account that may not
 * start conversations); otherwise with an approved template whose body has
 * one variable, the link, when one is named in the settings. Like the
 * verification code, it is sent inside the request on purpose: the phone
 * agent has to tell the caller, truthfully and at once, whether it went out.
 * It never throws: a link that could not be sent is an outcome, not an error.
 */
@Injectable()
export class WhatsAppLinkSender {
  private readonly logger = new Logger(WhatsAppLinkSender.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly channelConfig: ChannelConfigService,
    private readonly templates: WhatsAppTemplatesService,
    private readonly conversations: ConversationsService,
    private readonly branding: BrandingService,
  ) {}

  /** `phone`: digits with the country code. `about`: what the link is, for the audit entry. */
  async send(i: {
    phone: string;
    /** The template for a number whose 24-hour window is closed; null when none is set. */
    templateName: string | null;
    link: string;
    about: string;
    callId: string | null;
  }): Promise<LinkSendOutcome> {
    const outcome = await this.trySend(i);
    if (!outcome.sent) this.logger.warn(`a link was not sent over WhatsApp: ${outcome.reason}`);
    // On record either way; never the number, never the link (it can carry a customer's cart).
    await this.db
      .transaction((tx) =>
        this.audit.record(tx, AI_CTX, {
          action: outcome.sent ? 'whatsapp.link_sent' : 'whatsapp.link_not_sent',
          targetType: 'voice_call',
          targetId: i.callId,
          data: {
            about: i.about,
            ...(outcome.sent ? { as: outcome.as } : { reason: outcome.reason }),
            ...(i.templateName ? { template: i.templateName } : {}),
          },
        }),
      )
      .catch((err: Error) => this.logger.warn(`audit of a sent link failed: ${err.message}`));
    return outcome;
  }

  private async trySend(i: {
    phone: string;
    templateName: string | null;
    link: string;
    about: string;
  }): Promise<LinkSendOutcome> {
    const config = await this.channelConfig.whatsapp();
    if (!config?.enabled || !config.accessToken) {
      return { sent: false, reason: 'WhatsApp is not connected' };
    }
    const credentials = {
      graph: config.graph,
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
    };

    // They wrote to us within the last 24 hours: a plain message is allowed and needs no template.
    const lastInboundAt = await this.conversations.lastWhatsappInboundAt(i.phone);
    if (waWindow(lastInboundAt).open) {
      const { companyName } = await this.branding.get();
      try {
        await sendTextMessage({
          ...credentials,
          to: i.phone,
          text: `From your call with ${companyName} (${i.about}):
${i.link}`,
        });
        return { sent: true, as: 'text' };
      } catch (err) {
        return { sent: false, reason: explainMetaError(err).summary };
      }
    }
    if (!i.templateName) {
      return {
        sent: false,
        reason: lastInboundAt
          ? 'their last WhatsApp message is more than 24 hours old and no link template is set'
          : 'this number has not written on WhatsApp and no link template is set',
      };
    }
    const template = await this.templates.approvedByName(i.templateName);
    if (!template) {
      return {
        sent: false,
        reason: `no approved template called "${i.templateName}" (sync templates)`,
      };
    }
    let components: unknown[];
    try {
      ({
        send: { components },
      } = await this.templates.prepare({
        templateId: template.id,
        body: [i.link],
        buttonParams: {},
      }));
    } catch (err) {
      // The template does not have exactly one body variable.
      return { sent: false, reason: (err as Error).message };
    }
    try {
      await sendTemplateMessage({
        ...credentials,
        to: i.phone,
        templateName: template.name,
        language: template.language,
        components,
      });
      return { sent: true, as: 'template' };
    } catch (err) {
      return { sent: false, reason: explainMetaError(err).summary };
    }
  }
}
