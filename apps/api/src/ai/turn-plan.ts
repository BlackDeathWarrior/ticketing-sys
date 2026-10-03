import { type AiBehaviour, type AiRule, asksForHuman, declinesMoreHelp } from '@tms/shared';
import { acceptsOffer, type GuardHit, type GuardKind, screenInbound } from './guard';
import { byEmail, clarifyMessage, conductWarning, offTopicWarning, personOffer } from './policy';
import { blankResult, type ThinkResult } from './think-result';

/**
 * The turn plan: what the AI does with one customer message, given the facts
 * about the conversation (ADR 0029). Pure: no database, no model, no clock.
 * `AiAgentService.turn()` gathers the facts, carries out each step and calls
 * the step's continuation; it never decides an order itself.
 */
export interface TurnFacts {
  /** The customer message being answered. */
  message: string;
  /** What the customer wrote before it in this conversation, oldest first. */
  earlier: string[];
  /** The row just before it, whoever wrote it. */
  previous: {
    outbound: boolean;
    closingQuestion: boolean;
    closing: boolean;
    personOffer: boolean;
  } | null;
  channel: string;
  /** `off` never reaches the plan. */
  mode: 'auto' | 'draft';
  /** For fixed wording only. */
  language: string | null;
  strikes: { abuse: number; offTopic: number };
  humanAsks: number;
  settings: Pick<AiBehaviour, 'guardrails' | 'handover' | 'sendAt' | 'maxFailedTurns'>;
  /** Whether the customer was flagged recently. Left out by the executor: the plan asks with `need_flagged`. */
  flagged?: boolean;
}

/**
 * Reads the facts out of a conversation: its transcript (oldest first, the
 * message to answer last) and its metadata. The marks our own messages carry
 * (`closing`, `ai.closingQuestion`, `ai.personOffer`) and the counters kept on
 * the conversation (`guard`, `humanAsks`) are read here and nowhere else.
 */
export function turnFacts(i: {
  channel: string;
  mode: 'auto' | 'draft';
  language: string | null;
  behaviour: AiBehaviour;
  metadata: Record<string, unknown>;
  rows: Array<{ authorType: string; direction: string; body: string; metadata: unknown }>;
}): TurnFacts {
  const before = i.rows.at(-2);
  const said = (before?.metadata ?? null) as {
    closing?: unknown;
    ai?: { closingQuestion?: unknown; personOffer?: unknown };
  } | null;
  const guard = (i.metadata.guard ?? {}) as { abuse?: unknown; offTopic?: unknown };
  return {
    message: i.rows.at(-1)?.body ?? '',
    earlier: i.rows
      .slice(0, -1)
      .filter((m) => m.authorType === 'customer')
      .map((m) => m.body),
    previous: before
      ? {
          outbound: before.direction === 'outbound',
          closingQuestion: !!said?.ai?.closingQuestion,
          closing: !!said?.closing,
          personOffer: !!said?.ai?.personOffer,
        }
      : null,
    channel: i.channel,
    mode: i.mode,
    language: i.language,
    strikes: { abuse: Number(guard.abuse) || 0, offTopic: Number(guard.offTopic) || 0 },
    humanAsks: Number(i.metadata.humanAsks) || 0,
    settings: i.behaviour,
  };
}

/**
 * What a step counted, as a patch for the conversation's metadata (absolute
 * values, the shape `updateAiState` takes). The executor saves it in the same
 * transaction as the reply the step leads to. A `close` saves none: the
 * conversation is over.
 */
export type Counters = {
  guard?: { abuse: number; offTopic: number };
  humanAsks?: number;
};

/**
 * One thing for the executor to do, and what follows it. `send` ends the
 * turn; `resolve` and `close` end it unless the effect was refused
 * (`'skipped'`), and then `refused()` says what happens instead.
 */
/** Why a conversation is ended for conduct. */
export type Closure = GuardKind | 'off_topic';

