import { Inject, Injectable } from '@nestjs/common';
import { appSettings, type Database } from '@tms/db';
import { eq } from 'drizzle-orm';
import type { z, ZodTypeAny } from 'zod';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

const CACHE_TTL_MS = 5_000;

/**
 * Typed key/value settings. Never holds secrets (SecretsService does). Reads
 * are cached briefly; a write clears the local cache, and the worker clears
 * its own on the `settings.updated` event.
 */
@Injectable()
export class AppSettingsService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * The stored value parsed with `schema`, or null when unset or no longer
   * valid. `fresh` skips the cache, for readers that must not act on a setting
   * that changed a moment ago in another process.
   */
  async get<S extends ZodTypeAny>(
    key: string,
    schema: S,
    opts: { fresh?: boolean } = {},
  ): Promise<z.output<S> | null> {
    if (opts.fresh) this.cache.delete(key);
    const raw = await this.raw(key);
    if (raw === undefined) return null;
    const parsed = schema.safeParse(raw);
    return parsed.success ? (parsed.data as z.output<S>) : null;
  }

  async set(ctx: RequestCtx, key: string, value: unknown, auditData?: Record<string, unknown>) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(appSettings)
        .values({ key, value, updatedBy: ctx.user?.id ?? null })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value, updatedBy: ctx.user?.id ?? null },
        });
      const data = { key, ...(auditData ?? { value }) };
      await this.audit.record(tx, ctx, {
        action: 'settings.updated',
        targetType: 'setting',
        targetId: key,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'settings.updated',
        aggregateType: 'settings',
        aggregateId: key,
        payload: { key },
      });
    });
    this.cache.delete(key);
  }

  invalidate(key?: string): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  private async raw(key: string): Promise<unknown> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    const [row] = await this.db.select().from(appSettings).where(eq(appSettings.key, key));
    this.cache.set(key, { at: Date.now(), value: row?.value });
    return row?.value;
  }
}
