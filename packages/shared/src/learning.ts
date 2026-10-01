import { z } from 'zod';
import type { CsatSummary, HandledBy } from './reports';

/**
 * Learning from customer ratings (ADR 0020). Two rules shape everything here:
 *
 * - By itself, the system only ever makes the AI more careful: answers on a
 *   topic or from a document customers rated badly go to a person first.
 * - Anything that changes what the AI says (a lesson, a knowledge base
 *   article) is written or approved by a person. Customers' words are never
 *   fed to the AI as instructions.
 */

/** Ratings older than this no longer count. */
export const LEARNING_WINDOW_DAYS = 90;
/** Fewer ratings than this say nothing yet. */
export const LEARNING_MIN_RATINGS = 3;
/** An average at or below this, on enough ratings, is "rated badly". */
export const LEARNING_POOR_AVERAGE = 2.5;
/** Lessons given to the AI in one turn. */
export const LESSONS_PER_TURN = 6;

export const isPoorlyRated = (average: number | null, ratings: number) =>
  average !== null && ratings >= LEARNING_MIN_RATINGS && average <= LEARNING_POOR_AVERAGE;

export const lessonSchema = z.object({
  /** What the AI should do, in a sentence or two. Written by staff, never copied from a customer. */
  body: z
    .string()
    .trim()
    .min(10, 'Write the lesson as a full sentence')
    .max(500, 'Keep the lesson under 500 characters'),
  /** Applies to tickets in this category; null applies everywhere. */
  categoryId: z.string().uuid().nullable().default(null),
  active: z.boolean().default(true),
});
export type LessonInput = z.input<typeof lessonSchema>;

export const updateLessonSchema = z
  .object({
    body: lessonSchema.shape.body,
    categoryId: z.string().uuid().nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export interface LessonView {
  id: string;
  body: string;
  category: { id: string; name: string } | null;
  active: boolean;
  /** The ticket whose rating led to this lesson. */
  sourceTicket: { id: string; reference: string } | null;
  createdBy: string | null;
  createdAt: string;
}

/**
 * `low_rating`: the AI answered and the customer rated it 1 or 2.
 * `good_answer`: the AI passed the ticket on, and the person's answer was
 * rated 4 or 5: knowledge the AI could have had.
 */
export const REVIEW_KINDS = ['low_rating', 'good_answer'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

export const REVIEW_STATUSES = ['open', 'done', 'dismissed'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_KIND_LABELS: Record<ReviewKind, string> = {
  low_rating: 'The AI’s answer was rated low',
  good_answer: 'A person’s answer was rated well',
};

export interface LearningReviewView {
  id: string;
  kind: ReviewKind;
  status: ReviewStatus;
  /** What the reviewer decided: a lesson, a knowledge base draft, or nothing. */
  outcome: 'lesson' | 'kb' | 'none' | null;
  ticket: { id: string; reference: string; subject: string };
  category: { id: string; name: string } | null;
  rating: number;
  /** The customer's comment. For the reviewer's eyes only: the AI never reads it. */
  comment: string | null;
  handledBy: HandledBy;
  /** What the customer first asked. */
  question: string | null;
  /** The AI's last answer (low rating) or the agent's last answer (good answer). */
  answer: string | null;
  /** Knowledge the AI cited on this ticket. */
  sources: string[];
  createdAt: string;
}

export const listReviewsQuerySchema = z.object({
  status: z.enum(REVIEW_STATUSES).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const resolveReviewSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('lesson'),
    body: lessonSchema.shape.body,
    categoryId: z.string().uuid().nullable().default(null),
  }),
  z.object({
    outcome: z.literal('kb'),
    /** The question, as a customer would ask it. */
    title: z.string().trim().min(3).max(200),
    /** The answer. Remove anything personal before saving. */
    content: z.string().trim().min(10).max(20_000),
  }),
  z.object({ outcome: z.literal('none') }),
]);
export type ResolveReviewInput = z.output<typeof resolveReviewSchema>;

/** Why the AI is being careful about a topic or a document. */
export interface Caution {
  kind: 'topic' | 'document';
  id: string;
  name: string;
  average: number;
  ratings: number;
}

export interface LearningOverview {
  enabled: boolean;
  windowDays: number;
  /** How customers rated tickets the AI handled alone: the last 30 days and the 30 before. */
  aiRating: { current: CsatSummary; previous: CsatSummary };
  /** One entry per week, oldest first. */
  weekly: Array<{ week: string; average: number | null; responses: number }>;
  openReviews: number;
  activeLessons: number;
  cautions: Caution[];
}

/** One line for an agent or a report: why a reply was held back. */
export function cautionText(c: Caution): string {
  const what = c.kind === 'topic' ? `Answers about “${c.name}”` : `Answers that used “${c.name}”`;
  return `${what} were rated ${c.average.toFixed(1)} out of 5 (${c.ratings} ratings)`;
}
