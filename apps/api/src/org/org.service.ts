import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { categories, type Database, teamMembers, teams, users } from '@tms/db';
import { isTeamAdmin, type UpdateCategoryInput, type UpdateTeamInput } from '@tms/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { RoutingService } from '../routing/routing.service';
import { TicketsService } from '../tickets/tickets.service';

/** Teams and ticket categories: small reference data managed by admins. */
@Injectable()
export class OrgService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tickets: TicketsService,
    private readonly routing: RoutingService,
  ) {}

  async listTeams() {
    const [rows, members] = await Promise.all([
      this.db.select().from(teams).orderBy(asc(teams.name)),
      this.db
        .select({
          teamId: teamMembers.teamId,
          id: users.id,
          name: users.name,
          role: teamMembers.role,
        })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId)),
    ]);
    return rows.map((t) => ({
      ...t,
      members: members
        .filter((m) => m.teamId === t.id)
        .map(({ id, name, role }) => ({ id, name, role: role === 'admin' ? 'admin' : 'member' })),
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

  /**
   * Renames a team, changes its description, or replaces its members and
   * admins. Someone with `team:manage` may do all of it; a team's own admin
   * may change who is on the team and who else is its admin (ADR 0031).
   */
  async updateTeam(ctx: RequestCtx, id: string, input: UpdateTeamInput) {
    const { memberIds, adminIds, ...fields } = input;
    const manager = !!ctx.user?.permissions.includes('team:manage');
    if (!manager) {
      if (!ctx.user || !isTeamAdmin(ctx.user, id)) {
        throw new ForbiddenException('Only an admin of this team, or a super admin, can change it');
      }
      if (Object.keys(fields).length) {
        throw new ForbiddenException('Renaming a team needs a super admin');
      }
    }
    await this.db.transaction(async (tx) => {
      const [team] = await tx.select().from(teams).where(eq(teams.id, id)).for('update');
      if (!team) throw new NotFoundException('Team not found');
      if (fields.name && fields.name.toLowerCase() !== team.name.toLowerCase()) {
        const [taken] = await tx.select().from(teams).where(eq(teams.name, fields.name));
        if (taken) throw new ConflictException('Another team already has this name');
      }
      if (Object.keys(fields).length) await tx.update(teams).set(fields).where(eq(teams.id, id));
      if (memberIds) {
        const unique = [...new Set(memberIds)];
        const known = unique.length
          ? await tx.select({ id: users.id }).from(users).where(inArray(users.id, unique))
          : [];
        if (known.length !== unique.length) throw new BadRequestException('Unknown user');
        // Members who stay keep their role; only those who leave or join change.
        const current = await tx
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, id));
        const leaving = current.map((c) => c.userId).filter((u) => !unique.includes(u));
        if (leaving.length) {
          await tx
            .delete(teamMembers)
            .where(and(eq(teamMembers.teamId, id), inArray(teamMembers.userId, leaving)));
        }
        const joining = unique.filter((u) => !current.some((c) => c.userId === u));
        if (joining.length) {
          await tx.insert(teamMembers).values(joining.map((userId) => ({ teamId: id, userId })));
        }
      }
      if (adminIds) {
        const members = (
          await tx
            .select({ userId: teamMembers.userId })
            .from(teamMembers)
            .where(eq(teamMembers.teamId, id))
        ).map((m) => m.userId);
        const admins = [...new Set(adminIds)];
        if (admins.some((a) => !members.includes(a))) {
          throw new BadRequestException('A team admin must be a member of the team');
        }
        // A team admin cannot leave the team without one: someone has to look after it.
        if (!manager && !admins.length) {
          throw new BadRequestException('Keep at least one admin on the team');
        }
        await tx.update(teamMembers).set({ role: 'member' }).where(eq(teamMembers.teamId, id));
        if (admins.length) {
          await tx
            .update(teamMembers)
            .set({ role: 'admin' })
            .where(and(eq(teamMembers.teamId, id), inArray(teamMembers.userId, admins)));
        }
      }
      const data = {
        ...fields,
        ...(memberIds ? { members: memberIds.length } : {}),
        ...(adminIds ? { admins: adminIds.length } : {}),
      };
      await this.audit.record(tx, ctx, {
        action: 'team.updated',
        targetType: 'team',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'team.updated',
        aggregateType: 'team',
        aggregateId: id,
        payload: data,
      });
    });
    return (await this.listTeams()).find((t) => t.id === id)!;
  }

  /**
   * Deletes a team that nothing depends on any more. Open tickets and routing
   * rules must be moved first: deleting would quietly leave them without a team.
   */
  async deleteTeam(ctx: RequestCtx, id: string): Promise<void> {
    const [team] = await this.db.select().from(teams).where(eq(teams.id, id));
    if (!team) throw new NotFoundException('Team not found');
    const open = await this.tickets.openForTeam(id);
    if (open) {
      throw new ConflictException(
        `${team.name} still has ${open} open ticket${open === 1 ? '' : 's'}. Move them to another team first.`,
      );
    }
    const rules = (await this.routing.listRules()).filter((r) => r.team.id === id);
    if (rules.length) {
      throw new ConflictException(
        `${team.name} is used by the routing rule${rules.length === 1 ? '' : 's'} ${rules
          .map((r) => `"${r.name}"`)
          .join(', ')}. Change or delete ${rules.length === 1 ? 'it' : 'them'} first.`,
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(teams).where(eq(teams.id, id));
      await this.audit.record(tx, ctx, {
        action: 'team.deleted',
        targetType: 'team',
        targetId: id,
        data: { name: team.name },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'team.deleted',
        aggregateType: 'team',
        aggregateId: id,
        payload: { name: team.name },
      });
    });
  }

  /** Categories as a two-level tree: category → sub-categories. */
  async listCategories() {
    const rows = await this.db.select().from(categories).orderBy(asc(categories.name));
    return rows
      .filter((c) => !c.parentId)
      .map((c) => ({ ...c, children: rows.filter((x) => x.parentId === c.id) }));
  }

  /** The categories that can be chosen for a ticket now: switched-off ones are left out. */
  async activeCategories() {
    return (await this.listCategories())
      .filter((c) => c.isActive)
      .map((c) => ({ ...c, children: c.children.filter((s) => s.isActive) }));
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

  /** Renames a category or switches it off. An inactive one stays on old tickets. */
  async updateCategory(ctx: RequestCtx, id: string, input: UpdateCategoryInput) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(categories).where(eq(categories.id, id));
      if (!current) throw new NotFoundException('Category not found');
      if (input.name && input.name.toLowerCase() !== current.name.toLowerCase()) {
        const siblings = await tx
          .select({ name: categories.name, parentId: categories.parentId })
          .from(categories);
        const taken = siblings.some(
          (c) =>
            c.parentId === current.parentId && c.name.toLowerCase() === input.name!.toLowerCase(),
        );
        if (taken) throw new ConflictException('Another category here already has this name');
      }
      const [updated] = await tx
        .update(categories)
        .set(input)
        .where(eq(categories.id, id))
        .returning();
      await this.audit.record(tx, ctx, {
        action: 'category.updated',
        targetType: 'category',
        targetId: id,
        data: input,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'category.updated',
        aggregateType: 'category',
        aggregateId: id,
        payload: input,
      });
      return updated!;
    });
  }
}
