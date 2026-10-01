import { z } from 'zod';

/**
 * How the helpdesk presents itself to customers (ADR 0026): the company it
 * speaks for, in the help center, in emails and in what the AI says. The
 * defaults are the fictional shop of the sample data, so an installation
 * that sets nothing looks as it always did.
 */
export const BRANDING_KEY = 'branding';

export const brandingSchema = z.object({
  /** The company customers are talking to. */
  companyName: z.string().trim().min(1).max(80).default('Demo Store'),
  /** Who replies are signed by: "Kind regards, <supportName>". */
  supportName: z.string().trim().min(1).max(80).default('Support'),
  /** The line at the bottom of the help center. Empty: no line. */
  helpCenterNote: z
    .string()
    .trim()
    .max(300)
    .default('Demo Store is a fictional shop used to demonstrate TMS.'),
  /**
   * The request form's optional reference field: "Order number" for a shop,
   * "Listing" or "Account number" elsewhere. Null hides the field.
   */
  referenceLabel: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .default('Order number')
    .transform((v) => v || null),
});
export type Branding = z.output<typeof brandingSchema>;
export const DEFAULT_BRANDING: Branding = brandingSchema.parse({});

/** Up to two letters for the mark next to the name: "Ethnic Threads" → "ET". */
export function brandInitials(companyName: string): string {
  const words = companyName.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [companyName.slice(0, 2)];
  return letters.join('').toUpperCase();
}
