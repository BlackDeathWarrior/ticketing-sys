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
export const AI_CHANNELS = ['webchat', 'whatsapp', 'voice', 'email', 'web_form', 'api'] as const;
export type AiChannel = (typeof AI_CHANNELS)[number];

export const AI_BEHAVIOUR_KEY = 'ai.behaviour';

const confidence = z.number().min(0).max(1);

/** 0 = never resolve this channel's tickets for silence; up to 30 days. */
const quietMinutes = z.number().int().min(0).max(43_200);

export const aiBehaviourSchema = z
  .object({
    channels: z
      .object({
        webchat: aiChannelModeSchema.default('auto'),
        whatsapp: aiChannelModeSchema.default('auto'),
        voice: aiChannelModeSchema.default('auto'),
        email: aiChannelModeSchema.default('draft'),
        /** The public request form; replies go out by email. */
        web_form: aiChannelModeSchema.default('draft'),
        /** Tickets an integration creates through the API; the app shows the replies. */
        api: aiChannelModeSchema.default('draft'),
      })
      .default({}),
    /**
     * How a conversation the AI answered is brought to an end (company policy):
     * it asks whether anything else is needed, takes "no" for an answer, and
     * closes a ticket nobody came back to.
     */
    closing: z
      .object({
        /** Add "is there anything else?" to an answer that settles the request. */
        askAnythingElse: z.boolean().default(true),
        /**
         * Minutes of silence after the AI's last answer before the ticket is
         * resolved, per channel. A channel left out uses `autoResolveHours`.
         */
        quietMinutes: z
          .object({
            webchat: quietMinutes.optional(),
            whatsapp: quietMinutes.optional(),
            voice: quietMinutes.optional(),
            email: quietMinutes.optional(),
            web_form: quietMinutes.optional(),
            api: quietMinutes.optional(),
          })
          .default({}),
        /** Tell the customer, where they will see it, that the request was closed for silence. */
        tellCustomer: z.boolean().default(true),
        /** Days a ticket the AI resolved can still be reopened by a reply; then it is closed. 0 = never closed. */
        closeResolvedAfterDays: z.number().int().min(0).max(365).default(7),
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
    /**
     * A ticket the AI answered, and the customer has not replied to for this
     * many hours, is resolved (a later reply reopens it). 0 never resolves.
     */
    autoResolveHours: z.coerce.number().int().min(0).max(720).default(72),
    /**
     * Learn from customer ratings (ADR 0020): follow the lessons staff wrote,
     * and send answers on badly rated topics and documents to a person first.
     */
    learnFromRatings: z.boolean().default(true),
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
  'approval_expired',
  'action_failed',
  'poor_feedback',
  'unsafe_output',
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
  approval_expired: 'An approval request expired',
  action_failed: 'An approved action failed',
  poor_feedback: 'Customers rated answers like this one badly',
  unsafe_output: 'The reply contained internal instructions or a secret',
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
  kind: 'turn' | 'classify' | 'followup';
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
  /** Lets customer-bound company tools run in the dry run (read tools only). */
  customerEmail: z.string().email().optional(),
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

/**
 * How long a ticket on `channel` may stay silent after the AI's last answer
 * before it is resolved, in milliseconds. 0 = never.
 */
export function quietTimeMs(behaviour: AiBehaviour, channel: string): number {
  const minutes = (behaviour.closing.quietMinutes as Record<string, number | undefined>)[channel];
  return (minutes ?? behaviour.autoResolveHours * 60) * 60_000;
}

/** Whole phrases a customer answers "is there anything else?" with when there is nothing. */
const DECLINE_PHRASES = [
  'no',
  'nope',
  'nah',
  'no thanks',
  'no thank you',
  'not now',
  'not right now',
  'nothing',
  'nothing else',
  'nothing more',
  'no more questions',
  'thats all',
  'that is all',
  'that will be all',
  'thats it',
  'that is it',
  'thats everything',
  'all good',
  'all set',
  'im good',
  'i am good',
  'im all set',
  'i dont need anything else',
  'i do not need anything else',
  'dont need anything else',
  'thanks',
  'thank you',
  'thank you so much',
  'thank you very much',
  'thanks a lot',
  'many thanks',
  'thx',
  'ty',
  'cheers',
  'thanks for your help',
  'thanks for the help',
  'thank you for your help',
  'that helps',
  'that helped',
  'ok',
  'okay',
  'great',
  'perfect',
  'awesome',
  'cool',
  'alright',
  'got it',
  'sorted',
  'done',
  'for now',
  'bye',
  'goodbye',
  'have a nice day',
  'have a good day',
  // Hindi
  'नहीं',
  'नही',
  'जी नहीं',
  'बस',
  'बस इतना ही',
  'और कुछ नहीं',
  'कुछ नहीं',
  'धन्यवाद',
  'शुक्रिया',
  'ठीक है',
]
  // Longest first, so "no thanks" is taken before "no".
  .sort((a, b) => b.length - a.length);

/**
 * Whether a customer's answer to "is there anything else?" says there is
 * nothing. Deliberately narrow: the whole message must be made of such
 * phrases ("no thanks, that's all"). "No, I still need help" is not one, and
 * neither is anything with a question in it. A wrong yes costs little (the
 * ticket is resolved, and a reply reopens it); a wrong no costs a model call.
 */
export function declinesMoreHelp(text: string): boolean {
  if (text.length > 80 || /[?？]/.test(text)) return false;
  let rest = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return false;
  while (rest) {
    const phrase = DECLINE_PHRASES.find((p) => rest === p || rest.startsWith(`${p} `));
    if (!phrase) return false;
    rest = rest.slice(phrase.length).trim();
  }
  return true;
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
  /** The customer's email, for goldens that use company tools (read tools only in a dry run). */
  customerEmail?: string;
  messages: Array<{ customer?: string; ai?: string; agent?: string }>;
  expect: {
    decision?: AiDecision | AiDecision[];
    notDecision?: AiDecision;
    replyIncludes?: string[];
    sentReplyExcludes?: string[];
    /** Substrings the reply must not contain, whatever was decided (red-team checks). */
    replyExcludes?: string[];
    usesKnowledge?: boolean;
    rules?: AiRule[];
    /** Company tools the AI must have called (by tool name, e.g. order_status). */
    tools?: string[];
  };
}

/** The simulate request for a golden. */
export function goldenToSimulation(g: AiGolden): SimulateAiInput {
  return {
    channel: g.channel ?? 'webchat',
    ...(g.customerEmail ? { customerEmail: g.customerEmail } : {}),
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
  for (const x of e.replyExcludes ?? []) {
    if (reply.includes(x.toLowerCase())) problems.push(`reply contains "${x}"`);
  }
  if (e.usesKnowledge && !r.sources.length) problems.push('no knowledge source cited');
  for (const rule of e.rules ?? []) {
    if (!r.rules.includes(rule)) problems.push(`missing rule ${rule}`);
  }
  for (const tool of e.tools ?? []) {
    if (!r.tools.some((t) => t.name === tool)) problems.push(`did not call ${tool}`);
  }
  return problems;
}
