import type { AiBehaviour, AiChannelMode, AiDecision, AiRule } from '@tms/shared';

/**
 * Turns what the model said into what the system does (ADR 0011). Pure, so
 * the rules are unit-tested:
 *
 * - The model's own confidence is the starting point (0.5 when it gave none).
 * - A reply that states facts (numbers, amounts, dates) without citing a
 *   knowledge source can't be sent on its own: capped just below `sendAt`.
 * - A reply that promises money or dates no tool confirmed is capped below
 *   `handoverBelow`, which hands the conversation over.
 * - Below `handoverBelow`: hand over. Too many unconfident turns in one
 *   conversation: hand over.
 * - At or above `sendAt` on an `auto` channel: send. Otherwise: draft.
 */
export interface AssessInput {
  selfConfidence: number | null;
  reply: string;
  citedSources: number;
  confirmedByTool: boolean;
  unconfidentTurnsBefore: number;
  mode: AiChannelMode;
  behaviour: Pick<AiBehaviour, 'sendAt' | 'handoverBelow' | 'maxFailedTurns'>;
}

export interface Assessment {
  decision: Extract<AiDecision, 'sent' | 'drafted' | 'handover'>;
  confidence: number;
  rules: AiRule[];
}

const PROMISE =
  /\b(i|we)(?:'ve| have| will| shall|'ll)? (?:issued|processed|refunded|credited|cancelled|canceled|approved|waived)\b|\brefund (?:has been|is|was) (?:issued|processed|approved)\b|\byou will (?:get|receive) (?:a |your )?(?:full )?(?:refund|credit|compensation)\b|\b(?:guarantee|guaranteed)\b|\b(?:arrive|be delivered|reach you) (?:by|on|tomorrow|today)\b/i;

/** Statements that need a source: numbers, prices, durations. */
const FACTUAL = /\d/;

export const makesPromise = (reply: string) => PROMISE.test(reply);

export function assess(i: AssessInput): Assessment {
  const { sendAt, handoverBelow, maxFailedTurns } = i.behaviour;
  const rules: AiRule[] = [];
  let c = Math.max(0, Math.min(1, i.selfConfidence ?? 0.5));

  if (!i.reply.trim()) return { decision: 'handover', confidence: 0, rules: ['no_answer'] };
  if (i.citedSources === 0 && FACTUAL.test(i.reply) && c >= sendAt) {
    c = Math.max(0, sendAt - 0.01);
    rules.push('no_sources');
  }
  if (makesPromise(i.reply) && !i.confirmedByTool) {
    c = Math.min(c, Math.max(0, handoverBelow - 0.01));
    rules.push('unsupported_promise');
  }
  c = Math.round(c * 100) / 100;

  if (c < handoverBelow) {
    rules.push('low_confidence');
    return { decision: 'handover', confidence: c, rules };
  }
  const unconfident = c < sendAt;
  if (unconfident && i.unconfidentTurnsBefore + 1 >= maxFailedTurns) {
    rules.push('repeated_failures');
    return { decision: 'handover', confidence: c, rules };
  }
  if (i.mode === 'auto' && !unconfident) return { decision: 'sent', confidence: c, rules };
  if (!unconfident) rules.push('draft_channel');
  return { decision: 'drafted', confidence: c, rules };
}

/** What the AI tells a live customer when it hands over. */
export function handoverMessage(language: string | null): string {
  if (language === 'hi') {
    return 'धन्यवाद। मैं आपकी बातचीत हमारी टीम के एक सदस्य को सौंप रहा हूँ; वे जल्द ही यहीं जवाब देंगे।';
  }
  return "Thanks for your patience. I'm passing this to a member of our team, who will reply here shortly.";
}

/** The internal note left for the humans taking over. */
export function handoverNote(input: {
  reasons: string[];
  lastCustomerMessage: string | null;
  aiReplies: number;
  sources: string[];
  draft: string | null;
}): string {
  const quote = input.lastCustomerMessage
    ? input.lastCustomerMessage.replace(/\s+/g, ' ').slice(0, 200)
    : null;
  const lines = [
    `AI handed over ${input.aiReplies === 0 ? 'without replying' : `after ${input.aiReplies} ${input.aiReplies === 1 ? 'reply' : 'replies'}`}: ${input.reasons.join('; ')}.`,
    quote ? `Last customer message: “${quote}”` : null,
    input.sources.length ? `Knowledge it looked at: ${input.sources.join(', ')}.` : null,
    input.draft
      ? `Its unsent answer was: “${input.draft.replace(/\s+/g, ' ').slice(0, 300)}”`
      : null,
  ];
  return lines.filter(Boolean).join('\n');
}
