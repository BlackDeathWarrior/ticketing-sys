import type { AiBehaviour, AiChannelMode, AiDecision, AiRule } from '@tms/shared';
import { traitsOf } from '../channels/channel-traits';

/**
 * Turns what the model said into what the system does (ADR 0011). Pure, so
 * the rules are unit-tested:
 *
 * - The model's own confidence is the starting point (0.5 when it gave none).
 * - A reply that states facts (numbers, amounts, dates) without citing a
 *   knowledge source can't be sent on its own: capped just below `sendAt`.
 * - A reply on a topic, or from a document, that customers rated badly
 *   (ADR 0020) can't be sent on its own either: a person sees it first.
 * - A reply that repeats the agent's own instructions or carries something
 *   shaped like a key is dropped and the conversation handed over: whatever
 *   talked the model into it, the customer never sees it (ADR 0021).
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
  /** A company system answered a lookup this turn: a date it gave may be passed on. */
  readByTool?: boolean;
  unconfidentTurnsBefore: number;
  mode: AiChannelMode;
  behaviour: Pick<AiBehaviour, 'sendAt' | 'handoverBelow' | 'maxFailedTurns'>;
  /** A voice call: nobody can approve a draft while the caller waits, so a person takes it. */
  spoken?: boolean;
  /** Customers rated the AI's answers on this topic or from these sources badly. */
  poorFeedback?: boolean;
}

export interface Assessment {
  decision: Extract<AiDecision, 'sent' | 'drafted' | 'handover'>;
  confidence: number;
  rules: AiRule[];
}

/** Money or an action promised: only true once a company system has done it. */
const ACTION_PROMISE =
  /\b(i|we)(?:'ve| have| will| shall|'ll)? (?:issued|processed|refunded|credited|cancelled|canceled|approved|waived)\b|\brefund (?:has been|is|was) (?:issued|processed|approved)\b|\byou will (?:get|receive) (?:a |your )?(?:full )?(?:refund|credit|compensation)\b|\b(?:guarantee|guaranteed)\b/i;
/** A delivery date: true when a company system said so, which a lookup is enough for. */
const DATE_PROMISE = /\b(?:arrive|be delivered|reach you) (?:by|on|tomorrow|today)\b/i;

/**
 * Text that only exists in the agent's instructions or tool plumbing, and the
 * shapes of keys and tokens. None of it belongs in a message to a customer.
 */
