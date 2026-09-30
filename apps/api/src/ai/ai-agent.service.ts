import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import {
  type AiBehaviour,
  type AiChannelMode,
  type AiDecision,
  type AiRule,
  AI_RULE_LABELS,
  asksForHuman,
  type SimulateAiInput,
  type SimulateAiResult,
} from '@tms/shared';
import Redis from 'ioredis';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { OutboundService } from '../channels/outbound.service';
import { AI_CTX } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB, REDIS } from '../infra/tokens';
import { KbSearchService } from '../kb/kb-search.service';
import { LlmClientService, LlmUnavailableError } from '../llm/llm-client.service';
import { OrgService } from '../org/org.service';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';
import { AiRunsService } from './ai-runs.service';
import { LanguageService } from './language.service';
import { assess, handoverMessage, handoverNote } from './policy';
import {
  AGENT_PROMPT_VERSION,
  agentSystemPrompt,
  customerTurn,
  SUMMARY_PROMPT_VERSION,
  summarySystemPrompt,
} from './prompts';
import {
  AGENT_TOOLS,
  parseArgs,
  requestHumanArgs,
  searchArgs,
  sendReplyArgs,
  updateTicketArgs,
} from './tools';

/** Thrown when another turn holds the conversation; the queue retries shortly. */
export class ConversationBusyError extends Error {
  constructor() {
    super('Another AI turn is running for this conversation');
  }
}

type Line = { author: 'customer' | 'ai' | 'agent'; body: string };

interface ThinkInput {
  channel: string;
  mode: AiChannelMode;
  behaviour: AiBehaviour;
  transcript: Line[];
  summary: string | null;
  ticket: {
    id: string | null;
    reference: string;
    subject: string;
    status: string;
    category: string | null;
  };
  customer: { name: string; type: string };
  language: string | null;
  unconfidentTurnsBefore: number;
  conversationId: string | null;
}

export interface ThinkResult {
  decision: Exclude<AiDecision, 'skipped'>;
  reply: string | null;
  confidence: number | null;
  selfConfidence: number | null;
  rules: AiRule[];
  handoverReason: string | null;
  language: string | null;
  intent: string | null;
  resolves: boolean;
  ticketUpdate: { category?: string; priority?: 'urgent' | 'high' | 'normal' | 'low' };
  tools: Array<{ name: string; summary: string }>;
  sources: Array<{ chunkId: string; label: string }>;
  seenSources: string[];
  model: string | null;
  costUsd: number;
  latencyMs: number;
  error: string | null;
}

const LOCK_MS = 120_000;
const HISTORY_TAIL = 8;
const SUMMARIZE_AFTER = 14;
const LIVE_CHANNELS = new Set(['webchat', 'whatsapp', 'voice']);

/**
 * The first-line AI agent (ADR 0011). One turn answers the customer's latest
 * message(s): search the knowledge base, call tools, then send, draft or hand
 * over depending on confidence, rules and the channel's mode. Every turn is
 * recorded in `ai_runs` with an `ai` audit entry.
 */
