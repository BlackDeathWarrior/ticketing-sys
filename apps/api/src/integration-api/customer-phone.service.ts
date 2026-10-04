import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@tms/db';
import {
  type CustomerPhoneLookupInput,
  integrationExternalId,
  type LinkCustomerPhoneInput,
} from '@tms/shared';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext, RequestCtx } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';

const LINKS_PER_CUSTOMER_HOUR = 20;

/**
 * A customer's phone number, between an app and the desk, without a WhatsApp code: for an
 * app that proves its people by a code sent to their email address. The app tells the desk
 * the number it linked, so the phone agent knows the caller; and it asks which number the
 * desk linked on a call (a caller reads back a code sent to their email), to show it.
 * The number is what the person typed or rang from: it is linked, not proven by a message
 * to it.
 */
@Injectable()
export class CustomerPhoneService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly customers: CustomersService,
    private readonly limiter: RateLimiterService,
  ) {}

  async link(
    key: ApiKeyContext,
    input: LinkCustomerPhoneInput,
  ): Promise<{ linked: true; phone: string }> {
    const who = `${key.integration.id}:${input.customer.externalId}`;
    const used = await this.limiter.hit('customer-phone-link', who, LINKS_PER_CUSTOMER_HOUR, 3600);
    if (!used.allowed) throw tooManyRequests(used.retryAfter, 'phone numbers');
    const ctx: RequestCtx = { actor: { type: 'integration', id: key.id }, apiKey: key };
    await this.db.transaction(async (tx) => {
      const { customer } = await this.customers.resolveOrCreate(
        ctx,
        {
          type: 'external_id',
          value: integrationExternalId(key.integration.slug, input.customer.externalId),
          displayName: input.customer.name,
        },
        tx,
      );
      if (input.customer.email) {
        await this.customers.attachIdentity(tx, ctx, customer.id, {
          type: 'email',
          value: input.customer.email,
          verified: true,
        });
      }
      await this.customers.provePhone(tx, ctx, customer.id, input.phone);
      if (input.customer.title) {
        await this.customers.setTitleInTx(tx, ctx, customer.id, input.customer.title);
      }
    });
    return { linked: true, phone: input.phone };
  }

  async lookup(input: CustomerPhoneLookupInput): Promise<{ phone: string | null }> {
    const customer = await this.customers.lookup('email', input.email);
    return { phone: customer ? await this.customers.provenPhoneOf(customer.id) : null };
  }
}
