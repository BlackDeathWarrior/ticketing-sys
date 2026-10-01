import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, type DbOrTx, webhookDeliveries, webhookSubscriptions } from '@tms/db';
import {
  type CreateWebhookInput,
  type ListDeliveriesQuery,
  type UpdateWebhookInput,
  WEBHOOK_PING,
  type WebhookDeliveryStatus,
  type WebhookDeliveryView,
  type WebhookEvent,
  type WebhookEventType,
  type WebhookScope,
  webhookSecretKey,
  type WebhookTestResult,
  type WebhookView,
  type WebhookWithSecret,
} from '@tms/shared';
import { and, arrayContains, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { IntegrationsService } from '../integrations/integrations.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SecretsService } from '../settings/secrets.service';
import { UsersService } from '../users/users.service';
import type { MappedEvent, WebhookRefs } from './webhook-events';
import { type SendOutcome, WebhookSender } from './webhook-sender';
import { generateWebhookSecret } from './webhook-sign';

export type Subscription = typeof webhookSubscriptions.$inferSelect;
export type Delivery = typeof webhookDeliveries.$inferSelect;

function deliveryView(d: Delivery): WebhookDeliveryView {
  return {
    id: d.id,
    eventType: d.eventType as WebhookEventType,
    status: d.status as WebhookDeliveryStatus,
    attempts: d.attempts,
    httpStatus: d.httpStatus,
    error: d.error,
    durationMs: d.durationMs,
    redeliveryOf: d.redeliveryOf,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
  };
}

/**
 * Webhook subscriptions of integrations and their delivery log (ADR 0025).
 * Subscription changes are audited; the delivery log is a log and is not.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly secrets: SecretsService,
    private readonly sender: WebhookSender,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly integrations: IntegrationsService,
  ) {}

  async list(integrationId: string): Promise<WebhookView[]> {
    const rows = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.integrationId, integrationId))
      .orderBy(asc(webhookSubscriptions.createdAt));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<WebhookView> {
    return this.view(await this.row(id));
  }

  /** Creates a subscription with a new signing secret. The answer is the only place the secret appears. */
  async create(
    ctx: RequestCtx,
    integrationId: string,
    input: CreateWebhookInput,
  ): Promise<WebhookWithSecret> {
    await this.assertUrl(input.url);
    await this.integrations.get(integrationId);
    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(webhookSubscriptions)
        .values({ integrationId, ...input, createdBy: ctx.user?.id ?? null })
        .returning();
      await this.changed(tx, ctx, created!, 'webhook_created', {
        url: created!.url,
        events: created!.events,
        scope: created!.scope,
      });
      return created!;
    });
    const secret = generateWebhookSecret();
    await this.secrets.set(ctx, webhookSecretKey(row.id), secret);
    return { ...(await this.view(row)), secret };
  }

  async update(ctx: RequestCtx, id: string, input: UpdateWebhookInput): Promise<WebhookView> {
    if (input.url) await this.assertUrl(input.url);
    const row = await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id);
      const [updated] = await tx
        .update(webhookSubscriptions)
        .set({
          ...input,
          // Switched back on by a person: start counting failures afresh.
          ...(input.isActive ? { consecutiveFailures: 0, disabledReason: null } : {}),
        })
        .where(eq(webhookSubscriptions.id, id))
        .returning();
      await this.changed(tx, ctx, before, 'webhook_updated', { changes: input });
      return updated!;
    });
    return this.view(row);
  }

  async remove(ctx: RequestCtx, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const before = await this.lock(tx, id);
      await tx.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
      await this.changed(tx, ctx, before, 'webhook_deleted', { url: before.url });
    });
    await this.secrets.delete(ctx, webhookSecretKey(id)).catch(() => undefined);
  }

  /** Replaces the signing secret. Deliveries are signed with the new one from the next send. */
  async rotateSecret(ctx: RequestCtx, id: string): Promise<WebhookWithSecret> {
    const row = await this.row(id);
    const secret = generateWebhookSecret();
    await this.secrets.set(ctx, webhookSecretKey(id), secret);
    return { ...(await this.view(row)), secret };
  }

  async deliveries(id: string, q: ListDeliveriesQuery): Promise<WebhookDeliveryView[]> {
    await this.row(id);
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.subscriptionId, id),
          q.status ? eq(webhookDeliveries.status, q.status) : undefined,
        ),
      )
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(q.limit);
    return rows.map(deliveryView);
  }

  /**
   * Queues a copy of an earlier delivery. The worker picks it up from the
   * outbox event, so nothing is sent inside this request.
   */
  async redeliver(ctx: RequestCtx, deliveryId: string): Promise<WebhookDeliveryView> {
    return this.db.transaction(async (tx) => {
      const [original] = await tx
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      if (!original) throw new NotFoundException('Delivery not found');
      if (original.eventType === WEBHOOK_PING) {
        throw new BadRequestException('Send a new test instead of repeating an old one');
      }
      const subscription = await this.lock(tx, original.subscriptionId);
      const [copy] = await tx
        .insert(webhookDeliveries)
        .values({
          subscriptionId: original.subscriptionId,
          eventId: randomUUID(),
          eventType: original.eventType,
          eventAt: original.eventAt,
          refs: original.refs,
          redeliveryOf: original.redeliveryOf ?? original.id,
        })
        .returning();
      const data = {
        deliveryId: copy!.id,
        redeliveryOf: copy!.redeliveryOf,
        webhookId: subscription.id,
      };
      await this.audit.record(tx, ctx, {
        action: 'integration.webhook_redelivered',
        targetType: 'integration',
        targetId: subscription.integrationId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'webhook.redelivery_requested',
        aggregateType: 'integration',
        aggregateId: subscription.integrationId,
        payload: data,
      });
      return deliveryView(copy!);
    });
  }

  /** Sends a `ping` now and says what came back. It is logged like any delivery, but never retried. */
  async test(id: string): Promise<WebhookTestResult> {
    const subscription = await this.row(id);
    const integration = await this.integrations.get(subscription.integrationId);
    const [delivery] = await this.db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: id,
        eventId: randomUUID(),
        eventType: WEBHOOK_PING,
        eventAt: new Date(),
      })
      .returning();
    const secret = await this.secrets.get(webhookSecretKey(id));
    const outcome: SendOutcome = secret
      ? await this.sender.send(subscription.url, secret, {
          id: delivery!.id,
          type: WEBHOOK_PING,
          createdAt: delivery!.eventAt.toISOString(),
          integration: integration.slug,
          data: { message: 'A test from TMS. Nothing happened.' },
        })
      : {
          ok: false,
          httpStatus: null,
          durationMs: 0,
          error: 'The signing secret is missing. Rotate it.',
          permanent: true,
        };
    await this.db
      .update(webhookDeliveries)
      .set({
        status: outcome.ok ? 'delivered' : 'failed',
        attempts: 1,
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        durationMs: outcome.durationMs,
        deliveredAt: outcome.ok ? new Date() : null,
      })
      .where(eq(webhookDeliveries.id, delivery!.id));
    return {
      ok: outcome.ok,
      httpStatus: outcome.httpStatus,
      durationMs: outcome.durationMs,
      error: outcome.error,
    };
  }

  // ---- For the worker ----

  /**
   * Active subscriptions that want this event. `owner` is the integration the
   * event belongs to (its ticket or incident), or null for a ticket no
   * integration raised: only `all` subscriptions get those.
   */
  async matching(type: WebhookEvent, owner: string | null): Promise<Subscription[]> {
    const rows = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(
        and(
          eq(webhookSubscriptions.isActive, true),
          arrayContains(webhookSubscriptions.events, [type]),
        ),
      );
    return rows.filter((s) => (s.scope as WebhookScope) === 'all' || s.integrationId === owner);
  }

  /** The delivery row for an event and subscription, created once however often this runs. */
  async queue(subscriptionId: string, event: { id: string; at: Date }, mapped: MappedEvent) {
    await this.db
      .insert(webhookDeliveries)
      .values({
        subscriptionId,
        eventId: event.id,
        eventType: mapped.type,
        eventAt: event.at,
        refs: mapped.refs as Record<string, unknown>,
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.subscriptionId, subscriptionId),
          eq(webhookDeliveries.eventId, event.id),
        ),
      );
    return row!.id;
  }

  async delivery(id: string) {
    const [row] = await this.db
      .select({ delivery: webhookDeliveries, subscription: webhookSubscriptions })
      .from(webhookDeliveries)
      .innerJoin(
        webhookSubscriptions,
        eq(webhookSubscriptions.id, webhookDeliveries.subscriptionId),
      )
      .where(eq(webhookDeliveries.id, id));
    if (!row) return null;
    const integration = await this.integrations.get(row.subscription.integrationId);
    return {
      ...row,
      integration,
      refs: row.delivery.refs as WebhookRefs,
      secret: await this.secrets.get(webhookSecretKey(row.subscription.id)),
    };
  }

  /**
   * Notes the outcome of one attempt. `final` means no further attempt will be
   * made: a failure then counts against the subscription, and enough of them
   * in a row switch it off.
   */
  async recordAttempt(
    delivery: Delivery,
    outcome: Pick<SendOutcome, 'ok' | 'httpStatus' | 'error' | 'durationMs'>,
    final: boolean,
  ): Promise<void> {
    await this.db
      .update(webhookDeliveries)
      .set({
        status: outcome.ok ? 'delivered' : final ? 'failed' : 'pending',
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        durationMs: outcome.durationMs,
        deliveredAt: outcome.ok ? new Date() : null,
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    if (outcome.ok) {
      await this.db
        .update(webhookSubscriptions)
        .set({ consecutiveFailures: 0, lastDeliveryAt: new Date() })
        .where(eq(webhookSubscriptions.id, delivery.subscriptionId));
      return;
    }
    if (final) await this.countFailure(delivery.subscriptionId, outcome.error ?? 'failed');
  }

  /** Deletes log rows older than `before`. Deliveries still waiting stay. */
  async purgeDeliveries(before: Date): Promise<number> {
    const rows = await this.db
      .delete(webhookDeliveries)
      .where(
        and(lt(webhookDeliveries.createdAt, before), sql`${webhookDeliveries.status} <> 'pending'`),
      )
      .returning({ id: webhookDeliveries.id });
    return rows.length;
  }

  private async countFailure(subscriptionId: string, lastError: string): Promise<void> {
    const disabled = await this.db.transaction(async (tx) => {
      const subscription = await this.lock(tx, subscriptionId).catch(() => null);
      if (!subscription?.isActive) return null;
      const failures = subscription.consecutiveFailures + 1;
      if (failures < this.env.WEBHOOK_DISABLE_AFTER) {
        await tx
          .update(webhookSubscriptions)
          .set({ consecutiveFailures: failures })
          .where(eq(webhookSubscriptions.id, subscriptionId));
        return null;
      }
      const reason = `Switched off after ${failures} deliveries in a row failed. The last error: ${lastError}`;
      await tx
        .update(webhookSubscriptions)
        .set({ consecutiveFailures: failures, isActive: false, disabledReason: reason })
        .where(eq(webhookSubscriptions.id, subscriptionId));
      await this.changed(tx, SYSTEM_CTX, subscription, 'webhook_disabled', { failures });
      return { subscription, reason };
    });
    if (!disabled) return;
    this.logger.warn(`webhook ${subscriptionId} switched off: ${disabled.reason}`);
    const admins = await this.users.withPermission('integration:manage');
    await this.notifications.notify(
      admins.map((a) => a.id),
      {
        kind: 'webhook.disabled',
        title: 'A webhook was switched off',
        body: `${new URL(disabled.subscription.url).host}: ${disabled.reason}`,
        dedupeKey: `webhook-disabled:${subscriptionId}:${new Date().toISOString().slice(0, 13)}`,
      },
    );
  }

  private async assertUrl(url: string): Promise<void> {
    const refused = await this.sender.refusal(url);
    if (refused) throw new BadRequestException(refused);
  }

  private async changed(
    tx: DbOrTx,
    ctx: RequestCtx,
    subscription: Subscription,
    action: string,
    extra: Record<string, unknown>,
  ) {
    const data = { action, webhookId: subscription.id, ...extra };
    await this.audit.record(tx, ctx, {
      action: `integration.${action}`,
      targetType: 'integration',
      targetId: subscription.integrationId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'integration.config_changed',
      aggregateType: 'integration',
      aggregateId: subscription.integrationId,
      payload: data,
    });
  }

  private async row(id: string): Promise<Subscription> {
    const [row] = await this.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id));
    if (!row) throw new NotFoundException('Webhook not found');
    return row;
  }

  private async lock(tx: DbOrTx, id: string): Promise<Subscription> {
    const [row] = await tx
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id))
      .for('update');
    if (!row) throw new NotFoundException('Webhook not found');
    return row;
  }

  private async view(s: Subscription): Promise<WebhookView> {
    return {
      id: s.id,
      integrationId: s.integrationId,
      url: s.url,
      description: s.description,
      events: s.events as WebhookEvent[],
      scope: s.scope as WebhookScope,
      isActive: s.isActive,
      disabledReason: s.disabledReason,
      consecutiveFailures: s.consecutiveFailures,
      secretLast4: (await this.secrets.has(webhookSecretKey(s.id))).last4,
      lastDeliveryAt: s.lastDeliveryAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    };
  }
}
