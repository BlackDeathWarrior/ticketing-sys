import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type Database, phoneVerifications } from '@tms/db';
import {
  type CheckPhoneVerificationInput,
  integrationExternalId,
  PHONE_CODE_MAX_ATTEMPTS,
  PHONE_CODE_TTL_MINUTES,
  type PhoneCodeFailure,
  type PhoneVerificationChecked,
  type PhoneVerificationStarted,
  type StartPhoneVerificationInput,
} from '@tms/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { WhatsAppCodeSender } from '../channels/whatsapp/whatsapp-code.sender';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext, RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { CustomersService } from '../customers/customers.service';
import { DB, ENV } from '../infra/tokens';

const MINUTE_MS = 60_000;

const MESSAGES: Record<PhoneCodeFailure, string> = {
  'no-code': 'Ask for a new code.',
  expired: 'The code has expired. Ask for a new one.',
  'too-many-attempts': 'Too many wrong tries. Ask for a new code.',
  'wrong-code': 'That code is not right.',
};

/** A 400 the app can tell apart by `reason` and show in its own words. */
function failure(reason: PhoneCodeFailure): BadRequestException {
  return new BadRequestException({ reason, message: MESSAGES[reason] });
}

/**
 * Proves that a customer of an integration owns a phone number: sends a
 * 6-digit code over WhatsApp and, when the customer types it back, links the
 * number to them as a verified phone. Only a keyed hash of the code is stored,
 * and the code never reaches a log, an audit entry or an event.
 */
@Injectable()
export class PhoneVerificationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly limiter: RateLimiterService,
    private readonly sender: WhatsAppCodeSender,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async start(
    key: ApiKeyContext,
    input: StartPhoneVerificationInput,
  ): Promise<PhoneVerificationStarted> {
    const { phone, customer } = input;
    const integrationId = key.integration.id;
    await this.limit('phone-code-minute', phone, 1, 60);
    await this.limit('phone-code-hour', phone, 5, 3600);
    await this.limit('phone-code-customer', `${integrationId}:${customer.externalId}`, 10, 3600);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = randomUUID();
    // Nothing is stored when Meta refuses: there is no code to check.
    const sentVia = await this.sender.send(phone, code);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PHONE_CODE_TTL_MINUTES * MINUTE_MS);
    const ctx = this.ctxOf(key);
    const data = { externalId: customer.externalId, last4: phone.slice(-4), sentVia };
    await this.db.transaction(async (tx) => {
      // A new code replaces the earlier one for the same person and number.
      await tx
        .update(phoneVerifications)
        .set({ consumedAt: now })
        .where(this.openFor(integrationId, customer.externalId, phone));
      await tx.insert(phoneVerifications).values({
        id,
        integrationId,
        externalId: customer.externalId,
        phone,
        codeHash: this.hash(id, code),
        sentVia,
        expiresAt,
      });
      await this.audit.record(tx, ctx, {
        action: 'customer.phone_verification_sent',
        targetType: 'integration',
        targetId: integrationId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.phone_verification_sent',
        aggregateType: 'integration',
        aggregateId: integrationId,
        payload: data,
      });
    });
    return { expiresAt: expiresAt.toISOString(), sentVia };
  }

  async check(
    key: ApiKeyContext,
    input: CheckPhoneVerificationInput,
  ): Promise<PhoneVerificationChecked> {
    const { phone, customer } = input;
    const integrationId = key.integration.id;
    const [row] = await this.db
      .select()
      .from(phoneVerifications)
      .where(this.openFor(integrationId, customer.externalId, phone))
      .orderBy(desc(phoneVerifications.createdAt))
      .limit(1);
    if (!row) throw failure('no-code');
    if (row.expiresAt.getTime() <= Date.now()) throw failure('expired');

    // A try is counted before the code is looked at, in one statement that
    // refuses once the limit is stored, so parallel guesses cannot all slip
    // in under it. It is its own statement on the plain handle: the error
    // below must not roll it back.
    const [counted] = await this.db
      .update(phoneVerifications)
      .set({ attempts: sql`${phoneVerifications.attempts} + 1` })
      .where(
        and(
          eq(phoneVerifications.id, row.id),
          isNull(phoneVerifications.consumedAt),
          lt(phoneVerifications.attempts, PHONE_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning({ attempts: phoneVerifications.attempts });
    if (!counted) throw failure('too-many-attempts');

    if (!this.matches(row.codeHash, this.hash(row.id, input.code))) throw failure('wrong-code');

    const ctx = this.ctxOf(key);
    await this.db.transaction(async (tx) => {
      // A code works once: the second of two parallel checks changes nothing.
      const [spent] = await tx
        .update(phoneVerifications)
        .set({ consumedAt: new Date() })
        .where(and(eq(phoneVerifications.id, row.id), isNull(phoneVerifications.consumedAt)))
        .returning({ id: phoneVerifications.id });
      if (!spent) throw failure('no-code');

      const { customer: person } = await this.customers.resolveOrCreate(
        ctx,
        {
          type: 'external_id',
          value: integrationExternalId(key.integration.slug, customer.externalId),
          displayName: customer.name,
        },
        tx,
      );
      if (customer.email) {
        await this.customers.attachIdentity(tx, ctx, person.id, {
          type: 'email',
          value: customer.email,
          verified: true,
        });
      }
      await this.customers.provePhone(tx, ctx, person.id, phone);
    });
    return { verified: true, phone };
  }

  /** Deletes codes created before `before`, used or not (retention). */
  async purge(before: Date): Promise<number> {
    const rows = await this.db
      .delete(phoneVerifications)
      .where(lt(phoneVerifications.createdAt, before))
      .returning({ id: phoneVerifications.id });
    return rows.length;
  }

  /** The codes still waiting to be used for this person and number. */
  private openFor(integrationId: string, externalId: string, phone: string) {
    return and(
      eq(phoneVerifications.integrationId, integrationId),
      eq(phoneVerifications.externalId, externalId),
      eq(phoneVerifications.phone, phone),
      isNull(phoneVerifications.consumedAt),
    );
  }

  /** A 429 with `Retry-After`, as the `@RateLimit` guard answers. */
  private async limit(name: string, who: string, limit: number, windowSeconds: number) {
    if (!this.limiter.enabled) return;
    const used = await this.limiter.hit(name, who, limit, windowSeconds);
    if (!used.allowed) throw tooManyRequests(used.retryAfter, 'verification codes');
  }

  /** Keyed with the server's secret and bound to the row, so a leaked table cannot be brute-forced offline. */
  private hash(id: string, code: string): string {
    return createHmac('sha256', this.env.JWT_SECRET)
      .update(`phone-code:${id}:${code}`)
      .digest('hex');
  }

  private matches(stored: string, given: string): boolean {
    const a = Buffer.from(stored, 'hex');
    const b = Buffer.from(given, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The key acting: audit rows and events carry actor type `integration`. */
  private ctxOf(key: ApiKeyContext): RequestCtx {
    return { actor: { type: 'integration', id: key.id }, apiKey: key };
  }
}
