import { z } from 'zod';

/**
 * Customer satisfaction (CSAT): one rating from 1 to 5 per ticket, given by
 * the customer after it is resolved: from the survey email, the chat widget,
 * the portal, or the app of the integration that raised the ticket. Agents
 * can read ratings but never give them.
 */
export const CSAT_LABELS: Record<number, string> = {
  1: 'Very unhappy',
  2: 'Unhappy',
  3: 'Okay',
  4: 'Happy',
  5: 'Very happy',
};

/** Ratings of 4 and 5 count as satisfied. */
export const isSatisfied = (rating: number) => rating >= 4;
/** Ratings of 1 and 2 are brought to the team's attention. */
export const isLowRating = (rating: number) => rating <= 2;

/** `api`: given in an integration's own app and passed on with its API key (ADR 0023). */
export const CSAT_SOURCES = ['email', 'chat', 'portal', 'api'] as const;
export type CsatSource = (typeof CSAT_SOURCES)[number];

/** A ticket can be rated for this long after it is resolved. */
export const CSAT_WINDOW_DAYS = 30;

export const csatSubmitSchema = z.object({
  rating: z.coerce.number().int().min(1, 'Choose a rating').max(5),
  comment: z
    .string()
    .trim()
    .max(2000, 'Keep the comment under 2,000 characters')
    .optional()
    .transform((v) => v || undefined),
});
export type CsatSubmit = z.output<typeof csatSubmitSchema>;

export interface CsatView {
  rating: number;
  comment: string | null;
  source: CsatSource;
  createdAt: string;
  updatedAt: string;
}

/** What the public rating page shows for a survey link. */
export interface CsatPrompt {
  reference: string;
  subject: string;
  rating: CsatView | null;
}

/** Sent to the chat widget when a chat ticket is resolved. */
export interface ChatRatingPrompt {
  /** Signed; the widget sends it back with the rating. */
  token: string;
  reference: string;
}

export const chatRatingSchema = csatSubmitSchema.extend({ token: z.string().min(10).max(500) });

// ---- Settings ----

export const CUSTOMER_EXPERIENCE_KEY = 'customer_experience';

export const customerExperienceSchema = z.object({
  /** Customers can sign in to "My requests" with a link sent to their email. */
  portalEnabled: z.boolean().default(true),
  /** Ask for a rating by email when an email or request-form ticket is resolved. */
  csatByEmail: z.boolean().default(true),
  /** Ask in the chat window when a chat ticket is resolved. */
  csatInChat: z.boolean().default(true),
  /**
   * Minutes of an agent's work a ticket takes on average. Used only to
   * estimate the time the AI saved in reports.
   */
  agentMinutesPerTicket: z.coerce.number().int().min(1).max(240).default(10),
});
export type CustomerExperience = z.output<typeof customerExperienceSchema>;

export const DEFAULT_CUSTOMER_EXPERIENCE: CustomerExperience = customerExperienceSchema.parse({});
