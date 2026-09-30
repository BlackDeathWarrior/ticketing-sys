import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import type { ChannelSender, DeliveryItem } from './senders';

interface EmailMeta {
  messageId: string;
  to: string;
  subject: string;
  inReplyTo: string | null;
  references: string[];
}

/** Sends agent replies over SMTP with the threading headers chosen at reply time. */
@Injectable()
export class EmailSender implements ChannelSender, OnApplicationShutdown {
  readonly channel = 'email';
  private transport?: Transporter;

  constructor(@Inject(ENV) private readonly env: Env) {}

  async send({ message }: DeliveryItem): Promise<void> {
    if (!this.env.EMAIL_ENABLED) throw new Error('The email channel is disabled');
    const meta = message.metadata as unknown as EmailMeta;
    await this.getTransport().sendMail({
      from: { name: this.env.EMAIL_FROM_NAME, address: this.env.EMAIL_ADDRESS! },
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
    this.transport?.close();
  }

  private getTransport(): Transporter {
    this.transport ??= nodemailer.createTransport({
      host: this.env.EMAIL_SMTP_HOST,
      port: this.env.EMAIL_SMTP_PORT,
      secure: this.env.EMAIL_SMTP_SECURE,
      auth: this.env.EMAIL_SMTP_USER
        ? { user: this.env.EMAIL_SMTP_USER, pass: this.env.EMAIL_SMTP_PASSWORD }
        : undefined,
      pool: true,
    });
    return this.transport;
  }
}