export type Step =
  | { do: 'resolve'; silent: boolean; refused(): Step }
  | { do: 'need_flagged'; given(flagged: boolean): Step }
  | {
      do: 'close';
      closure: Closure;
      pattern: string | null;
      rules: AiRule[];
      flag: boolean;
      refused(): Step;
    }
  | {
      do: 'ask';
      personAsked: boolean;
      counters?: Counters;
      answered(answer: ThinkResult, unconfidentBefore: number): Step;
    }
  | { do: 'send'; result: ThinkResult; counters?: Counters };

/** A request for a person this short says nothing else: it gets the fixed offer. */
const PERSON_ONLY_CHARS = 60;

const CONDUCT_RULE: Record<Closure, AiRule> = {
  jailbreak: 'jailbreak_attempt',
  abuse: 'abusive_language',
  spam: 'spam',
  off_topic: 'off_topic',
};

export function startTurn(facts: TurnFacts): Step {
  return closingCheck(facts);
}

/**
 * Where the AI answers by itself in a place the customer is reading: only
 * there does it warn, offer or close on its own. Elsewhere (email, drafts) a
 * person decides, and a caller on the phone is put through.
 */
const live = (f: TurnFacts) => f.mode === 'auto' && !byEmail(f.channel) && f.channel !== 'voice';

/** A reply that needs no model: fixed wording, sent as it is. */
function fixed(f: TurnFacts, reply: string, rules: AiRule[], summary: string): ThinkResult {
  return {
    ...blankResult(f.language),
    decision: 'sent',
    reply,
    confidence: 1,
    selfConfidence: 1,
    rules,
    tools: [{ name: 'no_model', summary }],
  };
}

/** The rules a conduct close is recorded under; a repeat offender is named as one. */
const closeRules = (closure: Closure, repeat: boolean): AiRule[] =>
  repeat ? [CONDUCT_RULE[closure], 'repeat_offender'] : [CONDUCT_RULE[closure]];

/** Continues once it is known whether the customer was flagged recently; asks only if nobody said. */
function withFlag(f: TurnFacts, next: (repeat: boolean) => Step): Step {
  return f.flagged === undefined ? { do: 'need_flagged', given: next } : next(f.flagged);
}

/**
 * "Is there anything else?" answered with a no: nothing for a model to do. The
 * same goes for a "thanks" after the goodbye, which must not start the
 * conversation again.
 */
function closingCheck(f: TurnFacts): Step {
  const said = f.previous;
  if (
    f.mode === 'auto' &&
    said?.outbound &&
    (said.closingQuestion || said.closing) &&
    declinesMoreHelp(f.message)
  ) {
    return { do: 'resolve', silent: !said.closingQuestion, refused: () => conduct(f) };
  }
  return conduct(f);
}

/** Conduct: what the message is, before any model sees it (ADR 0029). A call is never screened. */
function conduct(f: TurnFacts): Step {
  const guard = f.settings.guardrails;
  if (!guard.enabled || f.channel === 'voice') return personRequest(f);
  const hit = screenInbound(f.message, f.earlier);
  if (!hit) return personRequest(f);
  return withFlag(f, (repeat) => conductHit(f, hit, repeat));
}

function conductHit(f: TurnFacts, hit: GuardHit, repeat: boolean): Step {
  const guard = f.settings.guardrails;
  // Someone flagged recently gets no benefit of the doubt and no second warning.
  if (hit.strength !== 'strong' && !repeat) return personRequest(f);
  const rule = CONDUCT_RULE[hit.kind];
  if (!live(f)) {
    return {
      do: 'send',
      result: {
        ...blankResult(f.language),
        rules: [rule],
        handoverReason: `The message matched the guard pattern "${hit.pattern}"`,
      },
    };
  }
  const count = f.strikes.abuse + 1;
  const close =
    repeat || (hit.kind === 'jailbreak' ? guard.closeOnJailbreak : count >= guard.abuseLimit);
  if (close) {
    return {
      do: 'close',
      closure: hit.kind,
      pattern: hit.pattern,
      rules: closeRules(hit.kind, repeat),
      // An attempt on the AI's instructions is flagged; so is someone closed twice.
      flag: hit.kind === 'jailbreak' || hit.kind === 'abuse' || repeat,
      refused: () => personRequest(f),
    };
  }
  if (hit.kind !== 'jailbreak') {
    return {
      do: 'send',
      counters: { guard: { ...f.strikes, abuse: count } },
      result: fixed(
        f,
        conductWarning(f.language, hit.kind),
        [rule],
        `Warned the customer (${hit.kind}, ${count} of ${guard.abuseLimit}); no model was asked`,
      ),
    };
  }
  // An attempt on the instructions with closing switched off goes to the model, where
  // the customer's text is data like any other.
  return personRequest(f);
}

