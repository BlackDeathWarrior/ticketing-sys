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
    /**
     * Answers that need no model: a greeting, a question an FAQ entry answers
     * word for word, a question answered a moment ago. Each can be switched off.
     */
    fastPaths: z
      .object({
        /** Greetings, thanks and "are you there?" get a fixed reply. */
        smallTalk: z.boolean().default(true),
        /** A question that matches an approved FAQ entry closely gets that entry's answer. */
        faq: z.boolean().default(true),
        /** How close (0.5 to 1) the question must be to the FAQ entry's own question. */
        faqMinSimilarity: z.number().min(0.5).max(1).default(0.85),
        /** A first question asked in the same words again gets the answer the AI gave before. */
        answerCache: z.boolean().default(true),
        answerCacheHours: z.number().int().min(1).max(720).default(24),
      })
      .default({}),
    /**
     * What the AI does about misuse, before any model is asked: attempts to
     * override its instructions, abuse, spam, and questions that have nothing
     * to do with the company.
     */
    guardrails: z
      .object({
        enabled: z.boolean().default(true),
        /** An attempt to override the AI's instructions closes the ticket at once and flags the customer. */
        closeOnJailbreak: z.boolean().default(true),
        /** Off-topic messages in one conversation before it is closed: a redirect, a warning, then closed. */
        offTopicLimit: z.number().int().min(2).max(10).default(3),
        /** Abusive or spam messages in one conversation before it is closed: a warning, then closed. */
        abuseLimit: z.number().int().min(1).max(10).default(2),
        /** Hours a customer's flag keeps the AI strict: any further offence closes with no warning. */
        flagHours: z.number().int().min(1).max(720).default(24),
      })
      .default({}),
    /** When a person is brought in. The AI is the first line: it tries to solve things itself. */
    handover: z
      .object({
        /**
         * Times a customer must ask for a person before one is brought in. At
         * 2, the first request gets an offer to sort it out now; the second
         * is handed over. 1 hands over at once. A phone call always does.
         */
        personRequestsBeforeHandover: z.number().int().min(1).max(5).default(2),
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

/** `closed`: the AI ended the conversation for misuse (a jailbreak attempt, abuse, spam, off-topic). */
export const AI_DECISIONS = ['sent', 'drafted', 'handover', 'skipped', 'error', 'closed'] as const;
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
  'jailbreak_attempt',
  'abusive_language',
  'spam',
  'off_topic',
  'repeat_offender',
  'person_offered',
  'clarifying',
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
  jailbreak_attempt: "The customer tried to override the AI's instructions",
  abusive_language: 'Abusive language',
  spam: 'Spam or repeated messages',
  off_topic: 'Nothing to do with the company',
  repeat_offender: 'The customer was flagged for misuse recently',
  person_offered: 'Offered to solve it before bringing in a person',
  clarifying: 'Asked the customer to say more instead of guessing',
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

/**
 * A request for a person, in English and Hindi. It has to be a request:
 * "the delivery agent was rude" or "is the manager's special still on" only
 * mention one, and used to hand the conversation over all the same.
 */
export function asksForHuman(text: string): boolean {
  const who =
    '(?:a |an |the |some |any |your |one of your )?(?:real |live |actual |human )?(?:human|person|people|agent|representative|rep|operator|manager|supervisor|someone|somebody|colleague|staff|team member)';
  const en = new RegExp(
    [
      // "talk to a person", "speak with an agent", "connect me to someone"
      `\\b(?:talk|speak|chat|connect(?: me)?|put me through|transfer(?: me)?|escalate(?: this| me)?|get me|give me)\\b[^.?!]{0,20}\\b(?:to|with)?\\s*${who}\\b`,
      // "I want a human", "need a real person", "can I get an agent"
      `\\b(?:want|need|get|have|like|prefer|require|request)\\b[^.?!]{0,6}${who}\\b`,
      // "real person please", "human please", "live agent"
      '\\b(?:real person|real human|live agent|live person|human being|human agent)\\b',
      '^\\s*(?:human|agent|person|representative|operator)\\s*(?:please|pls|now)?\\s*[.!]*\\s*$',
      // "not a bot", "no more bots"
      '\\b(?:not|no)\\b[^.?!]{0,10}\\b(?:bots?|robots?|chatbots?)\\b',
    ].join('|'),
    'i',
  );
  return en.test(text) || /इंसान से|किसी व्यक्ति से|एजेंट से बात|किसी से बात|असली इंसान/.test(text);
}

const GREETING_WORDS =
  /\b(hi+|hello+|hey+|hiya|howdy|namaste|good (?:morning|afternoon|evening|day)|greetings|there)\b|नमस्ते|नमस्कार/giu;
const THANKS_WORDS =
  /\b(thanks?|thank you|thx|ty|cheers|much appreciated|appreciate it|great|perfect|awesome|ok(?:ay)?|cool|nice|so much|very much|a lot)\b|धन्यवाद|शुक्रिया/giu;
const PRESENCE =
  /^(?:can|could) (?:you|anyone|anybody) hear me\b|^(?:is|are) (?:you|anyone|anybody|someone) (?:there|here)\b|^anyone there\b|^anybody there\b/i;
const HELP_WORDS =
  /\b(i|we|me|please|pls|can|could|you|some|need|want|help|assist|assistance|support|answer|reply|respond|question|query|a|have|got|with|something)\b/giu;

/**
 * A message with nothing in it to look up: a greeting, a thank-you, "are you
 * there?", "I need help". Whole message only: "Hi, where is my order?" is a
 * question. Such a message gets a fixed reply and no model is asked.
 */
export function smallTalk(text: string): 'greeting' | 'thanks' | 'help' | null {
  const q = text.trim();
  if (!q || q.length > 80) return null;
  /** The message has such words in it and, without them, no letter or digit is left. */
  const madeOf = (words: RegExp) => {
    const left = q.replace(words, ' ');
    return left !== q && left.replace(/[^\p{L}\p{M}\p{N}]+/gu, '') === '';
  };
  if (q.length < 40 && PRESENCE.test(q)) return 'greeting';
  if (madeOf(GREETING_WORDS)) return 'greeting';
  if (!/[?？]/.test(q) && madeOf(THANKS_WORDS)) return 'thanks';
  if (/\b(help|assist|assistance|support|question|query)\b/i.test(q) && madeOf(HELP_WORDS))
    return 'help';
  return null;
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
