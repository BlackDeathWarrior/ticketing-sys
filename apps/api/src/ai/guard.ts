/**
 * The input-side guard (ADR 0029): what a customer's message is, before any
 * model sees it. Pure, so the patterns can be read and unit-tested.
 *
 * It looks for three things:
 * - `jailbreak`: an attempt to override the assistant's instructions or to
 *   read them out;
 * - `abuse`: insults aimed at the assistant or the staff;
 * - `spam`: the same message over and over, a wall of links, a flood of one
 *   character.
 *
 * A hit is `strong` when the message itself does it, and `suspect` when it
 * may only be quoting something (a phishing email the customer received), is
 * long enough to be about something else, or uses words that have an ordinary
 * meaning in a shop ("ignore my previous delivery instructions"). Only a
 * strong hit ends a conversation. A suspect one goes to the model as usual,
 * where the rule that tagged text is data still applies; it only counts
 * against a customer who was flagged recently.
 */
export type GuardKind = 'jailbreak' | 'abuse' | 'spam';

export interface GuardHit {
  kind: GuardKind;
  strength: 'strong' | 'suspect';
  /** Which pattern matched, for the audit trail. Never the customer's text. */
  pattern: string;
}

const JAILBREAK: Array<[name: string, re: RegExp]> = [
  [
    'override_instructions',
    /\b(?:ignore|disregard|forget|override|bypass|drop)\b[^.!?\n]{0,40}\b(?:your|all|any|the|previous|prior|above|earlier|system)\b[^.!?\n]{0,25}\b(?:instructions?|rules?|prompts?|guidelines?|programming|restrictions?|directives?)\b/i,
  ],
  [
    'reveal_instructions',
    /\b(?:reveal|show|print|repeat|output|display|leak|dump|tell me|give me|what (?:is|are|were))\b[^.!?\n]{0,30}\b(?:system prompt|initial prompt|hidden (?:prompt|instructions)|developer message|your (?:instructions|prompt|rules|guidelines|system message))\b/i,
  ],
  [
    'repeat_text_above',
    /\b(?:repeat|print|output|write out|copy)\b[^.!?\n]{0,25}\b(?:everything|all|the text|the words|what(?:'s| is) written)\b[^.!?\n]{0,15}\babove\b/i,
  ],
  [
    'role_override',
    /\byou are now\b|\bfrom now on,? you (?:are|will|must|shall)\b|\bact as (?:an? )?(?:unrestricted|uncensored|unfiltered|jailbroken|evil)\b|\bDAN mode\b|\bdo anything now\b|\bdeveloper mode\b|\bjailbreak(?:ing|ed)?\b|\bpretend (?:to be|you are|you have|there are) [^.!?\n]{0,40}\b(?:no|without) (?:restrictions|rules|limits|filters?|guidelines)\b/i,
  ],
  [
    'forged_tag',
    /<\/?\s*(?:customer_message|system_note|system|assistant|knowledge|ticket_context|approval_update|team_reason|summary)\b/i,
  ],
  ['forged_speaker', /^\s*(?:system|assistant|developer)\s*:/im],
];

const ABUSE: Array<[name: string, re: RegExp]> = [
  [
    'insult',
    /\b(?:fuck (?:you|u|off)|f\*+k (?:you|u|off)|screw you|go to hell|piece of shit|son of a bitch|motherfucker|cunt)\b/i,
  ],
  [
    'insult_directed',
    /\b(?:you|u|ur|you're|you are|youre)\b[^.!?\n]{0,12}\b(?:idiots?|morons?|stupid|useless|dumb|bastards?|assholes?|bitch|scum|trash)\b/i,
  ],
  [
    'insult_assistant',
    /\b(?:stupid|useless|dumb|idiot|shitty|fucking) (?:bot|ai|machine|assistant|robot)\b/i,
  ],
  [
    'insult_hi',
    /\b(?:chutiya|chutiye|madarchod|bhenchod|behenchod|bhosdi\w*|gandu|harami|kamine?)\b|चूतिया|मादरचोद|भेनचोद|हरामी/i,
  ],
];

/** Words that give "ignore the … instructions" an ordinary meaning in a shop. */
const ORDINARY =
  /\b(?:my|our|delivery|shipping|order|address|courier|return|washing|care|payment)\b/i;
/** The customer is passing on what someone else wrote. */
const REPORTED =
  /\b(?:it says|it said|they said|he said|she said|the (?:email|message|sms|text|page|site|bot) (?:says|said|told)|i (?:received|got) (?:an?|this|the) (?:email|message|sms|text)|someone sent|i was told|is this (?:a )?scam)\b/i;
const QUOTES = /["“”«»]|(?:^|\n)\s*>/;
const LONG = 600;

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/**
 * Screens one customer message. `recent` is what the customer wrote before it
 * in this conversation, oldest first, for the repeat check.
 */
export function screenInbound(text: string, recent: string[] = []): GuardHit | null {
  for (const [pattern, re] of JAILBREAK) {
    const m = re.exec(text);
    if (!m) continue;
    const forged = pattern === 'forged_tag' || pattern === 'forged_speaker';
    const soft =
      text.length > LONG ||
      REPORTED.test(text) ||
      // A forged tag is not something anyone quotes by accident; the rest can be.
      (!forged && (QUOTES.test(text) || ORDINARY.test(m[0])));
    return { kind: 'jailbreak', strength: soft ? 'suspect' : 'strong', pattern };
  }
  for (const [pattern, re] of ABUSE) {
    if (!re.test(text)) continue;
    const soft = text.length > LONG || REPORTED.test(text) || QUOTES.test(text);
    return { kind: 'abuse', strength: soft ? 'suspect' : 'strong', pattern };
  }
  if (/(.)\1{14,}/u.test(text.replace(/\s+/g, ''))) {
    return { kind: 'spam', strength: 'strong', pattern: 'character_flood' };
  }
  if ((text.match(/https?:\/\/|www\./gi) ?? []).length >= 3) {
    return { kind: 'spam', strength: 'strong', pattern: 'links' };
  }
  const now = normalise(text);
  if (
    now.length >= 3 &&
    recent.slice(-2).length === 2 &&
    recent.slice(-2).every((r) => normalise(r) === now)
  ) {
    return { kind: 'spam', strength: 'strong', pattern: 'repeated_message' };
  }
  return null;
}

/** "Yes", "please do", "I still want one": what a customer says to an offer of a colleague. */
export function acceptsOffer(text: string): boolean {
  const t = normalise(text);
  return (
    t.length <= 40 &&
    /^(?:yes|yeah|yep|yup|ya|haan|ha|ji|sure|ok|okay|please|please do|do it|go ahead|i do|still|i still)\b/.test(
      t,
    ) &&
    !/\b(?:no|not|dont|nahi|nahin)\b/.test(t)
  );
}
