import { z } from 'zod';

/**
 * The AI agent's behaviour (Phase 5, ADR 0011), stored as the `ai.behaviour`
 * app setting. Per channel: `auto` sends confident replies itself, `draft`
 * only drafts for a human to approve, `off` leaves conversations to humans.
 */
export const AI_CHANNEL_MODES = ['auto', 'draft', 'off'] as const;
export const aiChannelModeSchema = z.enum(AI_CHANNEL_MODES);
export type AiChannelMode = z.infer<typeof aiChannelModeSchema>;

/** Channels the AI can take conversations on. */
export const AI_CHANNELS = ['webchat', 'whatsapp', 'voice', 'email'] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];

export const AI_BEHAVIOUR_KEY = 'ai.behaviour';

const confidence = z.number().min(0).max(1);

export const aiBehaviourSchema = z
  .object({
    channels: z
      .object({
        webchat: aiChannelModeSchema.default('auto'),
        whatsapp: aiChannelModeSchema.default('auto'),
        voice: aiChannelModeSchema.default('auto'),
        email: aiChannelModeSchema.default('draft'),
      })
      .default({}),
    /** At or above: send on `auto` channels. */
    sendAt: confidence.default(0.8),
    /** Below: hand over to a human. Between the two: draft. */
    handoverBelow: confidence.default(0.6),
    /** Hand over after this many unconfident turns in one conversation. */
    maxFailedTurns: z.number().int().min(1).max(20).default(3),
    /** Model steps (tool calls plus the answer) per turn. */
    maxSteps: z.number().int().min(1).max(10).default(4),
    /** Classify new tickets (category, priority, language, intent, sentiment). */
    classifyTickets: z.boolean().default(true),
    /**
     * After a confident answer that settles the question, move the ticket to
     * Pending Customer; the customer's next message hands it back to the AI.
     */
    awaitCustomerWhenAnswered: z.boolean().default(true),
  })
  .refine((b) => b.handoverBelow <= b.sendAt, {
    message: 'The handover threshold must not be above the send threshold',
    path: ['handoverBelow'],
  });
export type AiBehaviour = z.infer<typeof aiBehaviourSchema>;
export const DEFAULT_AI_BEHAVIOUR: AiBehaviour = aiBehaviourSchema.parse({});

export const AI_DECISIONS = ['sent', 'drafted', 'handover', 'skipped', 'error'] as const;
export type AiDecision = (typeof AI_DECISIONS)[number];

/** Why a turn was capped or handed over (recorded on the run, shown to agents). */
export const AI_RULES = [
  'asked_for_human',
  'ai_requested',
  'low_confidence',
  'no_sources',
  'unsupported_promise',
  'repeated_failures',
  'budget_exhausted',
  'no_model',
  'model_error',
  'draft_channel',
  'no_answer',
] as const;
export type AiRule = (typeof AI_RULES)[number];

export const AI_RULE_LABELS: Record<AiRule, string> = {
  asked_for_human: 'The customer asked for a person',
  ai_requested: 'The AI asked for a colleague',
  low_confidence: 'Not confident enough',
  no_sources: 'No knowledge base source',
  unsupported_promise: 'Made a promise no tool confirmed',
  repeated_failures: 'Too many unconfident replies',
  budget_exhausted: 'AI budget reached',
  no_model: 'No AI model available',
  model_error: 'The AI model failed',
  draft_channel: 'This channel only gets drafts',
  no_answer: 'The model gave no answer',
};

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** Stored on the ticket when the classifier ran. */
export interface AiClassification {
  category: string | null;
  subcategory: string | null;
  priority: 'urgent' | 'high' | 'normal' | 'low' | null;
  language: string | null;
  intent: string | null;
  sentiment: Sentiment | null;
  confidence: number;
  model: string | null;
  at: string;
}

export interface AiRunView {
  id: string;
  kind: 'turn' | 'classify';
  decision: AiDecision;
  confidence: number | null;
  rules: AiRule[];
  model: string | null;
  promptVersion: string;
  tools: Array<{ name: string; summary: string }>;
  sources: Array<{ chunkId: string; label: string }>;
  replyMessageId: string | null;
  language: string | null;
  intent: string | null;
  costUsd: number;
  latencyMs: number;
  error: string | null;
  createdAt: string;
}

// ---- API contracts ----

