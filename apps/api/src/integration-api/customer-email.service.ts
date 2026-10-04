import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import type {
  CustomerEmailInput,
  CustomerEmailResult,
  DomainEvent,
  DomainEventType,
} from '@tms/shared';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext, RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { ChannelConfigService } from '../settings/channel-config.service';
import { SystemMailer } from '../settings/system-mailer.service';
import type { DomainEventHandler } from '../worker/domain-events';

/** Emails one address may be sent by an app in an hour, and an app may send in all. */
const EMAILS_PER_ADDRESS_HOUR = 5;
const EMAILS_PER_APP_HOUR = 100;

interface QueuedEmail {
  mailId: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * Lets an app email one of its customers from the support mailbox: the link that finishes
 * an account started on a phone call, where the app has no mail server of its own. The
 * request only queues the email; the worker sends it. The audit entry never holds the
 * address or the text.
 */
@Injectable()
export class CustomerEmailService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly limiter: RateLimiterService,
    private readonly channels: ChannelConfigService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async send(key: ApiKeyContext, input: CustomerEmailInput): Promise<CustomerEmailResult> {
    const app = await this.limiter.hit(
      'customer-email-app',
      key.integration.id,
      EMAILS_PER_APP_HOUR,
      3600,
    );
    if (!app.allowed) throw tooManyRequests(app.retryAfter, 'emails');
    const address = await this.limiter.hit(
      'customer-email',
      `${key.integration.id}:${input.to}`,
      EMAILS_PER_ADDRESS_HOUR,
      3600,
    );
    if (!address.allowed) throw tooManyRequests(address.retryAfter, 'emails to this address');

    if (!(await this.channels.email())?.enabled) {
      return { queued: false, reason: 'The email channel is off' };
    }
    const ctx: RequestCtx = { actor: { type: 'integration', id: key.id }, apiKey: key };
    const payload: QueuedEmail = {
      mailId: randomUUID(),
      to: input.to,
      subject: input.subject,
      text: input.text,
    };
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: 'customer.email_requested',
        targetType: 'integration',
        targetId: key.integration.id,
        data: { about: input.about ?? `Email from ${key.integration.name}` },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.email_requested',
        aggregateType: 'integration',
        aggregateId: key.integration.id,
        payload: { ...payload },
      });
    });
    return { queued: true };
  }
}

/** Sends the email an app asked for (worker). */
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
      id: `app-${mail.mailId}`,
    });
    if (sent) this.logger.log('emailed a customer for an app');
    else this.logger.warn('an app\u2019s email was not sent: the email channel is off');
  }
}
