import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { ChannelConfigService, type ResolvedEmailConfig } from '../settings/channel-config.service';
import type { ChannelSender, DeliveryItem } from './senders';

interface EmailMeta {
  messageId: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Sends agent replies over SMTP with the threading headers chosen at reply
 * time. The SMTP settings are read per send, so a Settings change applies to
 * the next message; the pooled transport is rebuilt when they differ.
 */
@Injectable()
export class EmailSender implements ChannelSender, OnApplicationShutdown {
  readonly channel = 'email';
  private transport?: { key: string; transporter: Transporter };

  constructor(private readonly channels: ChannelConfigService) {}

  async send({ message }: DeliveryItem): Promise<void> {
    const config = await this.channels.email();
    if (!config?.enabled) throw new Error('The email channel is disabled');
    const meta = message.metadata as unknown as EmailMeta;
    await this.getTransport(config).sendMail({
      from: { name: config.fromName, address: config.address },
      to: meta.to,
      subject: meta.subject,
      text: message.body,
      // The same Message-ID on every retry lets receiving servers drop duplicates.
      messageId: meta.messageId,
      inReplyTo: meta.inReplyTo ?? undefined,
      references: meta.references.length ? meta.references : undefined,
    });
  }

  onApplicationShutdown() {
    this.transport?.transporter.close();
  }

  private getTransport(c: ResolvedEmailConfig): Transporter {
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
          pool: true,
        }),
      };
    }
    return this.transport.transporter;
  }
}