@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly llm: LlmClientService,
    private readonly kb: KbSearchService,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly outbound: OutboundService,
    private readonly org: OrgService,
    private readonly behaviour: AiBehaviourService,
    private readonly runs: AiRunsService,
    private readonly language: LanguageService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Answers the conversation's unanswered customer message(s), if the AI still owns it. */
  async runTurn(conversationId: string, triggerMessageId: string | null): Promise<AiDecision> {
    const lockKey = `tms:lock:ai:${conversationId}`;
    const token = `${process.pid}:${Date.now()}`;
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_MS, 'NX')) !== 'OK')
      throw new ConversationBusyError();
    try {
      return await this.turn(conversationId, triggerMessageId);
    } finally {
      await this.redis
        .eval(
          `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
          1,
          lockKey,
          token,
        )
        .catch(() => undefined);
    }
  }

  /** Dry run on a made-up conversation: nothing is stored or sent. */
  async simulate(input: SimulateAiInput): Promise<SimulateAiResult> {
    const behaviour = await this.behaviour.get();
    const first = input.messages.find((m) => m.author === 'customer')?.body ?? 'Question';
    const last = [...input.messages].reverse().find((m) => m.author === 'customer')?.body ?? first;
    const r = await this.think({
      channel: input.channel,
      mode: behaviour.channels[input.channel],
      behaviour,
      transcript: input.messages,
      summary: null,
      ticket: {
        id: null,
        reference: 'TMS-SIM',
        subject: first.slice(0, 120),
        status: 'ai_handling',
        category: null,
      },
      customer: { name: 'Customer', type: 'standard' },
      language: await this.language.detect(last),
      unconfidentTurnsBefore: 0,
      conversationId: null,
    });
    return {
      decision: r.decision,
      reply: r.reply,
      confidence: r.confidence,
      rules: r.rules,
      language: r.language,
      intent: r.intent,
      tools: r.tools,
      sources: r.sources,
      model: r.model,
      latencyMs: r.latencyMs,
    };
  }

  private async turn(conversationId: string, triggerMessageId: string | null): Promise<AiDecision> {
    const conv = await this.conversations.get(conversationId).catch(() => null);
    if (!conv || conv.controller !== 'ai') return 'skipped';
    const behaviour = await this.behaviour.get();
    const mode = (behaviour.channels as Record<string, AiChannelMode>)[conv.channel] ?? 'off';
    if (mode === 'off') return 'skipped';

    const rows = await this.conversations.transcript(conv.id, 30);
    const lastRow = rows.at(-1);
    // Already answered (a burst of messages is answered once), or nothing to answer.
    if (!lastRow || lastRow.authorType !== 'customer') return 'skipped';

    const ticket = await this.tickets.get(conv.ticketId);
    const customer = await this.customers.get(ticket.customerId);
    const transcript: Line[] = rows
      .filter((m) => m.authorType !== 'system')
      .map((m) => ({ author: m.authorType as Line['author'], body: m.body }));
    const language = conv.language ?? (await this.language.detect(lastRow.body));
    const summary = await this.summaryFor(conv.id, rows, conv.summary, conv.metadata, ticket.id);
    const lastHandover = conv.metadata.lastHandoverAt
      ? new Date(String(conv.metadata.lastHandoverAt))
      : undefined;

    const r = await this.think({
      channel: conv.channel,
      mode,
      behaviour,
      transcript: summary ? transcript.slice(-HISTORY_TAIL) : transcript,
      summary,
      ticket: {
        id: ticket.id,
        reference: ticket.reference,
        subject: ticket.subject,
        status: ticket.status,
        category: ticket.category?.id
          ? `${ticket.category.name}${ticket.subcategory?.id ? ` > ${ticket.subcategory.name}` : ''}`
          : null,
      },
      customer: { name: customer.displayName, type: customer.customerType },
      language,
      unconfidentTurnsBefore: await this.runs.unconfidentTurns(
        conv.id,
        behaviour.sendAt,
        lastHandover,
      ),
      conversationId: conv.id,
    });

    if (Object.keys(r.ticketUpdate).length && r.decision !== 'error') {
      await this.applyTicketUpdate(ticket.id, r.ticketUpdate).catch((err: Error) =>
        this.logger.warn(`AI ticket update failed on ${ticket.reference}: ${err.message}`),
      );
    }

    const replyLanguage = r.language ?? language;
    await this.db.transaction(async (tx) => {
      let replyMessageId: string | null = null;
      if ((r.decision === 'sent' || r.decision === 'drafted') && r.reply) {
        const message = await this.outbound.aiReply(
          AI_CTX,
          conv.id,
          r.reply,
          {
            draft: r.decision === 'drafted',
            metadata: { ai: { confidence: r.confidence, rules: r.rules, sources: r.sources } },
          },
          tx,
        );
        replyMessageId = message.id;
        if (r.decision === 'sent' && r.resolves && behaviour.awaitCustomerWhenAnswered) {
          await this.tickets.moveIfAllowed(tx, AI_CTX, ticket.id, 'pending_customer');
        }
      }
      if (r.decision === 'handover' || r.decision === 'error') {
        const locked = await this.conversations.lock(tx, conv.id);
        await this.conversations.setController(tx, AI_CTX, locked, 'none', null);
        await this.tickets.moveIfAllowed(tx, AI_CTX, ticket.id, 'human_assigned');
        const reasons = r.rules.length
          ? r.rules.map((rule) => AI_RULE_LABELS[rule])
          : [r.handoverReason ?? 'The AI could not answer'];
        if (r.handoverReason && !reasons.includes(r.handoverReason)) reasons.push(r.handoverReason);
        await this.tickets.addNoteInTx(
          tx,
          AI_CTX,
          ticket.id,
          handoverNote({
            reasons,
            lastCustomerMessage: lastRow.body,
            aiReplies: rows.filter((m) => m.authorType === 'ai').length,
            sources: r.seenSources,
            draft: r.reply,
          }),
        );
        if (LIVE_CHANNELS.has(conv.channel) && mode === 'auto') {
          const m = await this.outbound.aiReply(
            AI_CTX,
            conv.id,
            handoverMessage(replyLanguage),
            { draft: false },
            tx,
          );
          replyMessageId = m.id;
        }
        const data = { conversationId: conv.id, reasons, rules: r.rules };
        await this.audit.record(tx, AI_CTX, {
          action: 'ai.handover',
          targetType: 'ticket',
          targetId: ticket.id,
          data,
        });
        await this.outbox.publish(tx, AI_CTX, {
          type: 'ai.handover',
          aggregateType: 'ticket',
          aggregateId: ticket.id,
          payload: data,
        });
      }
      await this.conversations.updateAiState(tx, conv.id, {
        language: replyLanguage,
        ...(r.decision === 'handover' || r.decision === 'error'
          ? { metadata: { lastHandoverAt: new Date().toISOString() } }
          : {}),
      });
      await this.runs.record(tx, {
        kind: 'turn',
        ticketId: ticket.id,
        conversationId: conv.id,
        triggerMessageId,
        decision: r.decision,
        confidence: r.confidence,
        selfConfidence: r.selfConfidence,
        rules: r.rules,
        model: r.model,
        promptVersion: AGENT_PROMPT_VERSION,
        tools: r.tools,
        sources: r.sources,
        replyMessageId,
        language: replyLanguage,
        intent: r.intent,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        error: r.error,
      });
    });
    this.logger.log(`AI ${r.decision} on ${ticket.reference} (confidence ${r.confidence ?? '–'})`);
    return r.decision;
  }

  /** The model loop, shared by live turns and dry runs. No side effects beyond LLM calls and searches. */
  private async think(i: ThinkInput): Promise<ThinkResult> {
    const started = Date.now();
    const out: ThinkResult = {
      decision: 'handover',
      reply: null,
      confidence: null,
      selfConfidence: null,
      rules: [],
      handoverReason: null,
      language: i.language,
      intent: null,
      resolves: false,
      ticketUpdate: {},
      tools: [],
      sources: [],
      seenSources: [],
      model: null,
      costUsd: 0,
      latencyMs: 0,
      error: null,
    };
    const finish = () => ({ ...out, latencyMs: Date.now() - started });
    const last = [...i.transcript].reverse().find((l) => l.author === 'customer')?.body ?? '';

    if (asksForHuman(last)) {
      out.rules = ['asked_for_human'];
      return finish();
    }

    const labels = new Map<string, string>();
    const search = async (query: string, limit: number) => {
      const res = await this.kb.search(
        { ticketId: i.ticket.id },
        { q: query, limit, audience: 'customer', includeDrafts: false },
      );
      return res.hits.map((h) => {
        labels.set(h.chunkId, h.citation.label);
        return { id: h.chunkId, source: h.citation.label, text: h.snippet };
      });
    };

    const knowledge = await search(last, 3).catch(() => []);
    const categories = await this.categoryLabels();
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: agentSystemPrompt({
          channel: i.channel,
          language: i.language,
          customer: i.customer,
          ticket: i.ticket,
          summary: i.summary,
          knowledge: knowledge.map((k) => ({ id: k.id, label: k.source, text: k.text })),
          categories,
        }),
      },
      ...i.transcript.map<ChatCompletionMessageParam>((l) =>
        l.author === 'customer'
          ? { role: 'user', content: customerTurn(l.body) }
          : { role: 'assistant', content: l.body },
      ),
    ];

    let final:
      | { kind: 'reply'; args: ReturnType<typeof sendReplyArgs.parse> }
      | { kind: 'human'; reason: string }
      | null = null;
    for (let step = 0; step < i.behaviour.maxSteps && !final; step++) {
      let completion;
      try {
        const r = await this.llm.chat({
          role: i.channel === 'voice' ? 'chat_agent_voice' : 'chat_agent',
          messages,
          tools: AGENT_TOOLS,
          maxTokens: 700,
          temperature: 0.2,
          ticketId: i.ticket.id,
          conversationId: i.conversationId,
        });
        completion = r.completion;
        out.model = r.model;
        out.costUsd += r.costUsd;
      } catch (err) {
        out.decision = 'handover';
        if (err instanceof LlmUnavailableError) {
          out.rules = [err.reason === 'over_budget' ? 'budget_exhausted' : 'no_model'];
        } else {
          out.decision = 'error';
          out.rules = ['model_error'];
          out.error = (err as Error).message;
        }
        return finish();
      }

      const msg = completion.choices[0]?.message;
      const calls = msg?.tool_calls?.filter((c) => c.type === 'function') ?? [];
      if (!calls.length) {
        if (msg?.content?.trim())
          final = {
            kind: 'reply',
            args: sendReplyArgs.parse({ message: msg.content, confidence: 0.5 }),
          };
        break;
      }
      messages.push({ role: 'assistant', content: msg?.content ?? null, tool_calls: calls });
      for (const call of calls) {
        const name = call.function.name;
        let result: unknown;
        if (name === 'search_knowledge') {
          const a = parseArgs(searchArgs, call.function.arguments);
          if (a.ok) {
            const hits = await search(a.value.query, 4).catch(() => []);
            out.tools.push({ name, summary: `“${a.value.query}” → ${hits.length} results` });
            result = { results: hits };
          } else result = { error: a.error };
        } else if (name === 'update_ticket') {
          const a = parseArgs(updateTicketArgs, call.function.arguments);
          if (a.ok) {
            out.ticketUpdate = { ...out.ticketUpdate, ...a.value };
            out.tools.push({
              name,
              summary: Object.entries(a.value)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', '),
            });
            result = { ok: true };
          } else result = { error: a.error };
        } else if (name === 'request_human') {
          const a = parseArgs(requestHumanArgs, call.function.arguments);
          final = { kind: 'human', reason: a.ok ? a.value.reason : '' };
          out.tools.push({ name, summary: final.reason || 'handover' });
          result = { ok: true };
        } else if (name === 'send_reply') {
          const a = parseArgs(sendReplyArgs, call.function.arguments);
          if (a.ok) {
            final = { kind: 'reply', args: a.value };
            result = { ok: true };
          } else result = { error: a.error };
        } else {
          result = { error: `Unknown tool ${name}` };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    out.seenSources = [...new Set(labels.values())];
    if (!final) {
      out.rules = ['no_answer'];
      return finish();
    }
    if (final.kind === 'human') {
      out.rules = ['ai_requested'];
      out.handoverReason = final.reason || null;
      return finish();
    }
    const a = final.args;
    const cited = a.sources.filter((id) => labels.has(id));
    const verdict = assess({
      selfConfidence: a.confidence,
      reply: a.message,
      citedSources: cited.length,
      confirmedByTool: false,
      unconfidentTurnsBefore: i.unconfidentTurnsBefore,
      mode: i.mode,
      behaviour: i.behaviour,
    });
    out.decision = verdict.decision;
    out.confidence = verdict.confidence;
    out.selfConfidence = a.confidence;
    out.rules = verdict.rules;
    out.reply = a.message || null;
    out.language = a.language?.split('-')[0] ?? i.language;
    out.intent = a.intent ?? null;
    out.resolves = !!a.resolves_issue;
    out.sources = cited.map((id) => ({ chunkId: id, label: labels.get(id)! }));
    return finish();
  }

  /** A rolling summary of older messages once a conversation gets long. */
  private async summaryFor(
    conversationId: string,
    rows: Array<{ id: string; authorType: string; body: string }>,
    current: string | null,
    metadata: Record<string, unknown>,
    ticketId: string,
  ): Promise<string | null> {
    if (rows.length <= SUMMARIZE_AFTER) return null;
    const older = rows.slice(0, -HISTORY_TAIL);
    const upto = older.at(-1)!.id;
    if (current && metadata.summaryUpto === upto) return current;
    try {
      const r = await this.llm.chat({
        role: 'summarizer',
        messages: [
          { role: 'system', content: summarySystemPrompt() },
          {
            role: 'user',
            content: older
              .map((m) => `<${m.authorType}>${m.body.slice(0, 1500)}</${m.authorType}>`)
              .join('\n'),
          },
        ],
        maxTokens: 250,
        ticketId,
        conversationId,
      });
      const text = r.completion.choices[0]?.message.content?.trim() ?? null;
      if (text) {
        await this.conversations.updateAiState(this.db, conversationId, {
          summary: text,
          metadata: { summaryUpto: upto, summaryPrompt: SUMMARY_PROMPT_VERSION },
        });
      }
      return text ?? current;
    } catch (err) {
      this.logger.warn(`summary failed: ${(err as Error).message}`);
      return current;
    }
  }

  private async categoryLabels(): Promise<string[]> {
    const tree = await this.org.listCategories().catch(() => []);
    return tree.flatMap((c) =>
      c.children.length ? c.children.map((s) => `${c.name} > ${s.name}`) : [c.name],
    );
  }

  private async applyTicketUpdate(ticketId: string, u: ThinkResult['ticketUpdate']) {
    const patch: {
      categoryId?: string;
      subcategoryId?: string | null;
      priority?: 'urgent' | 'high' | 'normal' | 'low';
    } = {};
    if (u.category) {
      const match = await this.matchCategory(u.category);
      if (match) {
        patch.categoryId = match.categoryId;
        patch.subcategoryId = match.subcategoryId;
      }
    }
    if (u.priority) patch.priority = u.priority;
    if (Object.keys(patch).length) await this.tickets.update(AI_CTX, ticketId, patch);
  }

  async matchCategory(
    label: string,
  ): Promise<{ categoryId: string; subcategoryId: string | null } | null> {
    const [catName, subName] = label.split('>').map((s) => s.trim().toLowerCase());
    const tree = await this.org.listCategories();
    const cat = tree.find((c) => c.name.toLowerCase() === catName);
    if (!cat) return null;
    const sub = subName ? cat.children.find((s) => s.name.toLowerCase() === subName) : undefined;
    return { categoryId: cat.id, subcategoryId: sub?.id ?? null };
  }
}
