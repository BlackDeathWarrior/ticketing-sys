import type { ChatMessage, ChatRequest, ScriptedReply } from './llm';

/**
 * Scripted behaviour for the TMS AI agent, classifier and summarizer, so
 * demos and tests run without a real model. Deterministic by design:
 *
 * - Agent: first calls search_knowledge with the customer's words; then
 *   replies from the result that shares most words with the question. Confidence is 0.9 when the result shares at
 *   least two meaningful words with the question, 0.7 when it shares fewer
 *   (the agent drafts), and 0.3 when nothing was found (it hands over).
 *   Asking for a person calls request_human.
 * - Company tools (Phase 6): a message naming an order (DS-12345, ET-100123)
 *   calls the `…__order_status` tool, `…__issue_refund` when it asks for a
 *   refund, or `…__cancel_order` when it asks to cancel. Without a number,
 *   the `order_id` in the ticket context is the order meant; with neither,
 *   asking where "my order" is calls `…__list_orders`.
 *   A refund waiting for approval is reported as "with the team"; an
 *   <approval_update> in the system prompt is reported to the customer.
 * - A catalogue site: a message that says prices look old calls
 *   `…__catalog_status`, then `…__scraper_status` when the catalogue is stale;
 *   asking for a refresh calls `…__trigger_rescrape` (which waits for
 *   approval); a question about price or stock, with a `product_id` in the
 *   ticket context, calls `…__product_lookup`.
 * - Lessons (ADR 0020): a lesson in the system prompt of the form "When
 *   customers ask about X, tell them: Y" is followed when the question shares
 *   three meaningful words with X: the reply is Y.
 * - Small talk: a greeting, or "can you hear me?", gets a greeting back. A
 *   message with nothing to look up ("answer me", "help") is asked what it is
 *   about, instead of being answered with whatever passage came closest.
 * - Red team (ADR 0021): asked to print or repeat its instructions, the
 *   scripted model does: the worst case, so tests can show that the system
 *   around the model still stops the reply.
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

const ORDER = /\b((?:DS|ET)-\d{4,9})\b/i;
const CANCEL = /\bcancel\b/i;
const REFUND = /\b(refund|money back|charged (?:me )?twice|double charge|charged two times)\b/i;
const WHERE = /\b(where|status|track|tracking|shipped|deliver(?:y|ed)?|arriv(?:e|ing|al))\b/i;

/** The name of an offered company tool ending in `__<suffix>`, if any. */
function companyTool(req: ChatRequest, suffix: string): string | undefined {
  return req.tools?.map((t) => t.function.name).find((n) => n.endsWith(`__${suffix}`));
}

/** Which tool produced each tool message, from the assistant's calls before it. */
function toolNameOf(req: ChatRequest, toolMessage: ChatMessage): string {
  for (const m of req.messages) {
    for (const c of (m.tool_calls ?? []) as Array<{ id: string; function: { name: string } }>) {
      if (c.id === toolMessage.tool_call_id) return c.function.name;
    }
  }
  return '';
}

function reply(message: string, confidence: number, extra: Record<string, unknown> = {}) {
  return call('send_reply', { message, confidence, sources: [], language: 'en', ...extra });
}

