import { randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, integrations } from '@tms/db';
import {
  type ChatIdentitySecret,
  chatIdentitySecretKey,
  type CreateIntegrationInput,
  type IntegrationView,
  type UpdateIntegrationInput,
} from '@tms/shared';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { SecretsService } from '../settings/secrets.service';
import { ApiKeysService } from './api-keys.service';

type Row = typeof integrations.$inferSelect;

/**
 * Outside apps connected to TMS (ADR 0022). Integrations are switched off,
 * never deleted: their tickets and audit entries keep pointing at them.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly keys: ApiKeysService,
    private readonly secrets: SecretsService,
  ) {}

  async list(): Promise<IntegrationView[]> {
    const [rows, counts] = await Promise.all([
      this.db.select().from(integrations).orderBy(asc(integrations.name)),
      this.keys.activeCounts(),
    ]);
    return Promise.all(rows.map((r) => this.view(r, counts.get(r.id) ?? 0)));
  }

  async get(id: string): Promise<IntegrationView> {
    const [row] = await this.db.select().from(integrations).where(eq(integrations.id, id));
    if (!row) throw new NotFoundException('Integration not found');
    return this.view(row, (await this.keys.activeCounts()).get(id) ?? 0);
  }

  /** The switched-on integration with this slug, for the chat widget's handshake. */
  async activeBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null> {
    const [row] = await this.db.select().from(integrations).where(eq(integrations.slug, slug));
    return row?.isActive ? { id: row.id, slug: row.slug, name: row.name } : null;
  }

  async create(ctx: RequestCtx, input: CreateIntegrationInput): Promise<IntegrationView> {
    const row = await this.db.transaction(async (tx) => {
      // A taken slug fails on its unique index and is answered as a 409.
      const [created] = await tx
        .insert(integrations)
        .values({ slug: input.slug, name: input.name, createdBy: ctx.user?.id ?? null })
        .returning();
      const data = { action: 'created', slug: created!.slug, name: created!.name };
      await this.audit.record(tx, ctx, {
        action: 'integration.created',
        targetType: 'integration',
        targetId: created!.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'integration.config_changed',
        aggregateType: 'integration',
        aggregateId: created!.id,
        payload: data,
      });
      return created!;
    });
    return this.view(row, 0);
  }

  async update(
    ctx: RequestCtx,
    id: string,
    input: UpdateIntegrationInput,
  ): Promise<IntegrationView> {
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(integrations)
        .where(eq(integrations.id, id))
        .for('update');
      if (!before) throw new NotFoundException('Integration not found');
      await tx.update(integrations).set(input).where(eq(integrations.id, id));
      const data = { action: 'updated', slug: before.slug, changes: input };
      await this.audit.record(tx, ctx, {
        action: 'integration.updated',
        targetType: 'integration',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'integration.config_changed',
        aggregateType: 'integration',
        aggregateId: id,
        payload: data,
      });
    });
    return this.get(id);
  }

  /**
   * Generates (or replaces) the secret the integration's site signs chat
   * identity tokens with (ADR 0026). Returned once, like an API key; the
   * secret store records the change.
   */
  async newChatIdentitySecret(ctx: RequestCtx, id: string): Promise<ChatIdentitySecret> {
    const integration = await this.get(id);
    const secret = `chid_${randomBytes(32).toString('base64url')}`;
    await this.secrets.set(ctx, chatIdentitySecretKey(integration.slug), secret);
    return { secret };
  }

  private async view(row: Row, activeKeys: number): Promise<IntegrationView> {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      isActive: row.isActive,
      activeKeys,
      chatIdentityLast4: (await this.secrets.has(chatIdentitySecretKey(row.slug))).last4,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