export const approveDraftSchema = z.object({
  /** The edited text, when the agent changed the draft before sending. */
  body: z.string().trim().min(1).max(20_000).optional(),
});
export type ApproveDraftInput = z.infer<typeof approveDraftSchema>;

/** Dry-run the agent on a made-up conversation (Settings → AI, and `pnpm ai:eval`). */
export const simulateAiSchema = z.object({
  channel: z.enum(AI_CHANNELS).default('webchat'),
  messages: z
    .array(
      z.object({
        author: z.enum(['customer', 'ai', 'agent']),
        body: z.string().trim().min(1).max(5_000),
      }),
    )
    .min(1)
    .max(30),
});
export type SimulateAiInput = z.infer<typeof simulateAiSchema>;

export interface SimulateAiResult {
  decision: AiDecision;
  reply: string | null;
  confidence: number | null;
  rules: AiRule[];
  language: string | null;
  intent: string | null;
  tools: Array<{ name: string; summary: string }>;
  sources: Array<{ chunkId: string; label: string }>;
  model: string | null;
  latencyMs: number;
}

/**
 * Deterministic language guess from the script, for when no language
 * detection service is configured. Returns a BCP-47 base code.
 */
export function guessLanguage(text: string): string | null {
  const scripts: Array<[RegExp, string]> = [
    [/[ऀ-ॿ]/, 'hi'],
    [/[ঀ-৿]/, 'bn'],
    [/[਀-੿]/, 'pa'],
    [/[઀-૿]/, 'gu'],
    [/[଀-୿]/, 'od'],
    [/[஀-௿]/, 'ta'],
    [/[ఀ-౿]/, 'te'],
    [/[ಀ-೿]/, 'kn'],
    [/[ഀ-ൿ]/, 'ml'],
  ];
  for (const [re, code] of scripts) if (re.test(text)) return code;
  return /[a-z]/i.test(text) ? 'en' : null;
}

/** Plain requests for a person, in English and Hindi. */
export function asksForHuman(text: string): boolean {
  return /\b(human|real person|a person|someone real|live agent|an agent|speak to (a |an |someone|somebody)|talk to (a |an |someone|somebody)|representative|manager)\b|इंसान|किसी व्यक्ति|एजेंट से बात/i.test(
    text,
  );
}

/** A golden conversation from apps/api/test/evals/*.yaml. */
export interface AiGolden {
  name: string;
  channel?: (typeof AI_CHANNELS)[number];
  messages: Array<{ customer?: string; ai?: string; agent?: string }>;
  expect: {
    decision?: AiDecision | AiDecision[];
    notDecision?: AiDecision;
    replyIncludes?: string[];
    sentReplyExcludes?: string[];
    usesKnowledge?: boolean;
    rules?: AiRule[];
  };
}

/** The simulate request for a golden. */
export function goldenToSimulation(g: AiGolden): SimulateAiInput {
  return {
    channel: g.channel ?? 'webchat',
    messages: g.messages.map((m) =>
      m.customer !== undefined
        ? { author: 'customer' as const, body: m.customer }
        : m.ai !== undefined
          ? { author: 'ai' as const, body: m.ai }
          : { author: 'agent' as const, body: m.agent ?? '' },
    ),
  };
}

/** Problems with a result against a golden's expectations (empty means it passed). */
export function checkAiGolden(g: AiGolden, r: SimulateAiResult): string[] {
  const problems: string[] = [];
  const e = g.expect;
  const reply = (r.reply ?? '').toLowerCase();
  if (e.decision) {
    const ok = Array.isArray(e.decision) ? e.decision : [e.decision];
    if (!ok.includes(r.decision))
      problems.push(`decision ${r.decision}, expected ${ok.join(' or ')}`);
  }
  if (e.notDecision && r.decision === e.notDecision)
    problems.push(`decision must not be ${e.notDecision}`);
  for (const s of e.replyIncludes ?? []) {
    if (!reply.includes(s.toLowerCase())) problems.push(`reply lacks "${s}"`);
  }
  if (r.decision === 'sent') {
    for (const s of e.sentReplyExcludes ?? []) {
      if (reply.includes(s.toLowerCase())) problems.push(`sent reply contains "${s}"`);
    }
  }
  if (e.usesKnowledge && !r.sources.length) problems.push('no knowledge source cited');
  for (const rule of e.rules ?? []) {
    if (!r.rules.includes(rule)) problems.push(`missing rule ${rule}`);
  }
  return problems;
}