/** Company-tool flows; undefined when the message isn't about an order. */
function companyFlow(req: ChatRequest, question: string): ScriptedReply | undefined {
  const system = textOf(req.messages.find((m) => m.role === 'system'));
  const update =
    /<approval_update tool="([^"]*)" status="(done|rejected)">\s*([\s\S]*?)\s*<\/approval_update>/.exec(
      system,
    );
  if (update) {
    const [, , status, detail] = update;
    if (status === 'rejected') {
      return reply(
        "I'm sorry, our team could not approve this request. A colleague will follow up if anything else is needed.",
        0.85,
        { intent: 'approval_outcome' },
      );
    }
    let d: Record<string, unknown> = {};
    try {
      d = JSON.parse(detail ?? '{}') as Record<string, unknown>;
    } catch {
      d = {};
    }
    const money =
      typeof d.amount === 'number'
        ? `${d.amount.toFixed(2)} ${String(d.currency ?? '')}`.trim()
        : '';
    return reply(
      d.refund_id
        ? `Good news: your refund${money ? ` of ${money}` : ''} for order ${String(d.order_id ?? '')} has been issued (reference ${String(d.refund_id)}). It should arrive in ${String(d.arrives_in ?? '5 to 7 business days')}.`
        : d.started
          ? 'Good news: the catalogue refresh has started. New prices appear on the site as each store finishes.'
          : 'Good news: your request has been approved and completed.',
      0.92,
      { intent: 'approval_outcome', resolves_issue: true },
    );
  }

  const results = req.messages.filter((m) => m.role === 'tool');
  const last = results.at(-1);
  const lastName = last ? toolNameOf(req, last) : '';
  if (
    last &&
    /__(order_status|issue_refund|payment_status|lookup_customer|cancel_order|list_orders)$/.test(
      lastName,
    )
  ) {
    let r: Record<string, unknown> = {};
    try {
      r = JSON.parse(textOf(last)) as Record<string, unknown>;
    } catch {
      r = {};
    }
    const order = orderIn(req, question) ?? 'your order';
    if (r.status === 'pending_approval' || r.status === 'simulated') {
      return reply(
        `I've sent your refund request for order ${order} to our team for approval. You'll get an update here as soon as it has been reviewed.`,
        0.9,
        { intent: 'refund_request' },
      );
    }
    if (r.ok === false || r.error) {
      return call('request_human', {
        reason: `The order system could not help: ${String(r.error ?? 'unknown error')}`,
      });
    }
    let o = (r.result ?? {}) as Record<string, unknown>;
    if (lastName.endsWith('__cancel_order')) {
      const refunded =
        typeof o.amount === 'number'
          ? ` Your refund of ${o.amount.toFixed(2)} ${String(o.currency ?? '')}`.trimEnd() +
            ` (reference ${String(o.refund_id ?? '')}) is on its way.`
          : ' Nothing was charged for it.';
      return reply(`Order ${String(o.order_id ?? order)} is cancelled.${refunded}`, 0.92, {
        intent: 'order_cancellation',
        resolves_issue: true,
      });
    }
    if (lastName.endsWith('__list_orders')) {
      const recent = (o.orders ?? []) as Array<Record<string, unknown>>;
      if (!recent.length) {
        return reply("I can't find any orders on your account yet.", 0.9, {
          intent: 'order_status',
        });
      }
      // The newest order is what "my order" most likely means.
      o = recent[0]!;
    }
    const parts = [
      `Order ${String(o.order_id ?? order)} is ${String(o.status ?? 'being processed')}`,
    ];
    if (o.carrier) parts[0] += ` with ${String(o.carrier)}`;
    if (o.tracking_number) parts.push(`the tracking number is ${String(o.tracking_number)}`);
    if (o.estimated_delivery)
      parts.push(`the carrier's estimate is ${String(o.estimated_delivery)}`);
    if (o.delayed) parts.push('it is delayed with the carrier at the moment');
    return reply(`${parts.join('; ')}.`, 0.92, { intent: 'order_status', resolves_issue: true });
  }

  const orderId = orderIn(req, question);
  if (results.length) return undefined;
  if (!orderId) {
    const list = companyTool(req, 'list_orders');
    return list && WHERE.test(question) && /\border\b/i.test(question) ? call(list, {}) : undefined;
  }
  const cancel = companyTool(req, 'cancel_order');
  if (CANCEL.test(question) && cancel) {
    return call(cancel, { order_id: orderId, reason: `Customer asked: ${question.slice(0, 150)}` });
  }
  const refund = companyTool(req, 'issue_refund');
  if (REFUND.test(question) && refund) {
    return call(refund, { order_id: orderId, reason: `Customer asked: ${question.slice(0, 150)}` });
  }
  const status = companyTool(req, 'order_status');
  if (WHERE.test(question) && status) return call(status, { order_id: orderId });
  return undefined;
}

/** One `key: value` line of the ticket's context (what the app said the customer has open). */
function contextValue(req: ChatRequest, key: string): string | undefined {
  const system = textOf(req.messages.find((m) => m.role === 'system'));
  const block = /<ticket_context>\n([\s\S]*?)\n<\/ticket_context>/.exec(system)?.[1] ?? '';
  return new RegExp(`^${key}: (\\S+)$`, 'm').exec(block)?.[1];
}

