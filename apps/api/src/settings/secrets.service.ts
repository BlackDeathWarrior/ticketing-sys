import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, secrets, users } from '@tms/db';
import {
  type KnownSecretKey,
  maskedLast4,
  SECRET_KEYS,
  secretScope,
  type SecretView,
} from '@tms/shared';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { decryptSecret, encryptSecret, masterKeyFrom } from './secret-crypto';

/**
 * Write-only credential store. Plaintext goes in through `set` and comes out
 * only through `get`, which server-side code (senders, pollers, tool calls)
 * uses. No route returns a value; views show the last four characters at most.
 */
@Injectable()
export class SecretsService {
  private readonly logger = new Logger(SecretsService.name);
  private readonly masterKey: Buffer;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {
    this.masterKey = masterKeyFrom(env.TMS_SECRETS_KEY);
    if (!env.TMS_SECRETS_KEY && env.NODE_ENV === 'development') {
      this.logger.warn('TMS_SECRETS_KEY is not set; using the development key for stored secrets');
    }
  }

  async list(): Promise<SecretView[]> {
    const rows = await this.db
      .select({ secret: secrets, userName: users.name })
      .from(secrets)
      .leftJoin(users, eq(users.id, secrets.updatedBy))
      .orderBy(asc(secrets.key));
    return rows.map(({ secret: s, userName }) => ({
      key: s.key,
      scope: s.scope as SecretView['scope'],
      label: SECRET_KEYS[s.key as KnownSecretKey]?.label ?? s.key,
      last4: s.last4,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: s.updatedBy && userName ? { id: s.updatedBy, name: userName } : null,
    }));
  }

  /** Creates or rotates a secret. */
  async set(ctx: RequestCtx, key: string, value: string): Promise<SecretView> {
    const ciphertext = encryptSecret(this.masterKey, key, value);
    const last4 = maskedLast4(value);
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: secrets.id })
        .from(secrets)
        .where(eq(secrets.key, key))
        .for('update');
      await tx
        .insert(secrets)
        .values({
          key,
          scope: secretScope(key),
          ciphertext,
          last4,
          updatedBy: ctx.user?.id ?? null,
        })
        .onConflictDoUpdate({
          target: secrets.key,
          set: { ciphertext, last4, keyVersion: 1, updatedBy: ctx.user?.id ?? null },
        });
      const data = { key, action: existing ? 'rotated' : 'created', last4 };
      await this.audit.record(tx, ctx, {
        action: `settings.secret_${existing ? 'rotated' : 'created'}`,
        targetType: 'secret',
        targetId: key,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'settings.secret_changed',
        aggregateType: 'settings',
        aggregateId: key,
        payload: data,
      });
    });
    return (await this.list()).find((s) => s.key === key)!;
  }

  async delete(ctx: RequestCtx, key: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(secrets).where(eq(secrets.key, key)).returning();
      if (!row) throw new NotFoundException('Secret not found');
      const data = { key, action: 'deleted' };
      await this.audit.record(tx, ctx, {
        action: 'settings.secret_deleted',
        targetType: 'secret',
        targetId: key,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'settings.secret_changed',
        aggregateType: 'settings',
        aggregateId: key,
        payload: data,
      });
    });
  }

  /** Server-side only. Returns null when the secret isn't set or can't be decrypted. */
  async get(key: string): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(eq(secrets.key, key));
    if (!row) return null;
    try {
      return decryptSecret(this.masterKey, key, row.ciphertext);
    } catch (err) {
      // Wrong master key or a tampered row. Never log the ciphertext.
      this.logger.error(`secret ${key} could not be decrypted: ${(err as Error).message}`);
      return null;
    }
  }

  async has(key: string): Promise<{ set: boolean; last4: string | null }> {
    const [row] = await this.db
      .select({ last4: secrets.last4 })
      .from(secrets)
      .where(eq(secrets.key, key));
    return { set: !!row, last4: row?.last4 ?? null };
  }
}
