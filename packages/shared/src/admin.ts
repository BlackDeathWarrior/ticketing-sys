import { z } from 'zod';
import { STATUS_CATEGORIES } from './tickets';

export const createTeamSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  parentId: z.string().uuid().optional(),
});

export const upsertStatusSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lowercase letters, digits and underscores'),
  name: z.string().trim().min(1).max(60),
  category: z.enum(STATUS_CATEGORIES),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  isActive: z.boolean().default(true),
});

export const setTransitionsSchema = z.object({
  transitions: z
    .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
    .min(1)
    .max(500),
});

export const auditQuerySchema = z.object({
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  actorId: z.string().uuid().optional(),
  /** user | ai | system | customer: separate what the AI did from what people did. */
  actorType: z.enum(['user', 'ai', 'system', 'customer']).optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
});
