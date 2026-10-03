import { z } from 'zod';
import { type Priority, prioritySchema } from './tickets';

/**
 * Priority rules (ADR 0032): what makes a ticket urgent, high, normal or low,
 * set by the people who run support (`settings:priority`). The first enabled
 * rule a ticket matches gives its priority. They are applied when the ticket
 * is opened, again once the AI has classified it (its intent and sentiment
 * are known then), and when the customer writes again; after it is opened a
 * rule only ever raises a priority, so a person who lowered one is not
 * overruled by the next message.
 */
export const priorityConditionsSchema = z
  .object({
    channel: z.string().max(40).optional(),
    categoryId: z.string().uuid().optional(),
    customerType: z.string().max(40).optional(),
    tag: z.string().trim().max(60).optional(),
    /**
     * Any of these words or phrases in the subject or the customer's message,
     * as whole words ("payment failed", "charged twice").
     */
    keywords: z.array(z.string().trim().min(2).max(60)).max(30).optional(),
    /** Part of the intent the classifier found, e.g. `refund` matches `refund_request`. */
    intent: z.string().trim().min(2).max(60).optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
    /** A value the app sent with the ticket, e.g. `payment` = `failed`. */
    metadata: z
      .object({ key: z.string().trim().min(1).max(60), value: z.string().trim().max(200) })
      .optional(),
  })
  .strict();
export type PriorityConditions = z.infer<typeof priorityConditionsSchema>;

export const priorityRuleSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(2).max(80),
  enabled: z.boolean().default(true),
  conditions: priorityConditionsSchema,
  priority: prioritySchema,
});
export type PriorityRule = z.infer<typeof priorityRuleSchema>;

export const priorityRulesSchema = z.object({ rules: z.array(priorityRuleSchema).max(100) });
export type PriorityRules = z.infer<typeof priorityRulesSchema>;

/** What a rule is matched against. */
export interface PriorityFacts {
  channel: string;
  categoryId: string | null;
  subcategoryId: string | null;
  customerType: string | null;
  tags: readonly string[];
  /** The subject and the customer's message(s). */
  text: string;
  intent: string | null;
  sentiment: string | null;
  metadata: Record<string, unknown>;
}

export const testPrioritySchema = z.object({
  text: z.string().trim().min(1).max(2000),
  channel: z.string().max(40).default('webchat'),
  intent: z.string().max(60).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
});
export type TestPriorityInput = z.infer<typeof testPrioritySchema>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether one rule's conditions all hold. A rule with no conditions never matches. */
export function priorityRuleMatches(c: PriorityConditions, f: PriorityFacts): boolean {
  if (!Object.keys(c).length) return false;
  if (c.channel && c.channel !== f.channel) return false;
  if (c.categoryId && c.categoryId !== f.categoryId && c.categoryId !== f.subcategoryId) {
    return false;
  }
  if (c.customerType && c.customerType !== f.customerType) return false;
  if (c.tag && !f.tags.includes(c.tag)) return false;
  if (c.keywords?.length) {
    const hit = c.keywords.some((k) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escape(k.toLowerCase())}($|[^\\p{L}\\p{N}])`, 'u').test(
        f.text.toLowerCase(),
      ),
    );
    if (!hit) return false;
  }
  if (c.intent && !(f.intent ?? '').toLowerCase().includes(c.intent.toLowerCase())) return false;
  if (c.sentiment && c.sentiment !== f.sentiment) return false;
  if (c.metadata) {
    const v = f.metadata[c.metadata.key];
    if (
      v === undefined ||
      v === null ||
      String(v).toLowerCase() !== c.metadata.value.toLowerCase()
    ) {
      return false;
    }
  }
  return true;
}

/** The first enabled rule the facts match, or null. */
export function evaluatePriority(
  rules: readonly PriorityRule[],
  f: PriorityFacts,
): { priority: Priority; rule: PriorityRule } | null {
  const rule = rules.find((r) => r.enabled && priorityRuleMatches(r.conditions, f));
  return rule ? { priority: rule.priority, rule } : null;
}

const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Whether `next` is above `current`. */
export const raisesPriority = (current: string, next: Priority) =>
  RANK[next] > (RANK[current as Priority] ?? RANK.normal);

/** Rules a team can start from: words, not ids, so they work in any workspace. */
export const EXAMPLE_PRIORITY_RULES: Array<Omit<PriorityRule, 'id'>> = [
  {
    name: 'Payment failed or charged wrongly',
    enabled: true,
    conditions: {
      keywords: [
        'payment failed',
        'payment declined',
        'charged twice',
        'double charged',
        'money deducted',
        'amount deducted',
        'card declined',
        'not refunded',
      ],
    },
    priority: 'high',
  },
  {
    name: 'The app reports a failed payment',
    enabled: true,
    conditions: { metadata: { key: 'payment', value: 'failed' } },
    priority: 'high',
  },
  {
    name: 'Angry customer',
    enabled: true,
    conditions: { sentiment: 'negative' },
    priority: 'high',
  },
  {
    name: 'Price or stock question',
    enabled: true,
    conditions: { keywords: ['price', 'how much', 'in stock', 'available in', 'discount'] },
    priority: 'low',
  },
];
