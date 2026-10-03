import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import { AuditService } from '../../audit/audit.service';
import { AI_CTX } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { sendTemplateMessage } from './meta-api';
import { explainMetaError } from './meta-errors';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';

export type LinkSendOutcome =
  | { sent: true }
  /** `reason` is for the log and the audit entry, in plain words. */
  | { sent: false; reason: string };

/**
 * Sends a link to a number over the desk's WhatsApp connection, with an
 * approved template whose body has one variable, the link. For a caller on a
 * phone call, who cannot be read a web address (ADR 0039). Like the
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
  ) {}

  /** `phone`: digits with the country code. `about`: what the link is, for the audit entry. */
  async send(i: {
    phone: string;
    templateName: string;
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
            template: i.templateName,
            ...(outcome.sent ? {} : { reason: outcome.reason }),
          },
        }),
      )
      .catch((err: Error) => this.logger.warn(`audit of a sent link failed: ${err.message}`));
    return outcome;
  }

  private async trySend(i: {
    phone: string;
    templateName: string;
    link: string;
  }): Promise<LinkSendOutcome> {
    const config = await this.channelConfig.whatsapp();
    if (!config?.enabled || !config.accessToken) {
      return { sent: false, reason: 'WhatsApp is not connected' };
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
      } = await this.templates.prepare({ templateId: template.id, body: [i.link], buttonParams: {} }));
    } catch (err) {
      // The template does not have exactly one body variable.
      return { sent: false, reason: (err as Error).message };
    }
    try {
      await sendTemplateMessage({
        graph: config.graph,
        accessToken: config.accessToken,
        phoneNumberId: config.phoneNumberId,
        to: i.phone,
        templateName: template.name,
        language: template.language,
        components,
      });
      return { sent: true };
    } catch (err) {
      return { sent: false, reason: explainMetaError(err).summary };
    }
  }
}
