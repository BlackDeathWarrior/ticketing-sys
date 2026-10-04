import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type CallRequestInput,
  type CallRequestRefusal,
  integrationExternalId,
  OUTBOUND_REFUSAL_TEXT,
  type OutboundRefusal,
} from '@tms/shared';
import { PhoneOutboundService } from '../channels/phone/phone-outbound.service';
import { RateLimiterService } from '../common/rate-limit';
import type { ApiKeyContext } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';

const TEXT: Record<CallRequestRefusal, string> = {
  not_proven: 'The customer has no confirmed phone number.',
  too_soon: 'A call was asked for a few minutes ago. Please wait before asking again.',
  daily_limit: 'Too many calls were asked for today.',
};

const refused = (reason: CallRequestRefusal | OutboundRefusal) =>
  new ConflictException({
    message:
      reason in TEXT
        ? TEXT[reason as CallRequestRefusal]
        : OUTBOUND_REFUSAL_TEXT[reason as OutboundRefusal],
    reason,
  });

/**
 * "Call me": an app asks for its customer to be rung by the phone agent (ADR 0040). Only a
 * customer this app has named, and only on the number they have proven: an app can never
 * make the desk ring a number of its choosing. The limits are always on, as each call
 * costs money and rings a real phone.
 */
@Injectable()
export class CallRequestService {
  constructor(
    private readonly customers: CustomersService,
    private readonly limiter: RateLimiterService,
    private readonly outbound: PhoneOutboundService,
  ) {}

  async request(
    key: ApiKeyContext,
    externalId: string,
    input: CallRequestInput,
  ): Promise<{ requested: true }> {
    const customer = await this.customers.lookup(
      'external_id',
      integrationExternalId(key.integration.slug, externalId),
    );
    if (!customer) throw new NotFoundException('Customer not found');
    if (!(await this.customers.provenPhoneOf(customer.id))) throw refused('not_proven');
    const day = await this.limiter.hit('call-me-day', customer.id, 3, 86_400);
    if (!day.allowed) throw refused('daily_limit');
    const soon = await this.limiter.hit('call-me-soon', customer.id, 1, 600);
    if (!soon.allowed) throw refused('too_soon');
    const result = await this.outbound.request(
      { actor: { type: 'integration', id: key.id }, apiKey: key },
      {
        customerId: customer.id,
        ticketId: null,
        purpose: 'call_me',
        requestedBy: 'customer',
        about: input.about ?? null,
      },
    );
    if ('refused' in result) throw refused(result.refused);
    return { requested: true };
  }
}
