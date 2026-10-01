import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ChannelConfigService, type ResolvedEmailConfig } from './channel-config.service';

export interface SystemMail {
  to: string;
  subject: string;
  text: string;
  /**
   * The part before the @ of the Message-ID. Give the same one on a retry so
   * mail servers can drop the duplicate.
   */
  id: string;
  /** Appended to the sender name, e.g. "Support (Orbit Desk)". */
  fromSuffix?: string;
}

/**
 * Mail the system sends by itself, outside any ticket conversation: staff
 * notifications, portal sign-in links, rating requests. It goes out from the
 * support mailbox over the email channel's SMTP settings. Worker only: never
 * call it inside a request.
 */
@Injectable()
export class SystemMailer implements OnApplicationShutdown {
  private transport?: { key: string; transporter: Transporter };

  constructor(private readonly channels: ChannelConfigService) {}

  /** False when the email channel is off: nothing was sent. */
  async send(mail: SystemMail): Promise<boolean> {
    const config = await this.channels.email();
    if (!config?.enabled) return false;
    await this.transporter(config).sendMail({
      from: {
        name: mail.fromSuffix ? `${config.fromName} (${mail.fromSuffix})` : config.fromName,
        address: config.address,
      },
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      messageId: `<${mail.id}@${config.address.split('@')[1]}>`,
      // Tells mail servers and auto-responders that nobody typed this.
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return true;
  }

  onApplicationShutdown() {
    this.transport?.transporter.close();
  }

  private transporter(c: ResolvedEmailConfig): Transporter {
    const key = JSON.stringify([c.smtpHost, c.smtpPort, c.smtpSecure, c.smtpUser, c.smtpPassword]);
    if (this.transport?.key !== key) {
      this.transport?.transporter.close();
      this.transport = {
        key,
        transporter: nodemailer.createTransport({
          host: c.smtpHost,
          port: c.smtpPort,
          secure: c.smtpSecure,
          auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPassword ?? '' } : undefined,
        }),
      };
    }
    return this.transport.transporter;
  }
}
