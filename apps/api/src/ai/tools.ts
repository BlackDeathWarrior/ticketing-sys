import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { MAX_CARDS } from '@tms/shared';
import { z } from 'zod';

/**
 * The agent's tools in Phase 5 (Phase 6 adds company-system tools through
 * the tool gateway). Arguments are validated with zod before anything runs;
 * invalid arguments are returned to the model as an error.
 */
export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Search the approved knowledge base (policies, FAQs, help pages). Returns passages with ids to cite.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look up, in plain words' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_ticket',
      description: "Set the ticket's category (a name from the list) or raise its priority.",
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'Category name, optionally "Category > Subcategory"',
          },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal', 'low'] },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_human',
      description:
        'Bring in a human colleague. A last resort, never for being unsure: only when the customer still wants a person after your offer to help, the matter is legal, a safety risk, fraud or a compromised account, it needs an action no tool offers, or a tool keeps failing.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why, in a short sentence' },
          category: {
            type: 'string',
            enum: ['customer_insists', 'legal_or_safety', 'needs_action', 'tool_failure'],
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_reply',
      description:
        'Send (or, depending on settings, draft) your reply to the customer. Ends the turn.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The reply, in the customer’s language' },
          confidence: {
            type: 'number',
            description: 'Your honest confidence (0–1) that the reply is correct and complete',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the knowledge passages you relied on',
          },
          language: { type: 'string', description: 'ISO 639-1 code of the reply language' },
          intent: {
            type: 'string',
            description: 'Short snake_case label of what the customer wants',
          },
          resolves_issue: {
            type: 'boolean',
            description: 'True when this reply fully answers the customer’s question',
          },
          off_topic: {
            type: 'boolean',
            description:
              'True when the customer’s message has nothing to do with the company, its products, orders or services',
          },
        },
        required: ['message', 'confidence'],
      },
    },
  },
];

/**
 * The tools for a turn that may show cards: `send_reply` also takes the ids of the
 * cards to show. A copy; the shared list stays as it is for every other turn.
 */
export function withCardsField(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return tools.map((t) => {
    if (t.type !== 'function' || t.function.name !== 'send_reply') return t;
    const parameters = t.function.parameters as { properties: Record<string, unknown> };
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          ...parameters,
          properties: {
            ...parameters.properties,
            cards: {
              type: 'array',
              items: { type: 'string' },
              description:
                `Ids of the items to show as picture cards (up to ${MAX_CARDS}), from the \`cards\` a tool returned this turn`,
            },
          },
        },
      },
    };
  });
}

export const searchArgs = z.object({ query: z.string().trim().min(1).max(500) });
export const updateTicketArgs = z.object({
  category: z.string().trim().max(200).optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
});
export const requestHumanArgs = z.object({ reason: z.string().trim().max(500).default('') });
export const sendReplyArgs = z.object({
  message: z.string().trim().max(5_000),
  // Left out or unusable: the turn judges the reply on its sources instead (see think()).
  confidence: z.coerce.number().min(0).max(1).optional().catch(undefined),
  sources: z.array(z.string()).max(20).default([]),
  language: z.string().trim().max(10).optional(),
  intent: z.string().trim().max(60).optional(),
  resolves_issue: z.boolean().optional(),
  off_topic: z.boolean().optional().catch(undefined),
  // Ids of cards a tool returned this turn. Models get this wrong in small ways, so it keeps the
  // usable strings and lets think() pick the known ones (the first MAX_CARDS), and only on WhatsApp.
  cards: z
    .array(z.unknown())
    .default([])
    .catch([])
    .transform((list) =>
      list.flatMap((v) => {
        const id = typeof v === 'string' ? v.trim() : '';
        return id && id.length <= 100 ? [id] : [];
      }),
    ),
});

/** Parses a tool call's JSON arguments; returns the zod error message on failure. */
export function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  raw: string,
): { ok: true; value: z.infer<T> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    return { ok: false, error: 'Arguments were not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      };
}
