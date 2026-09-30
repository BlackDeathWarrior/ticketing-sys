import { z } from 'zod';

export const IDENTITY_TYPES = [
  'email',
  'phone',
  'whatsapp',
  'webchat_session',
  'external_id',
] as const;
export const identityTypeSchema = z.enum(IDENTITY_TYPES);
export type IdentityType = z.infer<typeof identityTypeSchema>;

export const CUSTOMER_TYPES = ['standard', 'vip', 'business', 'internal'] as const;
export const customerTypeSchema = z.enum(CUSTOMER_TYPES);

/**
 * Canonical form used for identity matching, so "+91 98300-12345" on WhatsApp
 * and "919830012345" from a CRM resolve to the same customer.
 */
export function normalizeIdentity(type: IdentityType, value: string): string {
  const v = value.trim();
  switch (type) {
    case 'email':
      return v.toLowerCase();
    case 'phone':
    case 'whatsapp': {
      const digits = v.replace(/[^\d]/g, '');
      return digits;
    }
    default:
      return v;
  }
}

export const identityInputSchema = z.object({
  type: identityTypeSchema,
  value: z.string().trim().min(1).max(320),
  verified: z.boolean().default(false),
});
export type IdentityInput = z.infer<typeof identityInputSchema>;

export const createCustomerSchema = z.object({
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(5).max(32).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  customerType: customerTypeSchema.default('standard'),
  externalRef: z.string().trim().max(200).optional(),
  attributes: z.record(z.unknown()).default({}),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema
  .omit({ email: true, phone: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const resolveCustomerSchema = z.object({
  type: identityTypeSchema,
  value: z.string().trim().min(1).max(320),
  displayName: z.string().trim().max(200).optional(),
});
export type ResolveCustomerInput = z.infer<typeof resolveCustomerSchema>;

export const mergeCustomersSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
});

export const listCustomersQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
