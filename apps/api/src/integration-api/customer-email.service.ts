import { Injectable } from '@nestjs/common';
import type { CustomerEmailInput, CustomerEmailResult } from '@tms/shared';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext } from '../common/request-context';
import { CustomerMail } from '../settings/customer-mail.service';

/** Emails one address may be sent by an app in an hour, and an app may send in all. */
const EMAILS_PER_ADDRESS_HOUR = 5;
const EMAILS_PER_APP_HOUR = 100;

/**
 * Lets an app email one of its customers from the support mailbox: the link that finishes
 * an account started on a phone call, where the app has no mail server of its own.
 */
@Injectable()
export class CustomerEmailService {
  constructor(
    private readonly limiter: RateLimiterService,
    private readonly mail: CustomerMail,
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

    const queued = await this.mail.queue(
      { actor: { type: 'integration', id: key.id }, apiKey: key },
      {
        to: input.to,
        subject: input.subject,
        text: input.text,
        about: input.about ?? `Email from ${key.integration.name}`,
        target: { type: 'integration', id: key.integration.id },
      },
    );
    return queued ? { queued: true } : { queued: false, reason: 'The email channel is off' };
  }
}
