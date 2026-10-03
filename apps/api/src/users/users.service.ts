import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Database,
  type DbOrTx,
  rolePermissions,
  roles,
  teamMembers,
  teams,
  userRoles,
  users,
} from '@tms/db';
import {
  type CreateUserInput,
  type CurrentUser,
  DEFAULT_USER_PREFERENCES,
  isDelegable,
  type RoleView,
  SYSTEM_ROLES,
  type SystemRoleKey,
  type UpdateUserInput,
  type UserPreferences,
  userPreferencesSchema,
} from '@tms/shared';
import argon2 from 'argon2';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';

const PUBLIC_COLUMNS = {
  id: users.id,
  email: users.email,
  name: users.name,
  isActive: users.isActive,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

/** Short-lived cache so the auth guard doesn't hit the DB on every request. */
const AUTH_CACHE_TTL_MS = 10_000;

@Injectable()
export class UsersService {
  private readonly authCache = new Map<string, { at: number; value: CurrentUser | null }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Returns the user with roles and permissions, or null if missing or deactivated. */
  async getAuthContext(userId: string): Promise<CurrentUser | null> {
    const hit = this.authCache.get(userId);
    if (hit && Date.now() - hit.at < AUTH_CACHE_TTL_MS) return hit.value;

    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    let value: CurrentUser | null = null;
    if (u && u.isActive) {
      const rows = await this.db
        .select({ key: roles.key, permission: rolePermissions.permission })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .where(eq(userRoles.userId, userId));
      const memberships = await this.db
        .select({ id: teamMembers.teamId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, userId));
      value = {
        id: u.id,
        email: u.email,
        name: u.name,
        roles: [...new Set(rows.map((r) => r.key))].sort(),
        permissions: [
          ...new Set(rows.map((r) => r.permission).filter((p): p is string => !!p)),
        ].sort(),
        teams: memberships.map((m) => ({
          id: m.id,
          role: m.role === 'admin' ? 'admin' : 'member',
        })),
      };
    }
    this.authCache.set(userId, { at: Date.now(), value });
    return value;
  }

  invalidate(userId: string): void {
    this.authCache.delete(userId);
  }

  async findByEmail(email: string) {
    const [u] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`);
    return u ?? null;
  }

  async list() {
    const rows = await this.db.select(PUBLIC_COLUMNS).from(users).orderBy(asc(users.name));
    return this.withRolesAndTeams(rows);
  }

  /**
   * Active users holding a permission (through any of their roles), optionally
   * only members of a team. Used to pick who gets a notification.
   */
  async withPermission(
    permission: string,
    teamId?: string | null,
  ): Promise<Array<{ id: string; name: string; email: string }>> {
    const rows = await this.db
      .selectDistinct({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .where(
        and(
          eq(users.isActive, true),
          eq(rolePermissions.permission, permission),
          teamId
            ? inArray(
                users.id,
                this.db
                  .select({ id: teamMembers.userId })
                  .from(teamMembers)
                  .where(eq(teamMembers.teamId, teamId)),
              )
            : undefined,
        ),
      );
    return rows;
  }

  // ---- roles ----

  async listRoles(): Promise<RoleView[]> {
    const rows = await this.db
      .select({ role: roles, permission: rolePermissions.permission })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id));
    const byKey = new Map<string, RoleView>();
    for (const { role, permission } of rows) {
      const view = byKey.get(role.key) ?? {
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: [],
        grants: [],
        locked: role.key === 'admin',
      };
      if (permission) {
        view.permissions.push(permission);
        // Beyond what the role is built with: granted by an admin, and theirs to take back.
        const builtIn = SYSTEM_ROLES[role.key as SystemRoleKey]?.permissions as
          readonly string[] | undefined;
        if (!builtIn?.includes(permission)) view.grants!.push(permission);
      }
      byKey.set(role.key, view);
    }
    // Least to most powerful, so "who else may do this" reads naturally.
    return [...byKey.values()]
      .map((r) => ({ ...r, permissions: r.permissions.sort() }))
      .sort((a, b) => a.permissions.length - b.permissions.length);
  }

  /**
   * Gives a role one of the delegable permissions, or takes it back. The
   * permissions that define each system role stay fixed in code; administrators
   * always have everything.
   */
  async setRolePermission(
    ctx: RequestCtx,
    roleKey: string,
    permission: string,
    granted: boolean,
  ): Promise<RoleView> {
    if (!isDelegable(permission)) {
      throw new BadRequestException(`${permission} cannot be granted to other roles`);
    }
    const [role] = await this.db.select().from(roles).where(eq(roles.key, roleKey));
    if (!role) throw new NotFoundException('Role not found');
    if (role.key === 'admin') {
      throw new BadRequestException('Super admins always have every permission');
    }
    const builtIn = SYSTEM_ROLES[role.key as SystemRoleKey]?.permissions as
      readonly string[] | undefined;
    if (!granted && builtIn?.includes(permission)) {
      throw new BadRequestException(
        `${permission} is part of the ${role.name} role and stays with it`,
      );
    }
    await this.db.transaction(async (tx) => {
      const changed = granted
        ? await tx
            .insert(rolePermissions)
            .values({ roleId: role.id, permission })
            .onConflictDoNothing()
            .returning({ permission: rolePermissions.permission })
        : await tx
            .delete(rolePermissions)
            .where(
              and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permission, permission)),
            )
            .returning({ permission: rolePermissions.permission });
      if (!changed.length) return;
      const data = { role: role.key, permission, granted };
      await this.audit.record(tx, ctx, {
        action: granted ? 'role.permission_granted' : 'role.permission_revoked',
        targetType: 'role',
        targetId: role.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'role.permissions_changed',
        aggregateType: 'role',
        aggregateId: role.id,
        payload: data,
      });
    });
    // Signed-in users pick the change up on their next request.
    this.authCache.clear();
    return (await this.listRoles()).find((r) => r.key === role.key)!;
  }

  async get(id: string) {
    const rows = await this.db.select(PUBLIC_COLUMNS).from(users).where(eq(users.id, id));
    if (!rows[0]) throw new NotFoundException('User not found');
    return (await this.withRolesAndTeams(rows))[0]!;
  }

  async create(ctx: RequestCtx, input: CreateUserInput) {
    const passwordHash = await argon2.hash(input.password);
    const id = await this.db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: input.email, name: input.name, passwordHash })
        .returning({ id: users.id });
      await this.setRoles(tx, u!.id, input.roles);
      await this.setTeams(tx, u!.id, input.teamIds);
      const data = { email: input.email, roles: input.roles, teamIds: input.teamIds };
      await this.audit.record(tx, ctx, {
        action: 'user.created',
        targetType: 'user',
        targetId: u!.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'user.created',
        aggregateType: 'user',
        aggregateId: u!.id,
        payload: data,
      });
      return u!.id;
    });
    return this.get(id);
  }

  /** Active people's ids and names, nothing else. */
  async directory(): Promise<Array<{ id: string; name: string }>> {
    return this.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(asc(users.name));
  }

  async update(ctx: RequestCtx, id: string, input: UpdateUserInput) {
    const before = await this.get(id);
    if (ctx.user?.id === id && input.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (
      ctx.user?.id === id &&
      input.roles &&
      before.roles.includes('admin') &&
      !input.roles.includes('admin')
    ) {
      throw new BadRequestException('You cannot remove your own super admin role');
    }
    // Someone must always be able to manage everything.
    const losesAdmin =
      before.roles.includes('admin') &&
      ((input.roles && !input.roles.includes('admin')) || input.isActive === false);
    if (losesAdmin) {
      const admins = (await this.list()).filter((u) => u.isActive && u.roles.includes('admin'));
      if (admins.length <= 1) {
        throw new BadRequestException('This is the last super admin. Make someone else one first.');
      }
    }
    await this.db.transaction(async (tx) => {
      const set: Partial<typeof users.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.isActive !== undefined) set.isActive = input.isActive;
      if (input.password !== undefined) set.passwordHash = await argon2.hash(input.password);
      if (Object.keys(set).length) await tx.update(users).set(set).where(eq(users.id, id));
      if (input.roles) await this.setRoles(tx, id, input.roles);
      if (input.teamIds) await this.setTeams(tx, id, input.teamIds);
      // Never log the password itself.
      const data = { ...input, password: input.password ? '[changed]' : undefined };
      await this.audit.record(tx, ctx, {
        action: 'user.updated',
        targetType: 'user',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'user.updated',
        aggregateType: 'user',
        aggregateId: id,
        payload: { fields: Object.keys(input) },
      });
    });
    this.invalidate(id);
    return this.get(id);
  }

  /** A person's own Orbit Desk settings, with defaults for whatever they never set. */
  async preferences(userId: string): Promise<UserPreferences> {
    const [row] = await this.db
      .select({ preferences: users.preferences })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) throw new NotFoundException('User not found');
    // Stored by an older version, or edited by hand: fall back rather than fail.
    const parsed = userPreferencesSchema.safeParse(row.preferences);
    return parsed.success ? parsed.data : DEFAULT_USER_PREFERENCES;
  }

  /** Only ever the caller's own. */
  async setPreferences(ctx: RequestCtx, input: UserPreferences): Promise<UserPreferences> {
    const id = ctx.user!.id;
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ preferences: input }).where(eq(users.id, id));
      await this.audit.record(tx, ctx, {
        action: 'user.preferences_updated',
        targetType: 'user',
        targetId: id,
        data: { sections: Object.keys(input) },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'user.updated',
        aggregateType: 'user',
        aggregateId: id,
        payload: { fields: ['preferences'] },
      });
    });
    return this.preferences(id);
  }

  /** Ids of the teams a user belongs to. */
  async teamIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));
    return rows.map((r) => r.teamId);
  }

  async touchLogin(id: string): Promise<void> {
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  }

  private async setRoles(tx: DbOrTx, userId: string, roleKeys: string[]) {
    const found = await tx.select().from(roles).where(inArray(roles.key, roleKeys));
    const missing = roleKeys.filter((k) => !found.some((r) => r.key === k));
    if (missing.length) throw new BadRequestException(`Unknown role(s): ${missing.join(', ')}`);
    await tx.delete(userRoles).where(eq(userRoles.userId, userId));
    await tx.insert(userRoles).values(found.map((r) => ({ userId, roleId: r.id })));
  }

  /** Joins and leaves teams; a membership that stays keeps its role (admin or member). */
  private async setTeams(tx: DbOrTx, userId: string, teamIds: string[]) {
    const wanted = [...new Set(teamIds)];
    const current = await tx
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId));
    const leaving = current.map((c) => c.teamId).filter((t) => !wanted.includes(t));
    if (leaving.length) {
      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, leaving)));
    }
    const joining = wanted.filter((t) => !current.some((c) => c.teamId === t));
    if (joining.length) {
      await tx.insert(teamMembers).values(joining.map((teamId) => ({ teamId, userId })));
    }
  }

  private async withRolesAndTeams<T extends { id: string }>(rows: T[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const roleRows = await this.db
      .select({ userId: userRoles.userId, key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(inArray(userRoles.userId, ids));
    const teamRows = await this.db
      .select({ userId: teamMembers.userId, id: teams.id, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(inArray(teamMembers.userId, ids));
    return rows.map((r) => ({
      ...r,
      roles: roleRows.filter((x) => x.userId === r.id).map((x) => x.key),
      teams: teamRows.filter((x) => x.userId === r.id).map(({ id, name }) => ({ id, name })),
    }));
  }
}