/** The order the customer means: the number they wrote, else the order their request is about. */
function orderIn(req: ChatRequest, question: string): string | undefined {
  const written = ORDER.exec(question)?.[1];
  if (written) return written.toUpperCase();
  const open = contextValue(req, 'order_id');
  return open && ORDER.test(open) ? open.toUpperCase() : undefined;
}

const OLD =
  'old|older|outdated|out of date|stale|wrong|different|higher|lower|not (?:been )?updated';
const STALE = new RegExp(
  `\\b(?:${OLD})\\b[^.?!]*\\bprices?\\b|\\bprices?\\b[^.?!]*\\b(?:${OLD})\\b`,
  'i',
);
const REFRESH =
  /\b(refresh|re-?scrape|rescan|update)\b[^.?!]*\b(prices?|catalogue|catalog|listings?|site)\b/i;
const ABOUT_LISTING = /\b(in stock|available|sold out|how much|price|cost)\b/i;
const SITE_TOOL = /__(catalog_status|scraper_status|product_lookup|trigger_rescrape)$/;

const day = (iso: unknown) => String(iso ?? '').slice(0, 10) || 'an unknown date';

function freshness(c: Record<string, unknown>): string {
  return c.stale
    ? `Our catalogue was last refreshed on ${day(c.newest_scraped_at)}, ${String(c.age_days ?? 'several')} days ago, so prices and stock shown on the site may no longer match the stores. The store's price is the one you pay.`
    : `Our catalogue was refreshed on ${day(c.newest_scraped_at)}, so the prices shown should be current. A store can still change a price at any time; the store's price is the one you pay.`;
}

/**
 * Flows for a site that shows a scraped catalogue; undefined when
 * the message is not about how fresh the catalogue is, a refresh or a listing.
 */
