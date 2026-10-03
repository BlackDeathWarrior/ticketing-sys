import { z } from 'zod';
import { SYSTEM_ROLES } from './permissions';

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({ refreshToken: z.string().min(20) });

/** Password rule for accounts created by admins; SSO arrives in the hardening phase. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .regex(/[a-z]/, 'Include a lowercase letter')
  .regex(/[A-Z]/, 'Include an uppercase letter')
  .regex(/\d/, 'Include a digit');

export const roleKeySchema = z.enum(Object.keys(SYSTEM_ROLES) as [keyof typeof SYSTEM_ROLES]);

export const createUserSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(200),
  password: passwordSchema,
  roles: z.array(z.string().min(1)).min(1).default(['agent']),
  teamIds: z.array(z.string().uuid()).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    isActive: z.boolean(),
    roles: z.array(z.string().min(1)).min(1),
    teamIds: z.array(z.string().uuid()),
    password: passwordSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  roles: string[];
  permissions: string[];
  /** The teams the person is on, and whether they are an admin of each (ADR 0031). */
  teams?: Array<{ id: string; role: TeamRole }>;
}

/** A team member is a `member` or an `admin` of the team; a team can have several admins. */
export const TEAM_ROLES = ['member', 'admin'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Whether a person may act on a ticket (ADR 0031): every team's tickets with
 * `ticket:any_team` (super admins), a ticket with no team yet, or one of
 * their own team's. Everyone with `ticket:read` may still read and add notes.
 */
export function canActOnTeam(
  user: Pick<CurrentUser, 'permissions' | 'teams'>,
  teamId: string | null | undefined,
): boolean {
  if (!teamId) return true;
  if (user.permissions.includes('ticket:any_team')) return true;
  return !!user.teams?.some((t) => t.id === teamId);
}

/**
 * Whether a person may approve or reject a request (ADR 0031): a request
 * that belongs to a team (the tool's approving team, else the ticket's) is
 * decided by any member of that team; one without a team by holders of
 * `approval:approve`. Super admins (`ticket:any_team`) decide any.
 */
export function canDecideApproval(
  user: Pick<CurrentUser, 'permissions' | 'teams'>,
  teamId: string | null | undefined,
): boolean {
  if (user.permissions.includes('ticket:any_team')) return true;
  if (!teamId) return user.permissions.includes('approval:approve');
  return !!user.teams?.some((t) => t.id === teamId);
}

/** Whether a person is an admin of the team (or may manage every team). */
export function isTeamAdmin(
  user: Pick<CurrentUser, 'permissions' | 'teams'>,
  teamId: string,
): boolean {
  if (user.permissions.includes('team:manage')) return true;
  return !!user.teams?.some((t) => t.id === teamId && t.role === 'admin');
}