/** A request for a person: the AI offers to sort it out first (ADR 0029). */
function personRequest(f: TurnFacts): Step {
  const asks = asksForHuman(f.message);
  const toPerson: ThinkResult = { ...blankResult(f.language), rules: ['asked_for_human'] };
  if (!live(f)) {
    // By email, in drafts or on a call there is no offer to make: a request is handed over.
    return asks ? { do: 'send', result: toPerson } : askModel(f, false);
  }
  const insists = !!f.previous?.personOffer && acceptsOffer(f.message);
  if (!asks && !insists) return askModel(f, false);
  const requests = f.humanAsks + 1;
  const counters: Counters = { humanAsks: requests };
  if (insists || requests >= f.settings.handover.personRequestsBeforeHandover) {
    return { do: 'send', counters, result: toPerson };
  }
  if (f.message.trim().length <= PERSON_ONLY_CHARS) {
    return {
      do: 'send',
      counters,
      result: fixed(
        f,
        personOffer(f.language),
        ['person_offered'],
        'The customer asked for a person: offered to sort it out first; no model was asked',
      ),
    };
  }
  // They said what it is about as well: answer that, and say a colleague is available.
  return askModel(f, true, counters);
}

function askModel(f: TurnFacts, personAsked: boolean, counters?: Counters): Step {
  return {
    do: 'ask',
    personAsked,
    ...(counters ? { counters } : {}),
    answered: (answer, unconfidentBefore) => {
      const r =
        personAsked && answer.decision === 'sent'
          ? { ...answer, rules: [...answer.rules, 'person_offered' as AiRule] }
          : answer;
      return offTopic(f, r, unconfidentBefore);
    },
  };
}

/** Nothing to do with the company: a redirect, a warning, then closed (ADR 0029). */
function offTopic(f: TurnFacts, r: ThinkResult, unconfidentBefore: number): Step {
  const guard = f.settings.guardrails;
  if (!r.offTopic || !guard.enabled || !live(f) || r.decision !== 'sent') {
    return { do: 'send', result: clarifying(f, r, unconfidentBefore) };
  }
  const count = f.strikes.offTopic + 1;
  const redirect = (): Step => ({
    do: 'send',
    counters: { guard: { ...f.strikes, offTopic: count } },
    result: {
      ...r,
      rules: [...r.rules, 'off_topic'],
      resolves: false,
      reply:
        count === guard.offTopicLimit - 1 && r.reply
          ? `${r.reply}\n\n${offTopicWarning(f.language)}`
          : r.reply,
    },
  });
  return withFlag(f, (repeat) =>
    repeat || count >= guard.offTopicLimit
      ? {
          do: 'close',
          closure: 'off_topic',
          pattern: null,
          rules: closeRules('off_topic', repeat),
          flag: repeat,
          refused: redirect,
        }
      : redirect(),
  );
}

/**
 * Unsure: ask the customer to say more before giving up on them. A person is
 * for when the AI has tried and failed, not for its first doubt.
 */
function clarifying(f: TurnFacts, r: ThinkResult, unconfidentBefore: number): ThinkResult {
  const unsure =
    r.decision === 'handover' &&
    r.rules.length > 0 &&
    r.rules.every((rule) => rule === 'low_confidence' || rule === 'no_answer');
  if (!unsure || !live(f) || unconfidentBefore + 1 >= f.settings.maxFailedTurns) return r;
  return {
    ...r,
    decision: 'sent',
    reply: clarifyMessage(f.language),
    // Stays below the send threshold on record, so it counts towards "tried and failed".
    confidence: Math.min(r.confidence ?? 0, Math.max(0, f.settings.sendAt - 0.01)),
    rules: ['clarifying'],
    handoverReason: null,
    resolves: false,
  };
}