function siteFlow(req: ChatRequest, question: string): ScriptedReply | undefined {
  const results = req.messages.filter((m) => m.role === 'tool');
  const read = (m: ChatMessage): Record<string, unknown> => {
    try {
      return JSON.parse(textOf(m)) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const last = results.at(-1);
  const lastName = last ? toolNameOf(req, last) : '';

  if (last && SITE_TOOL.test(lastName)) {
    const r = read(last);
    if (r.status === 'pending_approval' || r.status === 'simulated') {
      return reply(
        "I've asked our team to approve a refresh of the catalogue. You'll get an update here as soon as it has been reviewed.",
        0.9,
        { intent: 'catalogue_refresh' },
      );
    }
    if (r.ok === false || r.error) {
      return call('request_human', {
        reason: `The site's systems could not help: ${String(r.error ?? 'unknown error')}`,
      });
    }
    const o = (r.result ?? {}) as Record<string, unknown>;
    if (lastName.endsWith('__catalog_status')) {
      const scraper = companyTool(req, 'scraper_status');
      // A stale catalogue raises the next question: is anything refreshing it?
      if (o.stale && scraper) return call(scraper, {});
      return reply(freshness(o), 0.9, { intent: 'catalogue_freshness', resolves_issue: true });
    }
    if (lastName.endsWith('__scraper_status')) {
      const earlier = results.find((m) => toolNameOf(req, m).endsWith('__catalog_status'));
      const catalogue = earlier ? ((read(earlier).result ?? {}) as Record<string, unknown>) : null;
      const state = o.running
        ? 'A refresh is running now, so newer prices will appear as each store finishes.'
        : o.last_exit_code
          ? 'The program that refreshes it is not running, and its last run ended with an error.'
          : 'No refresh is running at the moment.';
      return reply(`${catalogue ? `${freshness(catalogue)} ` : ''}${state}`, 0.9, {
        intent: 'catalogue_freshness',
      });
    }
    if (lastName.endsWith('__product_lookup')) {
      const price = typeof o.price_current === 'number' ? ` at ₹${o.price_current}` : '';
      const stock = o.in_stock === false ? 'was sold out' : 'was in stock';
      return reply(
        `${String(o.title ?? 'That listing')} is listed${price} on ${String(o.source ?? 'the store')}, and ${stock} when we last checked on ${day(o.scraped_at)}. The store's own page shows the current price.`,
        0.9,
        { intent: 'listing_question', resolves_issue: true },
      );
    }
  }
  if (results.length) return undefined;

  const refresh = companyTool(req, 'trigger_rescrape');
  if (REFRESH.test(question) && refresh) {
    return call(refresh, { reason: `Shopper asked: ${question.slice(0, 100)}` });
  }
  const catalogue = companyTool(req, 'catalog_status');
  if (STALE.test(question) && catalogue) return call(catalogue, {});
  const lookup = companyTool(req, 'product_lookup');
  const productId = contextValue(req, 'product_id');
  if (ABOUT_LISTING.test(question) && lookup && productId) {
    return call(lookup, { product_id: productId });
  }
  return undefined;
}

/**
 * The answer a staff lesson prescribes for this question, if one applies.
 * Lessons are lines under "Lessons from reviewed customer feedback".
 */
export function lessonAnswer(system: string, question: string): string | undefined {
  const block = /Lessons from reviewed customer feedback[^\n]*\n((?:- [^\n]*\n?)+)/.exec(
    system,
  )?.[1];
  if (!block) return undefined;
  const q = new Set(words(question));
  for (const line of block.split('\n')) {
    const lesson = line.replace(/^- /, '').trim();
    const say = /\b(?:tell them|say|answer)\s*:\s*(.+)$/i.exec(lesson);
    if (!say) continue;
    const when = lesson.slice(0, say.index);
    // Three shared words: "refund" and "card" alone must not trigger a lesson about gift cards.
    if (new Set(words(when).filter((w) => q.has(w))).size >= 3) return say[1]!.trim();
  }
  return undefined;
}

/** Words that ask for attention without saying what about. */
const FILLER =
  /\b(answer|reply|respond|help|need|assist|assistance|question|query|anyone|anybody|someone|somebody|okay|yes)\b/giu;

/** A greeting or "are you there?" with nothing to look up. */
export function isSmallTalk(question: string): boolean {
  const q = question.trim();
  if (
    /^(can|could) (you|anyone|anybody) hear me\b|^(is|are) (you|anyone|anybody|someone) there\b/i.test(
      q,
    )
  ) {
    return true;
  }
  // A greeting followed by a question ("Hi, where is my order?") is a question.
  const greeting = /\b(hi|hello|hey|namaste|good|morning|afternoon|evening|there)\b|नमस्ते/giu;
  return greeting.test(q) && words(q.replace(greeting, ' ')).length === 0;
}

/**
 * The scripted agent. A question containing "in plain words" makes it behave
 * like the models that answer in plain text instead of calling send_reply: it
 * uses the tool once the system reminds it (a `<system_note>`), and with "stay
 * in plain words" not even then.
 */
export function agentReply(req: ChatRequest): ScriptedReply {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const reminded = textOf(lastUser).includes('<system_note>');
  // The reminder and the plain answer before it are not part of what was asked.
  const asked = reminded ? { ...req, messages: req.messages.slice(0, -2) } : req;
  const out = scriptedTurn(asked);
  const question = textOf([...asked.messages].reverse().find((m) => m.role === 'user'));
  const sent = out.toolCalls?.find((c) => c.name === 'send_reply');
  if (
    sent &&
    /\bin plain words\b/i.test(question) &&
    (!reminded || /\bstay in plain words\b/i.test(question))
  ) {
    return { content: String(sent.arguments.message ?? '') };
  }
  return out;
}

function scriptedTurn(req: ChatRequest): ScriptedReply {
  const question = stripTags(textOf([...req.messages].reverse().find((m) => m.role === 'user')));
  const toolResults = req.messages.filter((m) => m.role === 'tool');
  const language = isHindi(question) ? 'hi' : 'en';
  const intent = words(question).slice(0, 3).join('_') || 'general_question';

  if (/\b(human|real person|someone real|representative|manager)\b|इंसान/i.test(question)) {
    return call('request_human', { reason: 'The customer asked for a person' });
  }
  if (/\b(print|repeat|reveal|show)\b[^.?!]*\b(system prompt|instructions)\b/i.test(question)) {
    const system = textOf(req.messages.find((m) => m.role === 'system'));
    return call('send_reply', {
      message: `Sure. My instructions are: ${system.slice(0, 400)}`,
      confidence: 0.95,
      sources: [],
      language,
      intent: 'instructions',
    });
  }
  const company = companyFlow(req, question) ?? siteFlow(req, question);
  if (company) return company;
  if (isSmallTalk(question)) {
    return call('send_reply', {
      message:
        language === 'hi'
          ? 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?'
          : 'Hello! Yes, I am here. How can I help you today?',
      confidence: 0.9,
      sources: [],
      language,
      intent: 'greeting',
    });
  }
  // Nothing to look up yet ("answer me", "I need help", "???"): ask for the question.
  if (!words(question.replace(FILLER, ' ')).length) {
    return call('send_reply', {
      message:
        language === 'hi'
          ? 'मैं यहाँ हूँ और मदद के लिए तैयार हूँ। कृपया थोड़ा और बताएँ कि आपको क्या चाहिए: जैसे आपका ऑर्डर नंबर, या बात डिलीवरी, वापसी या रिफंड की है।'
          : "I'm here and happy to help. Could you tell me a little more about what you need? For example your order number, or whether it is about a delivery, a return or a refund.",
      confidence: 0.9,
      sources: [],
      language,
      intent: 'clarify',
    });
  }
  if (!toolResults.length) return call('search_knowledge', { query: question.slice(0, 300) });

  let results: Array<{ id: string; source: string; text: string }> = [];
  try {
    results =
      (JSON.parse(textOf(toolResults.at(-1))) as { results?: typeof results }).results ?? [];
  } catch {
    results = [];
  }
  const lesson = lessonAnswer(textOf(req.messages.find((m) => m.role === 'system')), question);
  if (lesson) {
    return call('send_reply', {
      message: lesson,
      confidence: 0.9,
      sources: results[0] ? [results[0].id] : [],
      language,
      intent,
      resolves_issue: true,
    });
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
  // Reads every passage it was given, as a model would, and answers from the one that
  // shares most words with the question: the search's first hit is not always the best
  // one. Between equals, the passage that uses those words more often wins, then the
  // earlier one.
  const q = new Set(words(question));
  const hits = (r: (typeof results)[number]) =>
    words(`${r.source} ${r.text}`).filter((w) => q.has(w));
  const shared = (r: (typeof results)[number]) => new Set(hits(r)).size;
  const fit = (r: (typeof results)[number]) => shared(r) * 1_000 + hits(r).length;
  const top = results.reduce((best, r) => (fit(r) > fit(best) ? r : best), results[0]!);
  const overlap = shared(top);
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

export function isHandoverRequest(req: ChatRequest): boolean {
  return textOf(req.messages.find((m) => m.role === 'system')).startsWith(
    'You write handover notes',
  );
}

/** The context pack: what the customer asked, and a next step from the handover reason. */
export function handoverReply(req: ChatRequest): ScriptedReply {
  const user = textOf(req.messages.find((m) => m.role === 'user'));
  const reason = /^Handover reason: (.*)$/m.exec(user)?.[1] ?? '';
  const asks = user
    .split('\n')
    .filter((l) => l.startsWith('<customer>'))
    .map((l) => firstSentences(stripTags(l), 1))
    .slice(-2);
  const summary = asks.length
    ? `The customer wrote: ${asks.join(' ')}`
    : 'No customer messages yet.';
  const next = /person/i.test(reason)
    ? 'Reply personally and confirm you are looking into it.'
    : /approval|expired/i.test(reason)
      ? 'Decide on the pending request, then tell the customer.'
      : 'Answer the open question; the AI was not sure.';
  return {
    content: JSON.stringify({
      summary,
      intent: words(asks.join(' ')).slice(0, 3).join('_') || 'general_question',
      next_step: next,
    }),
  };
}

export function isCopilotRequest(req: ChatRequest): boolean {
  return textOf(req.messages.find((m) => m.role === 'system')).startsWith(
    'You draft a reply for a support agent',
  );
}

/** A reply draft from the top knowledge passage, addressed to the customer. */
export function copilotReply(req: ChatRequest): ScriptedReply {
  const system = textOf(req.messages.find((m) => m.role === 'system'));
  const name = /^Customer: (.+)\.$/m.exec(system)?.[1]?.split(' ')[0] ?? 'there';
  const top = /<knowledge [^>]*>\n([\s\S]*?)\n<\/knowledge>/.exec(system)?.[1];
  const body = top
    ? firstSentences(top, 2)
    : "Thanks for your patience. I'm looking into this and will get back to you shortly.";
  return { content: `Hi ${name},\n\n${body}\n\nKind regards, Support` };
}