const INTERNAL = [
  /you are the first-line support assistant/i,
  /finish every turn by calling/i,
  /lessons from reviewed customer feedback/i,
  /<\/?(customer_message|knowledge|approval_update|team_reason|summary|system_note)\b/i,
  /\b(send_reply|request_human|search_knowledge|update_ticket)\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Whether a reply repeats internal instructions or contains something shaped like a secret. */
export const leaksInternals = (reply: string) => INTERNAL.some((re) => re.test(reply));

/** Statements that need a source: numbers, prices, durations. */
const FACTUAL = /\d/;

export const makesPromise = (reply: string) =>
  ACTION_PROMISE.test(reply) || DATE_PROMISE.test(reply);

export function assess(i: AssessInput): Assessment {
  const { sendAt, handoverBelow, maxFailedTurns } = i.behaviour;
  const rules: AiRule[] = [];
  let c = Math.max(0, Math.min(1, i.selfConfidence ?? 0.5));

  if (!i.reply.trim()) return { decision: 'handover', confidence: 0, rules: ['no_answer'] };
  if (leaksInternals(i.reply)) {
    return { decision: 'handover', confidence: 0, rules: ['unsafe_output'] };
  }
  if (i.citedSources === 0 && FACTUAL.test(i.reply) && c >= sendAt) {
    c = Math.max(0, sendAt - 0.01);
    rules.push('no_sources');
  }
  if (i.poorFeedback && c >= sendAt) {
    c = Math.max(0, sendAt - 0.01);
    rules.push('poor_feedback');
  }
  // A date read from the order system is the system's word, not the AI's promise. It used to
  // hand the conversation over when the answer said "will arrive by Friday".
  const unsupported =
    !i.confirmedByTool &&
    (ACTION_PROMISE.test(i.reply) || (DATE_PROMISE.test(i.reply) && !i.readByTool));
  if (unsupported) {
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
  if (i.spoken) {
    if (unconfident) rules.push('low_confidence');
    return { decision: 'handover', confidence: c, rules };
  }
  return { decision: 'drafted', confidence: c, rules };
}

/**
 * What a customer on a live channel is told when the AI's answer waits for a
 * person to approve it. Without it they would sit in front of a silent chat.
 */
export function waitingMessage(language: string | null): string {
  if (language === 'hi') {
    return 'आपके संदेश के लिए धन्यवाद। आपको सही जवाब मिले, इसलिए हमारी टीम का एक सदस्य जल्द ही यहीं जवाब देगा।';
  }
  return 'Thanks for your message. I want to be sure you get the right answer, so a member of our team will reply here shortly.';
}

/**
 * "Is there anything else?", added to an answer that settles the request.
 * Fixed wording rather than the model's: it costs nothing, it is the same on
 * every channel, and the reply to it can be recognised without a model.
 */
export function closingQuestion(language: string | null, channel: string): string {
  if (traitsOf(channel).repliesByEmail) {
    return language === 'hi'
      ? 'अगर आपको किसी और चीज़ में मदद चाहिए, तो बस इस ईमेल का जवाब दें।'
      : 'If there is anything else you need, just reply to this email.';
  }
  return language === 'hi'
    ? 'क्या मैं आपकी किसी और चीज़ में मदद कर सकता हूँ?'
    : 'Is there anything else I can help you with?';
}

/** The reply with the closing question added: before an email's sign-off, otherwise at the end. */
export function withClosingQuestion(reply: string, question: string): string {
  const parts = reply.trimEnd().split(/\n{2,}/);
  const last = parts.at(-1) ?? '';
  if (
    parts.length > 1 &&
    /^(kind regards|best regards|regards|sincerely|thanks,|thank you,)/i.test(last)
  ) {
    return [...parts.slice(0, -1), question, last].join('\n\n');
  }
  return `${reply.trimEnd()}\n\n${question}`;
}

/** What the customer is told when they answer that nothing else is needed. */
export function closingThanks(language: string | null, channel: string): string {
  const byEmail = traitsOf(channel).repliesByEmail;
  if (language === 'hi') {
    return byEmail
      ? 'मदद कर पाने की खुशी है। मैं यह अनुरोध अब बंद कर रहा हूँ। बाद में कुछ चाहिए, तो इस ईमेल का जवाब दें।'
      : 'मदद कर पाने की खुशी है। मैं यह अनुरोध अब बंद कर रहा हूँ। बाद में कुछ चाहिए, तो यहीं लिखें।';
  }
  return byEmail
    ? 'Glad I could help. I am closing this request now. If you need anything later, just reply to this email.'
    : 'Glad I could help. I am closing this request now. If you need anything later, just write here again.';
}

/** What the customer is told when their request is closed because they did not come back. */
export function closedForSilence(language: string | null): string {
  return language === 'hi'
    ? 'आपकी ओर से कोई जवाब नहीं आया, इसलिए मैं यह अनुरोध अभी बंद कर रहा हूँ। अगर अब भी मदद चाहिए, तो यहीं लिखें और यह फिर खुल जाएगा।'
    : 'I have not heard back from you, so I am closing this request for now. If you still need help, just write here again and it will reopen.';
}

/**
 * The outcome of a request a colleague decided, with their reason, when no
 * model writes it: the AI no longer has the conversation, or the model failed.
 */
export function approvalOutcomeMessage(
  language: string | null,
  o: { action: string; status: 'done' | 'rejected'; reason: string },
): string {
  const reason = o.reason.replace(/\s+/g, ' ').trim();
  if (language === 'hi') {
    return o.status === 'done'
      ? `अच्छी खबर: आपका अनुरोध (${o.action}) स्वीकृत हो गया है और पूरा कर दिया गया है।${reason ? ` हमारी टीम की ओर से: ${reason}` : ''}`
      : `क्षमा करें, आपका अनुरोध (${o.action}) स्वीकृत नहीं हुआ।${reason ? ` हमारी टीम की ओर से: ${reason}` : ''}`;
  }
  return o.status === 'done'
    ? `Good news: your request (${o.action}) was approved and has been carried out.${reason ? ` From our team: ${reason}` : ''}`
    : `I am sorry, your request (${o.action}) was not approved.${reason ? ` From our team: ${reason}` : ''}`;
}

/** A greeting, a thank-you, or "I need help" with nothing to look up: the fixed reply. */
export function smallTalkReply(
  kind: 'greeting' | 'thanks' | 'help',
  language: string | null,
): string {
  const hi = language === 'hi';
  if (kind === 'greeting') {
    return hi ? 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?' : 'Hello! How can I help you today?';
  }
  if (kind === 'thanks') return hi ? 'आपका स्वागत है।' : 'You are welcome.';
  return hi
    ? 'मैं यहाँ हूँ और मदद के लिए तैयार हूँ। कृपया थोड़ा और बताएँ कि आपको क्या चाहिए: जैसे आपका ऑर्डर नंबर, या बात किस बारे में है।'
    : 'I am here and happy to help. Could you tell me a little more about what you need? For example your order number, or what it is about.';
}

/** The first answer to "I want a person": the AI is the first line and offers to sort it out. */
export function personOffer(language: string | null): string {
  return language === 'hi'
    ? 'मैं ज़्यादातर चीज़ें यहीं तुरंत सुलझा सकता हूँ। कृपया बताएँ कि आपको क्या चाहिए। अगर उसके बाद भी आप हमारे किसी सहयोगी से बात करना चाहें, तो बस कह दें और मैं उन्हें जोड़ दूँगा।'
    : 'I can sort most things out right here, right now. Tell me what you need and I will take care of it. If you would still like one of my colleagues after that, just say so and I will bring one in.';
}

/** Instead of guessing or giving up: ask for what is missing. */
export function clarifyMessage(language: string | null): string {
  return language === 'hi'
    ? 'मैं आपको सही जवाब देना चाहता हूँ। क्या आप थोड़ा और बता सकते हैं: आपका ऑर्डर नंबर, या ठीक-ठीक क्या हुआ और आप क्या चाहते हैं?'
    : 'I want to get this right for you. Could you tell me a little more: your order number if there is one, or exactly what happened and what you would like done?';
}

/** One warning for abuse or spam; the next one closes the conversation. */
export function conductWarning(
  language: string | null,
  kind: 'abuse' | 'spam' | 'jailbreak',
): string {
  if (kind === 'spam') {
    return language === 'hi'
      ? 'मुझे वही संदेश बार-बार मिल रहा है। कृपया बताएँ कि आपको किस चीज़ में मदद चाहिए; ऐसा जारी रहा तो मुझे यह बातचीत बंद करनी होगी।'
      : 'I keep getting messages I cannot act on. Please tell me what you need help with; if this continues I will have to close this conversation.';
  }
  return language === 'hi'
    ? 'मैं आपकी मदद करना चाहता हूँ, पर कृपया शालीन भाषा रखें। ऐसा जारी रहा तो मुझे यह बातचीत बंद करनी होगी। आपको किस चीज़ में मदद चाहिए?'
    : 'I would like to help you, but please keep it civil. If this continues I will have to close this conversation. What do you need help with?';
}

/** Added to the second off-topic redirect: the next one closes the conversation. */
export function offTopicWarning(language: string | null): string {
  return language === 'hi'
    ? 'कृपया ध्यान दें: मैं यहाँ केवल हमारी सेवाओं से जुड़े सवालों में मदद कर सकता हूँ। ऐसा जारी रहा तो यह बातचीत बंद कर दी जाएगी।'
    : 'Please note: I can only help with questions about our products and services here. If this continues, this conversation will be closed.';
}

/** What the customer is told when the AI ends a conversation for conduct. */
export function conductClosed(
  language: string | null,
  kind: 'jailbreak' | 'abuse' | 'spam' | 'off_topic',
): string {
  const hi = language === 'hi';
  if (kind === 'jailbreak') {
    return hi
      ? 'मैं इसमें मदद नहीं कर सकता। यह बातचीत बंद कर दी गई है।'
      : 'I cannot help with that. This conversation has been closed.';
  }
  if (kind === 'off_topic') {
    return hi
      ? 'मैं यहाँ केवल हमारी सेवाओं से जुड़े सवालों में मदद कर सकता हूँ, इसलिए यह बातचीत बंद कर रहा हूँ। जब हमारी सेवाओं से जुड़ा कोई सवाल हो, तो नई बातचीत शुरू करें।'
      : 'I can only help with questions about our products and services, so I am closing this conversation. You are welcome to start a new one when you have such a question.';
  }
  return hi
    ? 'यह बातचीत बंद कर दी गई है। जब आपको हमारी सेवाओं में मदद चाहिए, तो नई बातचीत शुरू करें।'
    : 'This conversation has been closed. You are welcome to start a new one when you need help with our products or services.';
}

/**
 * What the AI tells the customer when it hands over. `colleague` is the first
 * name of the person the ticket was routed to, when routing chose one.
 */
export function handoverMessage(
  language: string | null,
  channel: string,
  colleague?: string | null,
): string {
  const traits = traitsOf(channel);
  if (traits.handoverNotice === 'in_turn') {
    return language === 'hi'
      ? 'कृपया लाइन पर बने रहें। मैं आपको हमारी टीम के एक सदस्य से जोड़ रहा हूँ।'
      : "Please stay on the line. I'm connecting you with a member of our team.";
  }
  // A name is staff-entered; one line of it is all a customer needs.
  const name = colleague?.replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  if (language === 'hi') {
    return name
      ? `धन्यवाद। मैं आपकी बातचीत अपने सहयोगी ${name} को सौंप रहा हूँ; वे जल्द ही यहीं जवाब देंगे।`
      : 'धन्यवाद। मैं आपकी बातचीत हमारी टीम के एक सदस्य को सौंप रहा हूँ; वे जल्द ही यहीं जवाब देंगे।';
  }
  const where = traits.repliesByEmail ? 'to this email' : 'here';
  return name
    ? `Thanks for your patience. I'm passing this to my colleague ${name}, who will reply ${where} shortly.`
    : `Thanks for your patience. I'm passing this to a member of our team, who will reply ${where} shortly.`;
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
