import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import type { DomainEventHandler } from '../worker/domain-events';
import { ChannelConfigService } from './channel-config.service';
import { SystemMailer } from './system-mailer.service';

interface QueuedEmail {
  mailId: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * Mail to a customer that is not part of a ticket's conversation: an app's own email
 * (the link that finishes an account), or what a caller asked to get in writing when
 * WhatsApp cannot reach them. A request only queues it; the worker sends it from the
 * support mailbox. The audit entry never holds the address or the text.
 */
@Injectable()
export class CustomerMail {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly channels: ChannelConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** False when the email channel is off: nothing was queued. */
  async queue(
    ctx: RequestCtx,
    mail: {
      to: string;
      subject: string;
      text: string;
      about: string;
      target: { type: 'integration' | 'voice_call'; id: string };
    },
  ): Promise<boolean> {
    if (!(await this.channels.email())?.enabled) return false;
    const payload: QueuedEmail = {
      mailId: randomUUID(),
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
    };
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: 'customer.email_requested',
        targetType: mail.target.type,
        targetId: mail.target.id,
        data: { about: mail.about },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.email_requested',
        aggregateType: mail.target.type,
        aggregateId: mail.target.id,
        payload: { ...payload },
      });
    });
    return true;
  }
}

/** Sends the queued email (worker). */
@Injectable()
export class CustomerEmailHandler implements DomainEventHandler {
  readonly name = 'customer-email';
  private readonly logger = new Logger(CustomerEmailHandler.name);

  constructor(private readonly mailer: SystemMailer) {}

  handles(type: DomainEventType): boolean {
    return type === 'customer.email_requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    const mail = event.payload as unknown as QueuedEmail;
    const sent = await this.mailer.send({
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      // Retries of this event reuse the id, so mail servers can drop duplicates.
      id: `customer-${mail.mailId}`,
    });
    if (sent) this.logger.log('emailed a customer');
    else this.logger.warn('an email to a customer was not sent: the email channel is off');
  }
}
