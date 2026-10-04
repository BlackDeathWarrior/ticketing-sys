import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import type Redis from 'ioredis';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { OutboxService } from '../../audit/outbox.service';
import { RateLimiterService } from '../../common/rate-limit';
import { AI_CTX } from '../../common/request-context';
import type { Env } from '../../config/env';
import { CustomersService } from '../../customers/customers.service';
import { DB, ENV, REDIS } from '../../infra/tokens';
import { BrandingService } from '../../settings/branding.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { SystemMailer } from '../../settings/system-mailer.service';
import type { DomainEventHandler } from '../../worker/domain-events';
import type { CallRow } from '../voice/voice-calls.service';

const CODE_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const address = z.string().trim().toLowerCase().email().max(320);

/** What waits in Redis while the caller looks for the email. Never the code. */
interface Waiting {
  email: string;
  nonce: string;
  attempts: number;
}

const keyOf = (callId: string) => `phone-email-link:${callId}`;

/**
 * The six digits for one request, worked out from the server's secret: the API checks
 * them and the worker emails them, and neither a table, an event nor a log holds them.
 */
function codeFor(secret: string, callId: string, nonce: string): string {
  const mac = createHmac('sha256', secret).update(`call-email-code:${callId}:${nonce}`).digest();
  return String(mac.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export interface LinkAnswer {
  ok: boolean;
  text: string;
}
const no = (text: string): LinkAnswer => ({ ok: false, text });

/**
 * Links the number a caller rings from to an email address, during the call (ADR 0040).
 * A caller the desk does not know gives their address; a code goes to it and they read it
 * back. The code proves the address is theirs; that the number is theirs rests on the
 * caller id, as for every call that comes in. From then on the tools act for the customer
 * with that address, and what they ask for in writing can go there.
 */
@Injectable()
export class PhoneEmailLink {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly limiter: RateLimiterService,
    private readonly channels: ChannelConfigService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async start(call: CallRow | null, phone: string | null, rawEmail: unknown): Promise<LinkAnswer> {
    if (!call || !phone) {
      return no('This call carries no phone number, so nothing can be linked to it.');
    }
    const parsed = address.safeParse(rawEmail);
    if (!parsed.success) {
      return no(
        'That is not a valid email address. Ask the caller to spell it out, letter by letter, and give it as "email".',
      );
    }
    const email = parsed.data;
    if (call.direction === 'outbound') {
      // On a call the desk placed, the customer is the one it rang: only their own address.
      const rung = call.customerId ? await this.customers.contactOf(call.customerId) : null;
      if (!rung?.email || rung.email.toLowerCase() !== email) {
        return no(
          'On a call we placed, only the email address on the customer’s own file can be linked. Offer a colleague.',
        );
      }
    }
    if (!(await this.channels.email())?.enabled) {
      return no('Email is not set up at the desk, so a code cannot be sent. Offer a colleague.');
    }
    // Always on: each code is an email to an address someone said on the phone.
    const byPhone = await this.limiter.hit('phone-email-code', phone, CODES_PER_HOUR, 3600);
    const byEmail = await this.limiter.hit('phone-email-code-to', email, CODES_PER_HOUR, 3600);
    if (!byPhone.allowed || !byEmail.allowed) {
      return no('Too many codes were asked for. Tell the caller to try again in an hour.');
    }
    const waiting: Waiting = { email, nonce: randomBytes(8).toString('hex'), attempts: 0 };
    await this.redis.set(keyOf(call.id), JSON.stringify(waiting), 'EX', CODE_MINUTES * 60);
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, AI_CTX, {
        action: 'customer.email_code_requested',
        targetType: 'voice_call',
        targetId: call.id,
      });
      await this.outbox.publish(tx, AI_CTX, {
        type: 'customer.email_code_requested',
        aggregateType: 'voice_call',
        aggregateId: call.id,
        payload: { callId: call.id },
      });
    });
    return {
      ok: true,
      text: `A six-digit code was emailed to ${email}. Say the address back to the caller to check it. Ask them to open the email and read the code to you, then use confirm_email_code with it. The code works for ${CODE_MINUTES} minutes. If the address was wrong, use verify_email again with the right one.`,
    };
  }

  async confirm(call: CallRow | null, phone: string | null, rawCode: unknown): Promise<LinkAnswer> {
    if (!call || !phone) {
      return no('This call carries no phone number, so nothing can be linked to it.');
    }
    const raw = await this.redis.get(keyOf(call.id));
    if (!raw) {
      return no('No code is waiting on this call, or it has expired. Use verify_email first.');
    }
    const waiting = JSON.parse(raw) as Waiting;
    // Heard and typed by a model: "1 2 3 4 5 6" and "123-456" are the same code.
    const given = String(rawCode ?? '').replace(/\D/g, '');
    if (given.length !== 6) return no('Give the six digits the caller read out, as "code".');
    if (waiting.attempts + 1 > CODE_ATTEMPTS) {
      await this.redis.del(keyOf(call.id));
      return no('Too many wrong codes. Use verify_email again to send a new one.');
    }
    const right = Buffer.from(codeFor(this.env.JWT_SECRET, call.id, waiting.nonce));
    if (!timingSafeEqual(right, Buffer.from(given))) {
      await this.redis.set(
        keyOf(call.id),
        JSON.stringify({ ...waiting, attempts: waiting.attempts + 1 }),
        'KEEPTTL',
      );
      return no('That code is not right. Ask the caller to read it out again, digit by digit.');
    }
    // A code works once.
    if (!(await this.redis.del(keyOf(call.id)))) return no('That code was already used.');
    await this.db.transaction(async (tx) => {
      const { customer } = await this.customers.resolveOrCreate(
        AI_CTX,
        { type: 'email', value: waiting.email },
        tx,
      );
      await this.customers.attachIdentity(tx, AI_CTX, customer.id, {
        type: 'email',
        value: waiting.email,
        verified: true,
      });
      await this.customers.provePhone(tx, AI_CTX, customer.id, phone);
      await this.audit.record(tx, AI_CTX, {
        action: 'customer.phone_linked_by_email',
        targetType: 'customer',
        targetId: customer.id,
        data: { callId: call.id },
      });
    });
    return {
      ok: true,
      text: `Done: the caller’s number is now linked to ${waiting.email}. Tell them so. You can now use the tools for their orders, cart and payments, and what they ask for in writing goes to that address. If a tool answers that no account uses this email address, offer to start an account for them if you have a tool for it.`,
    };
  }
}

/** Emails the code a caller asked for (worker). */
@Injectable()
export class PhoneEmailCodeHandler implements DomainEventHandler {
  readonly name = 'phone-email-code';
  private readonly logger = new Logger(PhoneEmailCodeHandler.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly branding: BrandingService,
    private readonly mailer: SystemMailer,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'customer.email_code_requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    const { callId } = event.payload as { callId: string };
    const raw = await this.redis.get(keyOf(callId));
    // Expired, used, or replaced by a later request whose own event sends its code.
    if (!raw) return;
    const waiting = JSON.parse(raw) as Waiting;
    const { companyName } = await this.branding.get();
    const sent = await this.mailer.send({
      to: waiting.email,
      subject: `Your code for ${companyName}`,
      text: [
        `Your code is ${codeFor(this.env.JWT_SECRET, callId, waiting.nonce)}.`,
        '',
        `Read it to our phone assistant to link your phone number to this email address. It works for ${CODE_MINUTES} minutes.`,
        'If you are not on a call with us, ignore this email and tell nobody the code.',
        '',
        companyName,
      ].join('\n'),
      id: `call-code-${callId}-${waiting.nonce}`,
    });
    if (!sent) this.logger.warn('a caller’s code was not emailed: the email channel is off');
  }
}
