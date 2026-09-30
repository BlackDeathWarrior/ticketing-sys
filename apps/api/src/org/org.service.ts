import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { categories, type Database, teamMembers, teams, users } from '@tms/db';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

/** Teams and ticket categories: small reference data managed by admins. */
@Injectable()
export class OrgService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async listTeams() {
    const [rows, members] = await Promise.all([
      this.db.select().from(teams).orderBy(asc(teams.name)),
      this.db
        .select({ teamId: teamMembers.teamId, id: users.id, name: users.name })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId)),
    ]);
    return rows.map((t) => ({
      ...t,
      members: members.filter((m) => m.teamId === t.id).map(({ id, name }) => ({ id, name })),
    }));
  }

  async createTeam(ctx: RequestCtx, input: { name: string; description?: string }) {
    return this.db.transaction(async (tx) => {
      const [t] = await tx.insert(teams).values(input).returning();
      await this.audit.record(tx, ctx, {
        action: 'team.created',
        targetType: 'team',
        targetId: t!.id,
        data: input,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'team.created',
        aggregateType: 'team',
        aggregateId: t!.id,
        payload: input,
      });
      return t!;
    });
  }

  /** Categories as a two-level tree: category → sub-categories. */
  async listCategories() {
    const rows = await this.db.select().from(categories).orderBy(asc(categories.name));
    return rows
      .filter((c) => !c.parentId)
      .map((c) => ({ ...c, children: rows.filter((x) => x.parentId === c.id) }));
  }

  async createCategory(ctx: RequestCtx, input: { name: string; parentId?: string }) {
    if (input.parentId) {
      const [parent] = await this.db
        .select()
        .from(categories)
        .where(eq(categories.id, input.parentId));
      if (!parent) throw new BadRequestException('Parent category not found');
      if (parent.parentId) throw new BadRequestException('Categories support two levels only');
    }
    return this.db.transaction(async (tx) => {
      const [c] = await tx.insert(categories).values(input).returning();
      await this.audit.record(tx, ctx, {
        action: 'category.created',
        targetType: 'category',
        targetId: c!.id,
        data: input,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'category.created',
        aggregateType: 'category',
        aggregateId: c!.id,
        payload: input,
      });
      return c!;
    });
  }
}
