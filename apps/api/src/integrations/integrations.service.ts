import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, integrations } from '@tms/db';
import type { CreateIntegrationInput, IntegrationView, UpdateIntegrationInput } from '@tms/shared';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { ApiKeysService } from './api-keys.service';

type Row = typeof integrations.$inferSelect;

function view(row: Row, activeKeys: number): IntegrationView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isActive: row.isActive,
    activeKeys,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

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
  ) {}

  async list(): Promise<IntegrationView[]> {
    const [rows, counts] = await Promise.all([
      this.db.select().from(integrations).orderBy(asc(integrations.name)),
      this.keys.activeCounts(),
    ]);
    return rows.map((r) => view(r, counts.get(r.id) ?? 0));
  }

  async get(id: string): Promise<IntegrationView> {
    const [row] = await this.db.select().from(integrations).where(eq(integrations.id, id));
    if (!row) throw new NotFoundException('Integration not found');
    return view(row, (await this.keys.activeCounts()).get(id) ?? 0);
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
    return view(row, 0);
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
}
