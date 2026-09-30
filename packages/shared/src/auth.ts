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
}
