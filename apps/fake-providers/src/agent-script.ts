import type { ChatMessage, ChatRequest, ScriptedReply } from './llm';

/**
 * Scripted behaviour for the TMS AI agent, classifier and summarizer, so
 * demos and tests run without a real model. Deterministic by design:
 *
 * - Agent: first calls search_knowledge with the customer's words; then
 *   replies from the top result. Confidence is 0.9 when the result shares at
 *   least two meaningful words with the question, 0.7 when it shares fewer
 *   (the agent drafts), and 0.3 when nothing was found (it hands over).
 *   Asking for a person calls request_human.
 * - Classifier: picks the category whose words best match the ticket.
 * - Summarizer: the first sentence of each customer message.
 */

const STOP = new Set(
  'a an and are as at be by can could do does for from get got have how i if in is it its me my of on or our please so that the their them then there these they this to was we what when where which who why will with would you your hello hi thanks thank'.split(
    ' ',
  ),
);

export function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      .normalize('NFKC')
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w))
      // Crude plural folding: "cards" and "card" count as the same word.
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  );
}

const textOf = (m: ChatMessage | undefined) =>
  typeof m?.content === 'string'
    ? m.content
    : (m?.content ?? []).map((p) => p.text ?? '').join(' ');

const stripTags = (s: string) => s.replace(/<\/?[a-z_]+[^>]*>/gi, '').trim();

const isHindi = (s: string) => /[ऀ-ॿ]/.test(s);

function firstSentences(text: string, n: number): string {
  const clean = text.replace(/^…|…$/g, '').replace(/\s+/g, ' ').trim();
  const parts = clean.match(/[^.!?।]+[.!?।]+/g) ?? [clean];
  return parts.slice(0, n).join(' ').trim();
}

function call(name: string, args: Record<string, unknown>): ScriptedReply {
  return { content: null, toolCalls: [{ name, arguments: args }] };
}

export function isAgentRequest(req: ChatRequest): boolean {
  return !!req.tools?.some((t) => t.function.name === 'send_reply');
}

export function agentReply(req: ChatRequest): ScriptedReply {
  const question = stripTags(textOf([...req.messages].reverse().find((m) => m.role === 'user')));
  const toolResults = req.messages.filter((m) => m.role === 'tool');
  const language = isHindi(question) ? 'hi' : 'en';
  const intent = words(question).slice(0, 3).join('_') || 'general_question';

  if (/\b(human|real person|someone real|representative|manager)\b|इंसान/i.test(question)) {
    return call('request_human', { reason: 'The customer asked for a person' });
  }
  if (!toolResults.length) return call('search_knowledge', { query: question.slice(0, 300) });

  let results: Array<{ id: string; source: string; text: string }> = [];
  try {
    results =
      (JSON.parse(textOf(toolResults.at(-1))) as { results?: typeof results }).results ?? [];
  } catch {
    results = [];
  }
  if (!results.length) {
    return call('send_reply', {
      message:
        language === 'hi'
          ? 'मुझे इसका पक्का जवाब नहीं पता, इसलिए मैं किसी सहकर्मी से पूछूँगा।'
          : "I'm not sure about that, so I'll check with a colleague.",
      confidence: 0.3,
      sources: [],
      language,
      intent,
    });
  }
  const top = results[0]!;
  const q = new Set(words(question));
  const overlap = new Set(words(`${top.source} ${top.text}`).filter((w) => q.has(w))).size;
  const confidence = overlap >= 2 ? 0.9 : 0.7;
  const body = firstSentences(top.text, 2);
  return call('send_reply', {
    message: language === 'hi' ? `धन्यवाद। ${body}` : `Thanks for your message. ${body}`,
    confidence,
    sources: [top.id],
    language,
    intent,
    resolves_issue: confidence >= 0.9,
  });
}

export function isClassifierRequest(req: ChatRequest): boolean {
  return textOf(req.messages.find((m) => m.role === 'system')).includes(
    'You classify support tickets',
  );
}

export function classifierReply(req: ChatRequest): ScriptedReply {
  const system = textOf(req.messages.find((m) => m.role === 'system'));
  const ticket = stripTags(textOf(req.messages.find((m) => m.role === 'user')));
  const labels = system
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim());
  const t = new Set(words(ticket));
  let best: { label: string; score: number } = { label: '', score: 0 };
  for (const label of labels) {
    const score = words(label).filter((w) => t.has(w) || t.has(w.replace(/s$/, ''))).length;
    if (score > best.score) best = { label, score };
  }
  const [category, subcategory] = best.label
    ? best.label.split('>').map((s) => s.trim())
    : [null, null];
  const priority = /\b(urgent|asap|immediately|emergency)\b/i.test(ticket)
    ? 'urgent'
    : /\b(charged (twice|three times)|fraud|lost|never arrived|not (been )?delivered)\b/i.test(
          ticket,
        )
      ? 'high'
      : 'normal';
  const sentiment =
    /\b(angry|terrible|worst|furious|unacceptable|ridiculous|still waiting|again)\b/i.test(ticket)
      ? 'negative'
      : 'neutral';
  const content = JSON.stringify({
    category: category ?? null,
    subcategory: subcategory ?? null,
    priority,
    language: isHindi(ticket) ? 'hi' : 'en',
    intent: category
      ? `${category}_${subcategory ?? 'general'}`.toLowerCase().replace(/\W+/g, '_')
      : 'general_question',
    sentiment,
    confidence: best.score > 0 ? 0.85 : 0.4,
  });
  return { content };
}

export function isSummaryRequest(req: ChatRequest): boolean {
  return textOf(req.messages.find((m) => m.role === 'system')).startsWith(
    'Summarize this support conversation',
  );
}

export function summaryReply(req: ChatRequest): ScriptedReply {
  const lines = textOf(req.messages.find((m) => m.role === 'user'))
    .split('\n')
    .filter((l) => l.startsWith('<customer>'))
    .map((l) => firstSentences(stripTags(l), 1))
    .slice(0, 5);
  return { content: `The customer wrote about: ${lines.join(' ')}` };
}
