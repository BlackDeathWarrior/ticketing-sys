import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  conversations,
  customerFlags,
  customerIdentities,
  customers,
  type Database,
  type DbOrTx,
  tickets,
} from '@tms/db';
import {
  type CreateCustomerInput,
  type CustomerFlagKind,
  type CustomerFlagView,
  type IdentityInput,
  type IdentityType,
  normalizeIdentity,
  type ResolveCustomerInput,
  type UpdateCustomerInput,
} from '@tms/shared';
import { and, desc, eq, gt, ilike, inArray, isNull, ne, or } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { isUniqueViolation } from '../common/exception.filter';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

type Customer = typeof customers.$inferSelect;

/** Identity types that say nothing about a person beyond the number they write from. */
const PHONE_ONLY_TYPES: readonly string[] = ['phone', 'whatsapp', 'whatsapp_bsuid'];

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
    return { ...c, identities, recentTickets, flags: await this.flags(c.id) };
  }

  /** Every flag on the customer, newest first; cleared ones stay as history. */
  async flags(customerId: string): Promise<CustomerFlagView[]> {
    const rows = await this.db
      .select()
      .from(customerFlags)
      .where(eq(customerFlags.customerId, customerId))
      .orderBy(desc(customerFlags.createdAt))
      .limit(50);
    return rows.map((f) => ({
      id: f.id,
      kind: f.kind as CustomerFlagKind,
      ticketId: f.ticketId,
      createdAt: f.createdAt.toISOString(),
      clearedAt: f.clearedAt?.toISOString() ?? null,
      clearNote: f.clearNote,
    }));
  }

  /** Whether the customer was flagged since `since` and nobody has cleared it. */
  async flaggedSince(customerId: string, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ id: customerFlags.id })
      .from(customerFlags)
      .where(
        and(
          eq(customerFlags.customerId, customerId),
          isNull(customerFlags.clearedAt),
          gt(customerFlags.createdAt, since),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** Flags a customer in the caller's transaction (the AI closing a conversation for misuse). */
  async flagInTx(
    tx: DbOrTx,
    ctx: RequestCtx,
    customerId: string,
    flag: {
      kind: CustomerFlagKind;
      pattern: string | null;
      ticketId: string;
      conversationId: string;
    },
  ): Promise<void> {
    await tx.insert(customerFlags).values({ customerId, ...flag });
    const data = { kind: flag.kind, pattern: flag.pattern, ticketId: flag.ticketId };
    await this.audit.record(tx, ctx, {
      action: 'customer.flagged',
      targetType: 'customer',
      targetId: customerId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'customer.updated',
      aggregateType: 'customer',
      aggregateId: customerId,
      payload: { fields: ['flags'], ...data },
    });
  }

  /** A person decides the flag no longer applies. The AI gives the customer warnings again. */
  async clearFlag(ctx: RequestCtx, customerId: string, flagId: string, note: string) {
    const c = await this.findActive(this.db, customerId);
    await this.db.transaction(async (tx) => {
      const [flag] = await tx
        .update(customerFlags)
        .set({ clearedAt: new Date(), clearedBy: ctx.user?.id ?? null, clearNote: note })
        .where(
          and(
            eq(customerFlags.id, flagId),
            eq(customerFlags.customerId, c.id),
            isNull(customerFlags.clearedAt),
          ),
        )
        .returning({ id: customerFlags.id, kind: customerFlags.kind });
      if (!flag) throw new NotFoundException('Flag not found, or already cleared');
      await this.audit.record(tx, ctx, {
        action: 'customer.flag_cleared',
        targetType: 'customer',
        targetId: c.id,
        data: { flagId, kind: flag.kind, note },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.updated',
        aggregateType: 'customer',
        aggregateId: c.id,
        payload: { fields: ['flags'] },
      });
    });
    return this.get(c.id);
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
    if (owner) {
      if (owner.customerId === customerId) {
        if (input.verified && !owner.verified) {
          await tx
            .update(customerIdentities)
            .set({ verified: true })
            .where(eq(customerIdentities.id, owner.id));
        }
        return true;
      }
      // A proven address beats one that someone else only typed (into a chat, say):
      // otherwise typing a stranger's address would keep it from its owner.
      if (input.type === 'email' && input.verified && !owner.verified) {
        await this.moveEmail(tx, ctx, owner, customerId, value);
        return true;
      }
      return false;
    }
    await this.insertIdentity(tx, ctx, customerId, input.type, value, input.verified);
    if (input.type === 'email') await this.fillPrimaryEmail(tx, ctx, customerId, value);
    return true;
  }

  /** Gives an unproven email identity to the customer who proved it is theirs. */
  private async moveEmail(
    tx: DbOrTx,
    ctx: RequestCtx,
    owner: { id: string; customerId: string },
    customerId: string,
    email: string,
  ) {
    await tx
      .update(customerIdentities)
      .set({ customerId, verified: true })
      .where(eq(customerIdentities.id, owner.id));
    const [cleared] = await tx
      .update(customers)
      .set({ primaryEmail: null })
      .where(and(eq(customers.id, owner.customerId), eq(customers.primaryEmail, email)))
      .returning({ id: customers.id });
    await this.recordIdentityMove(tx, ctx, owner.customerId, customerId, 'email', !!cleared);
    await this.fillPrimaryEmail(tx, ctx, customerId, email);
  }

  /** Audits and announces an identity moving between two customers, on both. */
  private async recordIdentityMove(
    tx: DbOrTx,
    ctx: RequestCtx,
    fromId: string,
    toId: string,
    type: IdentityType,
    clearedPrimary: boolean,
  ) {
    const primary = type === 'email' ? 'primaryEmail' : 'primaryPhone';
    for (const [id, data] of [
      [fromId, { identityMovedTo: toId, type, ...(clearedPrimary ? { [primary]: null } : {}) }],
      [toId, { identityMovedFrom: fromId, type }],
    ] as const) {
      await this.audit.record(tx, ctx, {
        action: 'customer.updated',
        targetType: 'customer',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'customer.updated',
        aggregateType: 'customer',
        aggregateId: id,
        payload: { fields: ['identities'] },
      });
    }
  }

  /**
   * A customer first known by something else (a chat identity, an app's own
   * id) gets the first email attached to them as their contact address.
   */
  private async fillPrimaryEmail(tx: DbOrTx, ctx: RequestCtx, customerId: string, email: string) {
    const [filled] = await tx
      .update(customers)
      .set({ primaryEmail: email })
      .where(and(eq(customers.id, customerId), isNull(customers.primaryEmail)))
      .returning({ id: customers.id });
    if (!filled) return;
    await this.audit.record(tx, ctx, {
      action: 'customer.updated',
      targetType: 'customer',
      targetId: customerId,
      data: { primaryEmail: email },
    });
    await this.outbox.publish(tx, ctx, {
      type: 'customer.updated',
      aggregateType: 'customer',
      aggregateId: customerId,
      payload: { fields: ['primaryEmail'] },
    });
  }

  /** Moves identities, tickets and conversations from source to target, then retires source. */
  async merge(ctx: RequestCtx, sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new BadRequestException('Cannot merge a customer into itself');
    const source = await this.findActive(this.db, sourceId, false);
    const target = await this.findActive(this.db, targetId, false);
    await this.db.transaction((tx) => this.mergeInTx(tx, ctx, source, target));
    return this.get(target.id);
  }

  private async mergeInTx(tx: DbOrTx, ctx: RequestCtx, source: Customer, target: Customer) {
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
    await tx.update(customers).set({ mergedIntoId: target.id }).where(eq(customers.id, source.id));
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
  }

  /** Makes `phone` the customer's one proven number, inside the caller's transaction. */
  async provePhone(tx: DbOrTx, ctx: RequestCtx, customerId: string, phone: string): Promise<void> {
    const value = normalizeIdentity('phone', phone);
    const customer = await this.findActive(tx, customerId);

    // Whoever else holds the number loses it: it is now proven to be this customer's.
    const holders = await tx
      .selectDistinct({ customerId: customerIdentities.customerId })
      .from(customerIdentities)
      .where(
        and(
          ne(customerIdentities.customerId, customer.id),
          eq(customerIdentities.value, value),
          inArray(customerIdentities.type, ['phone', 'whatsapp']),
        ),
      );
    for (const holder of holders) {
      const other = await this.findActive(tx, holder.customerId, false);
      const theirs = await tx
        .select({ type: customerIdentities.type })
        .from(customerIdentities)
        .where(eq(customerIdentities.customerId, other.id));
      const phoneOnly =
        !other.primaryEmail && theirs.every((i) => PHONE_ONLY_TYPES.includes(i.type));
      if (phoneOnly) {
        // Nothing but a number identified them: they were this person on another channel.
        await this.mergeInTx(tx, ctx, other, customer);
        continue;
      }
      await tx
        .update(customerIdentities)
        .set({ customerId: customer.id })
        .where(
          and(
            eq(customerIdentities.customerId, other.id),
            eq(customerIdentities.value, value),
            inArray(customerIdentities.type, ['phone', 'whatsapp']),
          ),
        );
      const [cleared] = await tx
        .update(customers)
        .set({ primaryPhone: null })
        .where(and(eq(customers.id, other.id), eq(customers.primaryPhone, value)))
        .returning({ id: customers.id });
      await this.recordIdentityMove(tx, ctx, other.id, customer.id, 'phone', !!cleared);
    }

    await this.attachIdentity(tx, ctx, customer.id, { type: 'phone', value, verified: true });
    await tx.update(customers).set({ primaryPhone: value }).where(eq(customers.id, customer.id));

    // One proven number per customer: the numbers it replaces go, with their WhatsApp twins.
    const replaced = await tx
      .delete(customerIdentities)
      .where(
        and(
          eq(customerIdentities.customerId, customer.id),
          eq(customerIdentities.type, 'phone'),
          eq(customerIdentities.verified, true),
          ne(customerIdentities.value, value),
        ),
      )
      .returning({ value: customerIdentities.value });
    if (replaced.length) {
      await tx.delete(customerIdentities).where(
        and(
          eq(customerIdentities.customerId, customer.id),
          eq(customerIdentities.type, 'whatsapp'),
          inArray(customerIdentities.value, replaced.map((r) => r.value)),
        ),
      );
    }

    await this.audit.record(tx, ctx, {
      action: 'customer.phone_verified',
      targetType: 'customer',
      targetId: customer.id,
      data: { last4: value.slice(-4), replaced: replaced.length },
    });
    await this.outbox.publish(tx, ctx, {
      type: 'customer.updated',
      aggregateType: 'customer',
      aggregateId: customer.id,
      payload: { fields: ['identities', 'primaryPhone'] },
    });
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

  /** What outside apps call these customers: their `external_id` identities, by customer id. */
  async externalIds(ids: string[], db: DbOrTx = this.db): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    if (!ids.length) return found;
    const rows = await db
      .select({ customerId: customerIdentities.customerId, value: customerIdentities.value })
      .from(customerIdentities)
      .where(
        and(
          inArray(customerIdentities.customerId, ids),
          eq(customerIdentities.type, 'external_id'),
        ),
      );
    for (const r of rows) found.set(r.customerId, [...(found.get(r.customerId) ?? []), r.value]);
    return found;
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
