import argon2 from 'argon2';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import {
  DEFAULT_STATUSES,
  DEFAULT_TRANSITIONS,
  DELEGABLE_PERMISSIONS,
  SYSTEM_ROLES,
} from '@tms/shared';
import type { Database } from './client';
import {
  categories,
  customerIdentities,
  customers,
  rolePermissions,
  roles,
  teamMembers,
  teams,
  ticketStatuses,
  userRoles,
  users,
  workflowTransitions,
} from './schema';

export interface SeedOptions {
  adminEmail: string;
  adminPassword: string;
  /** Adds demo teams, categories and a customer. Off in production. */
  demoData?: boolean;
}

/**
 * Idempotent: safe to run on every deploy. Creates system roles, the default
 * ticket workflow and the first admin account. Never overwrites an existing
 * admin password or statuses an admin has since edited.
 */
export async function seedDatabase(db: Database, opts: SeedOptions): Promise<void> {
  await db.transaction(async (tx) => {
    // Roles and their permissions: system roles are kept in sync with code.
    for (const [key, def] of Object.entries(SYSTEM_ROLES)) {
      const [role] = await tx
        .insert(roles)
        .values({ key, name: def.name, description: def.description, isSystem: true })
        .onConflictDoUpdate({
          target: roles.key,
          set: { name: def.name, description: def.description, isSystem: true },
        })
        .returning({ id: roles.id });
      // Permissions an admin granted to this role (the delegable ones) survive a redeploy.
      await tx
        .delete(rolePermissions)
        .where(
          and(
            eq(rolePermissions.roleId, role!.id),
            notInArray(rolePermissions.permission, [...DELEGABLE_PERMISSIONS]),
          ),
        );
      await tx
        .insert(rolePermissions)
        .values(def.permissions.map((permission) => ({ roleId: role!.id, permission })))
        .onConflictDoNothing();
    }

    // Workflow: only inserted when the table is empty so admin edits survive.
    const [{ count }] = (await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ticketStatuses)) as [{ count: number }];
    if (count === 0) {
      await tx.insert(ticketStatuses).values(
        DEFAULT_STATUSES.map((s) => ({
          key: s.key,
          name: s.name,
          category: s.category,
          sortOrder: s.sortOrder,
          isInitial: s.isInitial ?? false,
        })),
      );
      await tx
        .insert(workflowTransitions)
        .values(DEFAULT_TRANSITIONS.map(([fromStatus, toStatus]) => ({ fromStatus, toStatus })));
    }

    // First admin.
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = lower(${opts.adminEmail})`);
    let adminId = existing[0]?.id;
    if (!adminId) {
      const [admin] = await tx
        .insert(users)
        .values({
          email: opts.adminEmail,
          name: 'Administrator',
          passwordHash: await argon2.hash(opts.adminPassword),
        })
        .returning({ id: users.id });
      adminId = admin!.id;
    }
    const [adminRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.key, 'admin'));
    await tx
      .insert(userRoles)
      .values({ userId: adminId, roleId: adminRole!.id })
      .onConflictDoNothing();

    if (opts.demoData) await seedDemo(tx as unknown as Database, adminId);
  });
}

async function seedDemo(db: Database, adminId: string): Promise<void> {
  const teamNames = ['Orders', 'Billing', 'Returns'];
  for (const name of teamNames) {
    await db
      .insert(teams)
      .values({ name, description: `${name} support` })
      .onConflictDoNothing();
  }
  const [orders] = await db.select().from(teams).where(eq(teams.name, 'Orders'));
  await db
    .insert(teamMembers)
    .values({ teamId: orders!.id, userId: adminId })
    .onConflictDoNothing();

  const tree: Record<string, string[]> = {
    Orders: ['Tracking', 'Cancellation', 'Delivery issue'],
    Billing: ['Duplicate charge', 'Refund status', 'Invoice'],
    Returns: ['Return request', 'Exchange'],
    Account: ['Login', 'Profile update'],
  };
  for (const [parent, children] of Object.entries(tree)) {
    let [p] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.name, parent), sql`${categories.parentId} IS NULL`));
    if (!p) [p] = await db.insert(categories).values({ name: parent }).returning();
    for (const child of children) {
      await db.insert(categories).values({ name: child, parentId: p!.id }).onConflictDoNothing();
    }
  }

  const email = 'priya.sharma@example.com';
  const found = await db
    .select()
    .from(customerIdentities)
    .where(and(eq(customerIdentities.type, 'email'), eq(customerIdentities.value, email)));
  if (found.length === 0) {
    const [c] = await db
      .insert(customers)
      .values({
        displayName: 'Priya Sharma (demo)',
        primaryEmail: email,
        primaryPhone: '919830012345',
        language: 'en',
      })
      .returning();
    await db.insert(customerIdentities).values([
      { customerId: c!.id, type: 'email', value: email, verified: true },
      { customerId: c!.id, type: 'whatsapp', value: '919830012345', verified: true },
    ]);
  }
}
