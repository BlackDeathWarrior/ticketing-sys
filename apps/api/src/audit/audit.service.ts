import { Inject, Injectable } from '@nestjs/common';
import { auditLog, type Database, type DbOrTx } from '@tms/db';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditQuery {
  targetType?: string;
  targetId?: string;
  actorId?: string;
  action?: string;
  limit: number;
  before?: number;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Call inside the same transaction as the change so the record can't be lost. */
  async record(tx: DbOrTx, ctx: RequestCtx, entry: AuditEntry): Promise<void> {
    await tx.insert(auditLog).values({
      actorType: ctx.actor.type,
      actorId: ctx.actor.id ?? null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      data: entry.data ?? {},
      requestId: ctx.requestId ?? null,
      ip: ctx.ip ?? null,
    });
  }

  async list(q: AuditQuery) {
    const where: SQL[] = [];
    if (q.targetType) where.push(eq(auditLog.targetType, q.targetType));
    if (q.targetId) where.push(eq(auditLog.targetId, q.targetId));
    if (q.actorId) where.push(eq(auditLog.actorId, q.actorId));
    if (q.action) where.push(eq(auditLog.action, q.action));
    if (q.before) where.push(lt(auditLog.id, q.before));
    return this.db
      .select()
      .from(auditLog)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(auditLog.id))
      .limit(q.limit);
  }
}
