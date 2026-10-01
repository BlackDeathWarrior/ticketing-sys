import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { apiKeys, type Database, integrations, users } from '@tms/db';
import type {
  ApiKeyScope,
  ApiKeyStatus,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
} from '@tms/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { RateLimiterService, tooManyRequests } from '../common/rate-limit';
import type { ApiKeyContext, RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { generateApiKey, hashApiKey } from './api-key.util';

type KeyRow = typeof apiKeys.$inferSelect;

/** Wrong keys one address may try per minute before it is told to wait. */
const BAD_KEY_LIMIT = 20;

function statusOf(row: KeyRow, now = new Date()): ApiKeyStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && row.expiresAt <= now) return 'expired';
  return 'active';
}

function view(row: KeyRow, creator: string | null): ApiKeyView {
  return {
    id: row.id,
    integrationId: row.integrationId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as ApiKeyScope[],
    rateLimitPerMinute: row.rateLimitPerMinute,
    status: statusOf(row),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy && creator ? { id: row.createdBy, name: creator } : null,
  };
}

/**
 * API keys of integrations (ADR 0022). A key is stored as its SHA-256 and is
 * looked up on every request, without a cache, so revoking one takes effect
 * at once.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly limiter: RateLimiterService,
  ) {}

  async list(integrationId: string): Promise<ApiKeyView[]> {
    const rows = await this.db
      .select({ key: apiKeys, creator: users.name })
      .from(apiKeys)
      .leftJoin(users, eq(users.id, apiKeys.createdBy))
      .where(eq(apiKeys.integrationId, integrationId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map((r) => view(r.key, r.creator));
  }

  /** Creates a key. The answer is the only place the key itself ever appears. */
  async create(
    ctx: RequestCtx,
    integrationId: string,
    input: CreateApiKeyInput,
  ): Promise<CreatedApiKey> {
    const generated = generateApiKey();
    const row = await this.db.transaction(async (tx) => {
      const [integration] = await tx
        .select({ id: integrations.id })
        .from(integrations)
        .where(eq(integrations.id, integrationId));
      if (!integration) throw new NotFoundException('Integration not found');
      const [created] = await tx
        .insert(apiKeys)
        .values({
          integrationId,
          name: input.name,
          prefix: generated.prefix,
          keyHash: generated.hash,
          scopes: input.scopes,
          rateLimitPerMinute: input.rateLimitPerMinute,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          createdBy: ctx.user?.id ?? null,
        })
        .returning();
      const data = {
        action: 'key_created',
        keyId: created!.id,
        name: created!.name,
        prefix: created!.prefix,
        scopes: created!.scopes,
      };
      await this.audit.record(tx, ctx, {
        action: 'integration.key_created',
        targetType: 'integration',
        targetId: integrationId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'integration.config_changed',
        aggregateType: 'integration',
        aggregateId: integrationId,
        payload: data,
      });
      return created!;
    });
    return { ...view(row, ctx.user?.name ?? null), key: generated.plaintext };
  }

  /** Stops a key for good. Revoking a revoked key changes nothing. */
  async revoke(ctx: RequestCtx, keyId: string): Promise<ApiKeyView> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.id, keyId)).for('update');
      if (!row) throw new NotFoundException('API key not found');
      const [creator] = row.createdBy
        ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy))
        : [];
      if (row.revokedAt) return view(row, creator?.name ?? null);

      const [revoked] = await tx
        .update(apiKeys)
        .set({ revokedAt: new Date(), revokedBy: ctx.user?.id ?? null })
        .where(eq(apiKeys.id, keyId))
        .returning();
      const data = { action: 'key_revoked', keyId, name: row.name, prefix: row.prefix };
      await this.audit.record(tx, ctx, {
        action: 'integration.key_revoked',
        targetType: 'integration',
        targetId: row.integrationId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'integration.config_changed',
        aggregateType: 'integration',
        aggregateId: row.integrationId,
        payload: data,
      });
      return view(revoked!, creator?.name ?? null);
    });
  }

  /**
   * Who a presented key is, or a refusal: 401 for a key that is unknown,
   * revoked, expired or belongs to a switched-off integration; 429 when the
   * key has used up its minute. Guessing is slowed down per network address.
   */
  async authenticate(plaintext: string, ip: string): Promise<ApiKeyContext> {
    const [found] = await this.db
      .select({ key: apiKeys, integration: integrations })
      .from(apiKeys)
      .innerJoin(integrations, eq(integrations.id, apiKeys.integrationId))
      .where(eq(apiKeys.keyHash, hashApiKey(plaintext)));

    if (!found) {
      if (this.limiter.enabled) {
        const bad = await this.limiter.hit('api-key-bad', ip, BAD_KEY_LIMIT, 60);
        if (!bad.allowed) throw tooManyRequests(bad.retryAfter, 'attempts with a wrong API key');
      }
      throw new UnauthorizedException('Invalid API key');
    }
    const { key, integration } = found;
    const status = statusOf(key);
    if (status === 'revoked') throw new UnauthorizedException('This API key was revoked');
    if (status === 'expired') throw new UnauthorizedException('This API key has expired');
    if (!integration.isActive) throw new ForbiddenException('This integration is switched off');

    if (this.limiter.enabled) {
      const use = await this.limiter.hit('api-key', key.id, key.rateLimitPerMinute, 60);
      if (!use.allowed) throw tooManyRequests(use.retryAfter);
    }

    // A usage hint for Settings, written at most once a minute and not audited (ADR 0022).
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, key.id),
          sql`(${apiKeys.lastUsedAt} is null or ${apiKeys.lastUsedAt} < now() - interval '1 minute')`,
        ),
      );

    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      scopes: key.scopes,
      rateLimitPerMinute: key.rateLimitPerMinute,
      integration: { id: integration.id, slug: integration.slug, name: integration.name },
    };
  }

  /** Working keys per integration, for the list in Settings. */
  async activeCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ integrationId: apiKeys.integrationId, count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(
        and(
          isNull(apiKeys.revokedAt),
          sql`(${apiKeys.expiresAt} is null or ${apiKeys.expiresAt} > now())`,
        ),
      )
      .groupBy(apiKeys.integrationId);
    return new Map(rows.map((r) => [r.integrationId, r.count]));
  }
}
