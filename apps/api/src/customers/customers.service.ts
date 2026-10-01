import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  conversations,
  customerIdentities,
  customers,
  type Database,
  type DbOrTx,
  tickets,
} from '@tms/db';
import {
  type CreateCustomerInput,
  type IdentityInput,
  type IdentityType,
  normalizeIdentity,
  type ResolveCustomerInput,
  type UpdateCustomerInput,
} from '@tms/shared';
import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { isUniqueViolation } from '../common/exception.filter';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

type Customer = typeof customers.$inferSelect;

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async list(q: { q?: string; limit: number; offset: number }) {
    const conds = [isNull(customers.mergedIntoId)];
    if (q.q) {
      const term = `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const byIdentity = this.db
        .select({ id: customerIdentities.customerId })
        .from(customerIdentities)
        .where(ilike(customerIdentities.value, term));
      conds.push(
        or(
          ilike(customers.displayName, term),
          ilike(customers.primaryEmail, term),
          inArray(customers.id, byIdentity),
        )!,
      );
    }
    const where = and(...conds);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(customers)
        .where(where)
        .orderBy(desc(customers.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      this.db.$count(customers, where),
    ]);
    return { items, total };
  }

  /** Follows merges, so an old id keeps working after the customer was merged. */
  async get(id: string) {
    const c = await this.findActive(this.db, id);
    const [identities, recentTickets] = await Promise.all([
      this.db.select().from(customerIdentities).where(eq(customerIdentities.customerId, c.id)),
      this.db
        .select({
          id: tickets.id,
          number: tickets.number,
          subject: tickets.subject,
          status: tickets.status,
          channel: tickets.channel,
          createdAt: tickets.createdAt,
        })
        .from(tickets)
        .where(eq(tickets.customerId, c.id))
        .orderBy(desc(tickets.createdAt))
        .limit(20),
    ]);
    return { ...c, identities, recentTickets };
  }

  async create(ctx: RequestCtx, input: CreateCustomerInput) {
    const id = await this.db.transaction(async (tx) => {
      const c = await this.insertCustomer(tx, ctx, input);
      return c.id;
    });
    return this.get(id);
  }

  async update(ctx: RequestCtx, id: string, input: UpdateCustomerInput) {
    const c = await this.findActive(this.db, id);
    await this.db.transaction(async (tx) => {
      await tx.update(customers).set(input).where(eq(customers.id, c.id));
      await this.audit.record(tx, ctx, {
        action: 'customer.updated',
        targetType: 'customer',
        targetId: c.id,
        data: input,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.updated',
        aggregateType: 'customer',
        aggregateId: c.id,
        payload: { fields: Object.keys(input) },
      });
    });
    return this.get(c.id);
  }

  async addIdentity(ctx: RequestCtx, id: string, input: IdentityInput) {
    const c = await this.findActive(this.db, id);
    const value = normalizeIdentity(input.type, input.value);
    await this.db.transaction(async (tx) => {
      const [owner] = await tx
        .select()
        .from(customerIdentities)
        .where(and(eq(customerIdentities.type, input.type), eq(customerIdentities.value, value)));
      if (owner && owner.customerId !== c.id) {
        throw new ConflictException({
          message: 'This identity belongs to another customer. Merge the customers instead.',
          customerId: owner.customerId,
        });
      }
      if (!owner) await this.insertIdentity(tx, ctx, c.id, input.type, value, input.verified);
    });
    return this.get(c.id);
  }

  /**
   * Finds the customer behind a channel identity, creating one if unknown.
   * Channels (Phase 2) call this for every inbound message.
   */
  async resolveOrCreate(
    ctx: RequestCtx,
    input: ResolveCustomerInput,
    tx: DbOrTx = this.db,
  ): Promise<{ customer: Customer; created: boolean }> {
    const value = normalizeIdentity(input.type, input.value);
    const existing = await this.findByIdentity(tx, input.type, value);
    if (existing) return { customer: existing, created: false };

    if (input.type === 'whatsapp') {
      // Meta vouches for the number, so a customer already known by that phone is the same person.
      const byPhone = await this.findByIdentity(tx, 'phone', value);
      if (byPhone) {
        const link = (t: DbOrTx) =>
          this.insertIdentity(t, ctx, byPhone.id, 'whatsapp', value, true);
        await (tx !== this.db ? link(tx) : this.db.transaction(link));
        return { customer: byPhone, created: false };
      }
    }

    const run = async (t: DbOrTx) => {
      const fallbackName =
        input.type === 'email'
          ? value
          : input.type === 'webchat_session'
            ? 'Web visitor'
            : input.type === 'whatsapp_bsuid'
              ? 'WhatsApp user'
              : `+${value}`;
      const c = await this.insertCustomer(t, ctx, {
        displayName: input.displayName || fallbackName,
        customerType: 'standard',
        attributes: {},
        ...(input.type === 'email' ? { email: value } : {}),
        ...(input.type === 'phone' || input.type === 'whatsapp' ? { phone: value } : {}),
      });
      if (input.type !== 'email' && input.type !== 'phone') {
        await this.insertIdentity(t, ctx, c.id, input.type, value, false);
      }
      return c;
    };
    if (tx !== this.db) return { customer: await run(tx), created: true };
    try {
      return { customer: await this.db.transaction(run), created: true };
    } catch (err) {
      // Two messages from a new identity raced; the other one created the customer.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.findByIdentity(this.db, input.type, value);
      if (!winner) throw err;
      return { customer: winner, created: false };
    }
  }

  /**
   * Adds an identity to a customer inside the caller's transaction. Returns
   * false (and changes nothing) when another customer already owns it.
   */
  async attachIdentity(
    tx: DbOrTx,
    ctx: RequestCtx,
    customerId: string,
    input: { type: IdentityType; value: string; verified: boolean },
  ): Promise<boolean> {
    const value = normalizeIdentity(input.type, input.value);
    const [owner] = await tx
      .select()
      .from(customerIdentities)
      .where(and(eq(customerIdentities.type, input.type), eq(customerIdentities.value, value)));
    if (owner) return owner.customerId === customerId;
    await this.insertIdentity(tx, ctx, customerId, input.type, value, input.verified);
    return true;
  }

  /** Moves identities, tickets and conversations from source to target, then retires source. */
  async merge(ctx: RequestCtx, sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new BadRequestException('Cannot merge a customer into itself');
    const source = await this.findActive(this.db, sourceId, false);
    const target = await this.findActive(this.db, targetId, false);
    await this.db.transaction(async (tx) => {
      const moved = {
        identities: (
          await tx
            .update(customerIdentities)
            .set({ customerId: target.id })
            .where(eq(customerIdentities.customerId, source.id))
            .returning({ id: customerIdentities.id })
        ).length,
        tickets: (
          await tx
            .update(tickets)
            .set({ customerId: target.id })
            .where(eq(tickets.customerId, source.id))
            .returning({ id: tickets.id })
        ).length,
        conversations: (
          await tx
            .update(conversations)
            .set({ customerId: target.id })
            .where(eq(conversations.customerId, source.id))
            .returning({ id: conversations.id })
        ).length,
      };
      await tx
        .update(customers)
        .set({ mergedIntoId: target.id })
        .where(eq(customers.id, source.id));
      // Earlier merges into the source now point at the target.
      await tx
        .update(customers)
        .set({ mergedIntoId: target.id })
        .where(eq(customers.mergedIntoId, source.id));
      const data = { sourceId: source.id, targetId: target.id, moved };
      await this.audit.record(tx, ctx, {
        action: 'customer.merged',
        targetType: 'customer',
        targetId: target.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.merged',
        aggregateType: 'customer',
        aggregateId: target.id,
        payload: data,
      });
    });
    return this.get(target.id);
  }

  async findActive(db: DbOrTx, id: string, followMerge = true): Promise<Customer> {
    let current = id;
    for (let hops = 0; hops < 5; hops++) {
      const [c] = await db.select().from(customers).where(eq(customers.id, current));
      if (!c) break;
      if (!c.mergedIntoId) return c;
      if (!followMerge)
        throw new BadRequestException('Customer has been merged into another record');
      current = c.mergedIntoId;
    }
    throw new NotFoundException('Customer not found');
  }

  /** The customer who owns a channel identity, if any. */
  lookup(type: IdentityType, value: string, db: DbOrTx = this.db) {
    return this.findByIdentity(db, type, normalizeIdentity(type, value));
  }

  private async findByIdentity(db: DbOrTx, type: IdentityType, value: string) {
    const [row] = await db
      .select({ customerId: customerIdentities.customerId })
      .from(customerIdentities)
      .where(and(eq(customerIdentities.type, type), eq(customerIdentities.value, value)));
    return row ? this.findActive(db, row.customerId) : null;
  }

  private async insertCustomer(tx: DbOrTx, ctx: RequestCtx, input: CreateCustomerInput) {
    const email = input.email ? normalizeIdentity('email', input.email) : undefined;
    const phone = input.phone ? normalizeIdentity('phone', input.phone) : undefined;
    const [c] = await tx
      .insert(customers)
      .values({
        displayName: input.displayName,
        primaryEmail: email,
        primaryPhone: phone,
        language: input.language,
        customerType: input.customerType,
        externalRef: input.externalRef,
        attributes: input.attributes,
      })
      .returning();
    await this.audit.record(tx, ctx, {
      action: 'customer.created',
      targetType: 'customer',
      targetId: c!.id,
      data: { displayName: c!.displayName },
    });
    await this.outbox.publish(tx, ctx, {
      type: 'customer.created',
      aggregateType: 'customer',
      aggregateId: c!.id,
      payload: { displayName: c!.displayName },
    });
    if (email) await this.insertIdentity(tx, ctx, c!.id, 'email', email, false);
    if (phone) await this.insertIdentity(tx, ctx, c!.id, 'phone', phone, false);
    return c!;
  }

  private async insertIdentity(
    tx: DbOrTx,
    ctx: RequestCtx,
    customerId: string,
    type: IdentityType,
    value: string,
    verified: boolean,
  ) {
    await tx.insert(customerIdentities).values({ customerId, type, value, verified });
    await this.outbox.publish(tx, ctx, {
      type: 'customer.identity_added',
      aggregateType: 'customer',
      aggregateId: customerId,
      payload: { type, verified },
    });
  }
}
