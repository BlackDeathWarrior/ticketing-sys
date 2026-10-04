import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type CustomerNoticeInput,
  type CustomerNoticeResult,
  integrationExternalId,
} from '@tms/shared';
import { WhatsAppLinkSender } from '../channels/whatsapp/whatsapp-link.sender';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';

/** Notices one customer may be sent by an app in an hour. */
const NOTICES_PER_HOUR = 20;

/**
 * Lets an app tell one of its customers something in writing after the fact:
 * a return it approved, a refund it issued. The desk sends the app's own
 * sentence to the number that customer has proven, over WhatsApp, as a plain
 * message inside their 24-hour window. Only a customer this app has named
 * (`customer.externalId`) can be reached, and never a number the app supplies.
 */
@Injectable()
export class CustomerNoticeService {
  constructor(
    private readonly customers: CustomersService,
    private readonly limiter: RateLimiterService,
    private readonly sender: WhatsAppLinkSender,
  ) {}

  async send(key: ApiKeyContext, input: CustomerNoticeInput): Promise<CustomerNoticeResult> {
    const who = `${key.integration.id}:${input.customer.externalId}`;
    const used = await this.limiter.hit('customer-notice', who, NOTICES_PER_HOUR, 3600);
    if (!used.allowed) throw tooManyRequests(used.retryAfter, 'notices');

    const customer = await this.customers.lookup(
      'external_id',
      integrationExternalId(key.integration.slug, input.customer.externalId),
    );
    if (!customer) throw new NotFoundException('Customer not found');
    const phone = await this.customers.provenPhoneOf(customer.id);
    if (!phone) {
      return { sent: false, via: null, reason: 'The customer has no confirmed phone number' };
    }
    const outcome = await this.sender.sendNotice({
      phone,
      text: input.text,
      about: input.about ?? `Notice from ${key.integration.name}`,
      target: { type: 'customer', id: customer.id },
    });
    return outcome.sent
      ? { sent: true, via: 'whatsapp' }
      : { sent: false, via: null, reason: outcome.reason };
  }
}
