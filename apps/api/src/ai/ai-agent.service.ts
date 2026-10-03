import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database } from '@tms/db';
import {
  type AiBehaviour,
  type AiChannelMode,
  type AiDecision,
  type AiRule,
  cautionText,
  AI_RULE_LABELS,
  asksForHuman,
  declinesMoreHelp,
  smallTalk,
  type SimulateAiInput,
  type SimulateAiResult,
  describeArgs,
} from '@tms/shared';
import Redis from 'ioredis';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { OutboundService } from '../channels/outbound.service';
import { lockTicketThenConversation } from '../channels/lock-order';
import { AI_CTX, SYSTEM_CTX } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB, REDIS } from '../infra/tokens';
import { KbSearchService } from '../kb/kb-search.service';
import { LlmClientService, LlmUnavailableError } from '../llm/llm-client.service';
import { OrgService } from '../org/org.service';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { BrandingService } from '../settings/branding.service';
import { HandoverService } from '../handover/handover.service';
import { LearningService } from '../learning/learning.service';
import { TicketsService } from '../tickets/tickets.service';
import { ApprovalsService } from '../tools/approvals.service';
import { forModel, type InvokeResult, ToolGatewayService } from '../tools/tool-gateway.service';
import { type AgentTool, ToolsService } from '../tools/tools.service';
import { AiAutoResolveService } from './ai-auto-resolve';
import { AiRunsService } from './ai-runs.service';
import { AiFastPathsService, type FastAnswer } from './fast-paths.service';
import { acceptsOffer, type GuardHit, screenInbound } from './guard';
import { LanguageService } from './language.service';
import {
  approvalOutcomeMessage,
  assess,
  clarifyMessage,
  closingQuestion,
  conductWarning,
  handoverMessage,
  handoverNote,
  offTopicWarning,
  personOffer,
  smallTalkReply,
  waitingMessage,
  withClosingQuestion,
} from './policy';
import {
  AGENT_PROMPT_VERSION,
  APPROVAL_UPDATE_TURN,
  REPLY_TOOL_REMINDER,
  agentSystemPrompt,
  customerTurn,
  SUMMARY_PROMPT_VERSION,
  summarySystemPrompt,
  ticketContext,
} from './prompts';
import {
  AGENT_TOOLS,
  parseArgs,
  requestHumanArgs,
  searchArgs,
  sendReplyArgs,
  updateTicketArgs,
} from './tools';

/** Channels answered by email: no fixed one-liners, no warnings or closing by the AI alone. */
const BY_EMAIL = new Set(['email', 'web_form']);
/** A request for a person this short says nothing else: it gets the fixed offer. */
const PERSON_ONLY_CHARS = 60;

type ConductClosure = 'jailbreak' | 'abuse' | 'spam' | 'off_topic';
const CONDUCT_RULE: Record<ConductClosure, AiRule> = {
  jailbreak: 'jailbreak_attempt',
  abuse: 'abusive_language',
  spam: 'spam',
  off_topic: 'off_topic',
};

/** How often this conversation has been warned (kept on the conversation, `metadata.guard`). */
function guardState(metadata: Record<string, unknown>): { abuse: number; offTopic: number } {
  const g = (metadata.guard ?? {}) as { abuse?: unknown; offTopic?: unknown };
  return { abuse: Number(g.abuse) || 0, offTopic: Number(g.offTopic) || 0 };
}

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
    /** The top-level category, for lessons and ratings that are about a topic. */
    categoryId?: string | null;
    /** What the app that raised the ticket sent with it, for the prompt. */
    context?: string | null;
  };
  customer: { name: string; type: string };
  language: string | null;
  unconfidentTurnsBefore: number;
  conversationId: string | null;
  /** Fills company tools' customer argument; null leaves those tools refusing. */
  customerEmail: string | null;
  /** Dry run: read tools only, nothing stored. */
  dryRun: boolean;
  /** Follow-up after an approval decision: the action's result and the reason the customer is told. */
  update: { tool: string; status: 'done' | 'rejected'; detail: string; reason: string } | null;
  /** The outcome being reported was confirmed by a company system. */
  confirmedByTool: boolean;
  /**
   * The customer asked for a person and is being helped first: the model
   * answers what they wrote and says a colleague is available.
   */
  personAsked?: boolean;
  /** The integration whose ticket this is: answers are only reused within one. */
  integration?: string | null;
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
  /** The model says the message has nothing to do with the company. */
  offTopic: boolean;
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
/**
 * Channels where the customer reads our answers where they wrote (a chat, a
 * request page inside an app, their mailbox): a handover tells them who will answer.
 */
const HANDOVER_NOTICE_CHANNELS = new Set(['webchat', 'whatsapp', 'api', 'email']);
/** Channels where a draft leaves the customer waiting in silence (a call never drafts; an app shows its request page). */
const WAITING_CHANNELS = new Set(['webchat', 'whatsapp', 'api']);

/** Whether the last thing the customer was sent is our "a person will reply" message. */
function toldToWait(rows: Array<{ direction: string; metadata: unknown }>): boolean {
  const last = [...rows].reverse().find((m) => m.direction === 'outbound');
  return (last?.metadata as { holding?: boolean } | null)?.holding === true;
}

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
    private readonly tools: ToolsService,
    private readonly branding: BrandingService,
    private readonly gateway: ToolGatewayService,
    private readonly approvals: ApprovalsService,
    private readonly handover: HandoverService,
    private readonly learning: LearningService,
    private readonly autoResolve: AiAutoResolveService,
    private readonly fast: AiFastPathsService,
  ) {}

  /** Answers the conversation's unanswered customer message(s), if the AI still owns it. */
  async runTurn(conversationId: string, triggerMessageId: string | null): Promise<AiDecision> {
    return this.withLock(conversationId, () => this.turn(conversationId, triggerMessageId));
  }

  /**
   * After a colleague decides on a transactional tool call (or it expires):
   * runs the approved action, then tells the customer the outcome and the
   * reason given with the decision, in the channel they wrote on, and asks
   * whether anything else is needed. No person is called in for that:
   * - the AI owns the conversation: it writes the message (a fixed one if the
   *   model fails);
   * - nobody has picked the conversation up: a fixed message with the outcome
   *   and the reason;
   * - a person has taken it over: a note for them, since they are talking to
   *   the customer.
   * Idempotent per approval.
   */
  async followUp(approvalId: string): Promise<AiDecision> {
    const { approval, call, tool } = await this.approvals.withCall(approvalId);
    if (approval.status === 'pending' || (await this.runs.followedUp(approvalId))) return 'skipped';

    let outcome: FollowUpOutcome;
    if (approval.status === 'approved') {
      const ex = await this.gateway.executeApproved(SYSTEM_CTX, call.id);
      outcome =
        ex.status === 'ok'
          ? { status: 'done', detail: JSON.stringify(ex.result ?? {}).slice(0, 2000) }
          : ex.status === 'running'
            ? { status: 'running', detail: '' }
            : { status: 'failed', detail: ex.error ?? 'The action failed' };
    } else if (approval.status === 'rejected') {
      outcome = { status: 'rejected', detail: '' };
    } else {
      outcome = { status: 'expired', detail: '' };
    }
    /** What the colleague wrote for the customer. Their internal note is for the ticket's notes only. */
    const reason = approval.reason?.trim() ?? '';
    const decided = outcome.status === 'done' || outcome.status === 'rejected';

    const action = tool.title ?? tool.name;
    const conv = approval.conversationId
      ? await this.conversations.get(approval.conversationId).catch(() => null)
      : null;
    const behaviour = await this.behaviour.get();
    const mode = conv
      ? ((behaviour.channels as Record<string, AiChannelMode>)[conv.channel] ?? 'off')
      : 'off';
    const summaryLine = { name: tool.name, summary: `${approval.summary} → ${outcome.status}` };
    // Handed over and still waiting for someone: the outcome needs no judgement, so the
    // customer is told it as it is, without taking the conversation back from the queue.
    if (conv && conv.controller === 'none' && mode === 'auto' && decided) {
      return this.db.transaction(async (tx) => {
        if (await this.runs.followedUp(approvalId)) return 'skipped';
        const message = await this.outbound.aiReply(
          AI_CTX,
          conv.id,
          approvalOutcomeMessage(conv.language ?? null, {
            action,
            status: outcome.status as 'done' | 'rejected',
            reason,
          }),
          { draft: false, notice: true },
          tx,
        );
        await this.runs.record(tx, {
          kind: 'followup',
          ticketId: approval.ticketId,
          conversationId: conv.id,
          triggerMessageId: approvalId,
          decision: 'sent',
          confidence: 1,
          promptVersion: AGENT_PROMPT_VERSION,
          tools: [summaryLine],
          replyMessageId: message.id,
          language: conv.language ?? null,
        });
        return 'sent';
      });
    }
    if (!conv || conv.controller !== 'ai' || mode === 'off' || outcome.status === 'running') {
      await this.db.transaction(async (tx) => {
        await this.tickets.addNoteInTx(
          tx,
          AI_CTX,
          approval.ticketId,
          followUpNote(approval.summary, outcome, reason, approval.note),
        );
        await this.runs.record(tx, {
          kind: 'followup',
          ticketId: approval.ticketId,
          conversationId: conv?.id ?? null,
          triggerMessageId: approvalId,
          decision: 'skipped',
          promptVersion: AGENT_PROMPT_VERSION,
          tools: [summaryLine],
        });
      });
      return 'skipped';
    }

    return this.withLock(conv.id, async () => {
      if (await this.runs.followedUp(approvalId)) return 'skipped';
      const ticket = await this.tickets.get(conv.ticketId);
      const customer = await this.customers.get(ticket.customerId);
      const rows = await this.conversations.transcript(conv.id, 30);
      const lastCustomer = [...rows].reverse().find((m) => m.authorType === 'customer');
      const language = conv.language ?? null;
      let r: ThinkResult;
      if (outcome.status === 'done' || outcome.status === 'rejected') {
        r = await this.think({
          channel: conv.channel,
          mode,
          behaviour,
          transcript: rows
            .filter((m) => m.authorType !== 'system')
            .slice(-HISTORY_TAIL)
            .map((m) => ({ author: m.authorType as Line['author'], body: m.body })),
          summary: conv.summary,
          ticket: {
            id: ticket.id,
            reference: ticket.reference,
            subject: ticket.subject,
            status: ticket.status,
            category: ticket.category?.name ?? null,
            categoryId: ticket.category?.id ?? null,
            context: ticketContext(ticket),
          },
          customer: { name: customer.displayName, type: customer.customerType },
          language,
          unconfidentTurnsBefore: 0,
          conversationId: conv.id,
          customerEmail: boundEmail(ticket, customer, conv),
          dryRun: false,
          // The reason was written for the customer. The colleague's internal note is not
          // passed on: it stays in the approval and the ticket's notes.
          update: {
            tool: action,
            status: outcome.status,
            detail: outcome.status === 'done' ? outcome.detail : '',
            reason,
          },
          confirmedByTool: outcome.status === 'done',
        });
        // The decision is made and the reason given: there is nothing for a person to add.
        // If the model did not produce a message, the fixed one says the same.
        if (r.decision !== 'sent' && r.decision !== 'drafted') {
          r = {
            ...r,
            decision: mode === 'auto' ? 'sent' : 'drafted',
            reply: approvalOutcomeMessage(language, { action, status: outcome.status, reason }),
            confidence: 1,
            rules: mode === 'auto' ? [] : ['draft_channel'],
            handoverReason: null,
          };
        }
        // The request is settled either way: ask whether anything else is needed.
        r.resolves = true;
      } else {
        r = {
          ...blankResult(language),
          rules: [outcome.status === 'expired' ? 'approval_expired' : 'action_failed'],
          handoverReason: outcome.detail || null,
        };
      }
      r.tools = [summaryLine, ...r.tools];
      return this.apply({
        conv,
        ticket,
        r,
        language,
        lastCustomerBody: lastCustomer?.body ?? '',
        aiReplies: rows.filter((m) => m.authorType === 'ai').length,
        toldToWait: toldToWait(rows),
        mode,
        behaviour,
        triggerMessageId: approvalId,
        kind: 'followup',
      });
    });
  }

  private async withLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `tms:lock:ai:${conversationId}`;
    const token = `${process.pid}:${Date.now()}`;
    if ((await this.redis.set(lockKey, token, 'PX', LOCK_MS, 'NX')) !== 'OK')
      throw new ConversationBusyError();
    try {
      return await fn();
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
      customerEmail: input.customerEmail ?? null,
      dryRun: true,
      update: null,
      confirmedByTool: false,
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

    // "Is there anything else?" answered with a no: nothing for a model to do. The same
    // goes for a "thanks" after the goodbye, which should not start the conversation again.
    const previous = rows.at(-2);
    const said = previous?.metadata as {
      closing?: boolean;
      ai?: { closingQuestion?: boolean };
    } | null;
    if (
      mode === 'auto' &&
      previous?.direction === 'outbound' &&
      (said?.ai?.closingQuestion || said?.closing) &&
      declinesMoreHelp(lastRow.body)
    ) {
      const done = await this.autoResolve.customerConfirmed({
        ticketId: conv.ticketId,
        conversationId: conv.id,
        channel: conv.channel,
        language: conv.language ?? null,
        triggerMessageId,
        silent: !said?.ai?.closingQuestion,
      });
      if (done !== 'skipped') return done;
    }

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
    const send = (r: ThinkResult) =>
      this.apply({
        conv,
        ticket,
        r,
        language,
        lastCustomerBody: lastRow.body,
        aiReplies: rows.filter((m) => m.authorType === 'ai').length,
        toldToWait: toldToWait(rows),
        mode,
        behaviour,
        triggerMessageId,
        kind: 'turn',
      });
    /** A reply that needs no model: fixed wording, sent as it is. */
    const fixed = (reply: string, rules: AiRule[], summary: string): ThinkResult => ({
      ...blankResult(language),
      decision: 'sent',
      reply,
      confidence: 1,
      selfConfidence: 1,
      rules,
      tools: [{ name: 'no_model', summary }],
    });
    // Where the AI answers by itself in a place the customer is reading: only there does it
    // warn, offer or close on its own. Elsewhere (email, drafts) a person decides, and a
    // caller on the phone is put through.
    const live = mode === 'auto' && !BY_EMAIL.has(conv.channel) && conv.channel !== 'voice';
    const guard = behaviour.guardrails;
    const strikes = guardState(conv.metadata);
    const flagged = () =>
      this.customers.flaggedSince(customer.id, new Date(Date.now() - guard.flagHours * 3_600_000));
    const endFor = (closure: ConductClosure, hit: GuardHit | null, repeat: boolean) =>
      this.autoResolve.closeForConduct({
        ticketId: ticket.id,
        conversationId: conv.id,
        customerId: customer.id,
        language,
        closure,
        pattern: hit?.pattern ?? null,
        rules: [CONDUCT_RULE[closure], ...(repeat ? (['repeat_offender'] as AiRule[]) : [])],
        // An attempt on the AI's instructions is flagged; so is someone closed twice.
        flag: closure === 'jailbreak' || closure === 'abuse' || repeat,
        triggerMessageId,
      });

    // ---- Conduct: what the message is, before any model sees it (ADR 0029) ----
    if (guard.enabled && conv.channel !== 'voice') {
      const earlier = rows
        .slice(0, -1)
        .filter((m) => m.authorType === 'customer')
        .map((m) => m.body);
      const hit = screenInbound(lastRow.body, earlier);
      // Someone flagged recently gets no benefit of the doubt and no second warning.
      const repeat = hit ? await flagged() : false;
      if (hit && (hit.strength === 'strong' || repeat)) {
        if (!live) {
          return send({
            ...blankResult(language),
            rules: [CONDUCT_RULE[hit.kind]],
            handoverReason: `The message matched the guard pattern "${hit.pattern}"`,
          });
        }
        const count = strikes.abuse + 1;
        const close =
          repeat || (hit.kind === 'jailbreak' ? guard.closeOnJailbreak : count >= guard.abuseLimit);
        if (close) {
          const done = await endFor(hit.kind, hit, repeat);
          if (done !== 'skipped') return done;
        } else if (hit.kind !== 'jailbreak') {
          await this.conversations.updateAiState(this.db, conv.id, {
            metadata: { guard: { ...strikes, abuse: count } },
          });
          return send(
            fixed(
              conductWarning(language, hit.kind),
              [CONDUCT_RULE[hit.kind]],
              `Warned the customer (${hit.kind}, ${count} of ${guard.abuseLimit}); no model was asked`,
            ),
          );
        }
        // An attempt on the instructions with closing switched off goes to the model, where
        // the customer's text is data like any other.
      }
    }

    // ---- A request for a person: the AI offers to sort it out first (ADR 0029) ----
    const offered = (previous?.metadata as { ai?: { personOffer?: boolean } } | null)?.ai
      ?.personOffer;
    const insists = !!offered && acceptsOffer(lastRow.body);
    let personAsked = false;
    if ((asksForHuman(lastRow.body) || insists) && live) {
      const asks = Number(conv.metadata.humanAsks ?? 0) + 1;
      await this.conversations.updateAiState(this.db, conv.id, { metadata: { humanAsks: asks } });
      if (insists || asks >= behaviour.handover.personRequestsBeforeHandover) {
        return send({ ...blankResult(language), rules: ['asked_for_human'] });
      }
      if (lastRow.body.trim().length <= PERSON_ONLY_CHARS) {
        return send(
          fixed(
            personOffer(language),
            ['person_offered'],
            'The customer asked for a person: offered to sort it out first; no model was asked',
          ),
        );
      }
      // They said what it is about as well: answer that, and say a colleague is available.
      personAsked = true;
    }

    const unconfidentBefore = await this.runs.unconfidentTurns(
      conv.id,
      behaviour.sendAt,
      lastHandover,
    );
    let r = await this.think({
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
        categoryId: ticket.category?.id ?? null,
        context: ticketContext(ticket),
      },
      customer: { name: customer.displayName, type: customer.customerType },
      language,
      unconfidentTurnsBefore: unconfidentBefore,
      conversationId: conv.id,
      customerEmail: boundEmail(ticket, customer, conv),
      dryRun: false,
      update: null,
      confirmedByTool: false,
      personAsked,
      integration: ticket.integration?.slug ?? null,
    });
    if (personAsked && r.decision === 'sent') r.rules = [...r.rules, 'person_offered'];

    // ---- Nothing to do with the company: a redirect, a warning, then closed ----
    if (r.offTopic && guard.enabled && live && r.decision === 'sent') {
      const count = strikes.offTopic + 1;
      const repeat = await flagged();
      if (repeat || count >= guard.offTopicLimit) {
        const done = await endFor('off_topic', null, repeat);
        if (done !== 'skipped') return done;
      }
      await this.conversations.updateAiState(this.db, conv.id, {
        metadata: { guard: { ...strikes, offTopic: count } },
      });
      r.rules = [...r.rules, 'off_topic'];
      r.resolves = false;
      if (count === guard.offTopicLimit - 1 && r.reply) {
        r.reply = `${r.reply}\n\n${offTopicWarning(language)}`;
      }
    }

    // ---- Unsure: ask the customer to say more before giving up on them ----
    // A person is for when the AI has tried and failed, not for its first doubt.
    const unsure =
      r.decision === 'handover' &&
      r.rules.length > 0 &&
      r.rules.every((rule) => rule === 'low_confidence' || rule === 'no_answer');
    if (unsure && live && unconfidentBefore + 1 < behaviour.maxFailedTurns) {
      r = {
        ...r,
        decision: 'sent',
        reply: clarifyMessage(language),
        // Stays below the send threshold on record, so it counts towards "tried and failed".
        confidence: Math.min(r.confidence ?? 0, Math.max(0, behaviour.sendAt - 0.01)),
        rules: ['clarifying'],
        handoverReason: null,
        resolves: false,
      };
    }

    return send(r);
  }

  /** Sends, drafts or hands over as the turn decided, and records the run, in one transaction. */
  private async apply(p: {
    conv: { id: string; channel: string };
    ticket: { id: string; reference: string };
    r: ThinkResult;
    language: string | null;
    lastCustomerBody: string;
    aiReplies: number;
    /** The customer already has our "a person will reply" message and no answer since. */
    toldToWait: boolean;
    mode: AiChannelMode;
    behaviour: AiBehaviour;
    triggerMessageId: string | null;
    kind: 'turn' | 'followup';
  }): Promise<AiDecision> {
    const { conv, ticket, r, language, mode, behaviour, triggerMessageId } = p;
    if (Object.keys(r.ticketUpdate).length && r.decision !== 'error') {
      await this.applyTicketUpdate(ticket.id, r.ticketUpdate).catch((err: Error) =>
        this.logger.warn(`AI ticket update failed on ${ticket.reference}: ${err.message}`),
      );
    }

    const replyLanguage = r.language ?? language;
    const decision = await this.db.transaction(async (tx): Promise<AiDecision> => {
      // A person may have taken over while the model was thinking: then the AI stays quiet.
      const current = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        conv.id,
      );
      if (current.controller !== 'ai') {
        await this.runs.record(tx, {
          kind: p.kind,
          ticketId: ticket.id,
          conversationId: conv.id,
          triggerMessageId,
          decision: 'skipped',
          confidence: r.confidence,
          rules: [],
          model: r.model,
          promptVersion: AGENT_PROMPT_VERSION,
          tools: r.tools,
          sources: r.sources,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
          error: 'A person took the conversation over before the AI answered',
        });
        return 'skipped';
      }
      let replyMessageId: string | null = null;
      if ((r.decision === 'sent' || r.decision === 'drafted') && r.reply) {
        // The draft waits for a person; say so once, instead of leaving a live chat silent.
        // Written first, so the draft stays the last thing in the agent's timeline.
        if (
          r.decision === 'drafted' &&
          mode === 'auto' &&
          WAITING_CHANNELS.has(conv.channel) &&
          !p.toldToWait
        ) {
          await this.outbound.holdingReply(tx, conv.id, waitingMessage(replyLanguage));
        }
        // An answer that settles the request ends by asking whether anything else is needed.
        const asks =
          r.decision === 'sent' &&
          r.resolves &&
          behaviour.closing.askAnythingElse &&
          mode === 'auto';
        const message = await this.outbound.aiReply(
          AI_CTX,
          conv.id,
          asks
            ? withClosingQuestion(r.reply, closingQuestion(replyLanguage, conv.channel))
            : r.reply,
          {
            draft: r.decision === 'drafted',
            metadata: {
              ai: {
                confidence: r.confidence,
                rules: r.rules,
                sources: r.sources,
                ...(asks ? { closingQuestion: true } : {}),
                ...(r.rules.includes('person_offered') ? { personOffer: true } : {}),
              },
            },
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
        await this.tickets.setHandling(tx, ticket.id, 'handed_over');
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
            lastCustomerMessage: p.lastCustomerBody,
            aiReplies: p.aiReplies,
            sources: r.seenSources,
            draft: r.reply,
          }),
        );
        // A caller hears it now. On the other channels the customer is told once
        // routing has chosen who answers, so the message can name them (HandoverHandler).
        if (conv.channel === 'voice' && mode === 'auto') {
          const m = await this.outbound.aiReply(
            AI_CTX,
            conv.id,
            handoverMessage(replyLanguage, conv.channel),
            { draft: false, notice: true },
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
        // Routing and the context pack follow in the worker.
        await this.handover.createInTx(tx, AI_CTX, {
          ticketId: ticket.id,
          conversationId: conv.id,
          source: r.rules.includes('asked_for_human') ? 'customer' : 'ai',
          reason: reasons.join('; '),
          rules: r.rules,
          tellCustomer: HANDOVER_NOTICE_CHANNELS.has(conv.channel) && mode === 'auto',
        });
      }
      await this.conversations.updateAiState(tx, conv.id, {
        language: replyLanguage,
        ...(r.decision === 'handover' || r.decision === 'error'
          ? { metadata: { lastHandoverAt: new Date().toISOString() } }
          : {}),
      });
      await this.runs.record(tx, {
        kind: p.kind,
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
      return r.decision;
    });
    this.logger.log(`AI ${decision} on ${ticket.reference} (confidence ${r.confidence ?? '–'})`);
    return decision;
  }

  /** The model loop, shared by live turns and dry runs. No side effects beyond LLM calls and searches. */
  private async think(i: ThinkInput): Promise<ThinkResult> {
    const started = Date.now();
    const out: ThinkResult = blankResult(i.language);
    const finish = () => ({ ...out, latencyMs: Date.now() - started });
    const last = [...i.transcript].reverse().find((l) => l.author === 'customer')?.body ?? '';

    if (asksForHuman(last) && !i.personAsked) {
      out.rules = ['asked_for_human'];
      return finish();
    }

    // ---- Answers that need no model (ADR 0030). An email wants an email, so not there. ----
    const paths = i.behaviour.fastPaths;
    const quick = !i.update && !i.personAsked && !BY_EMAIL.has(i.channel);
    const customerLines = i.transcript.filter((l) => l.author === 'customer').length;
    /** The opening question of a conversation with nothing attached: the same for anyone who asks it. */
    const general = quick && customerLines === 1 && !i.summary && !i.ticket.context;
    const scope = `${AGENT_PROMPT_VERSION}|${i.integration ?? '-'}|${i.channel}|${i.language ?? '-'}`;
    let fast: FastAnswer | null = null;
    const talk = quick && paths.smallTalk ? smallTalk(last) : null;
    if (talk) {
      fast = {
        route: 'smalltalk',
        reply: smallTalkReply(talk, i.language),
        confidence: 1,
        intent: talk,
        resolves: talk === 'thanks',
        sources: [],
        summary: `A ${talk === 'help' ? 'request with no question in it' : talk}: fixed reply; no model was asked`,
      };
    }
    if (!fast && quick) fast = await this.fast.faq(last, paths, { ticketId: i.ticket.id });
    if (!fast && general) fast = await this.fast.cached(last, scope, paths);

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

    // A follow-up reports a decision; the last question was answered in an earlier turn.
    const knowledge = i.update || fast ? [] : await search(last, 3).catch(() => []);
    // The list is only needed to choose a category; a ticket that has one saves the tokens.
    const categories = i.ticket.category ? [] : await this.categoryLabels();
    // What staff taught the AI after reading customer ratings (ADR 0020).
    const lessons = await this.learning
      .lessonsFor(i.ticket.categoryId ?? null)
      .catch(() => [] as string[]);
    const allTools: AgentTool[] = fast ? [] : await this.tools.agentTools().catch(() => []);
    // Tools that act for a customer are refused without one the channel vouched for: leaving
    // them out saves their descriptions on every step, and the model a call that cannot work.
    const companyTools = allTools.filter((t) => i.customerEmail || !t.tool.customerArg);
    const builtIn = AGENT_TOOLS.filter(
      (t) => !(t.type === 'function' && t.function.name === 'update_ticket') || !i.ticket.category,
    );
    let usedCompanyTool = false;
    /** A company system answered this turn: what it said may be passed on. */
    let readByTool = false;
    /** Company-system results the reply may rest on; they count as sources. */
    const toolSources: Array<{ chunkId: string; label: string }> = [];
    if (i.update)
      toolSources.push({ chunkId: 'approval', label: `${i.update.tool} · ${i.update.status}` });
    let confirmed = i.confirmedByTool;
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: agentSystemPrompt({
          company: await this.branding.get(),
          channel: i.channel,
          language: i.language,
          customer: i.customer,
          ticket: i.ticket,
          summary: i.summary,
          knowledge: knowledge.map((k) => ({ id: k.id, label: k.source, text: k.text })),
          categories,
          companyTools: companyTools.length > 0,
          unverified: allTools.length > companyTools.length,
          personAsked: !!i.personAsked,
          update: i.update,
          lessons,
        }),
      },
      ...i.transcript.map<ChatCompletionMessageParam>((l) =>
        l.author === 'customer'
          ? { role: 'user', content: customerTurn(l.body) }
          : { role: 'assistant', content: l.body },
      ),
      ...(i.update ? [{ role: 'user' as const, content: APPROVAL_UPDATE_TURN }] : []),
    ];

    let final:
      | { kind: 'reply'; args: ReturnType<typeof sendReplyArgs.parse> }
      | { kind: 'human'; reason: string }
      | null = null;
    if (fast) {
      final = {
        kind: 'reply',
        args: sendReplyArgs.parse({
          message: fast.reply,
          confidence: fast.confidence,
          intent: fast.intent,
          resolves_issue: fast.resolves,
        }),
      };
      toolSources.push(...fast.sources);
      out.tools.push({ name: 'no_model', summary: fast.summary });
    }
    /** An answer the model gave as plain text; it is asked once to send it with the reply tool. */
    let plain: string | null = null;
    for (let step = 0; step < i.behaviour.maxSteps && !final; step++) {
      let completion;
      try {
        const r = await this.llm.chat({
          role: i.channel === 'voice' ? 'chat_agent_voice' : 'chat_agent',
          messages,
          tools: [...builtIn, ...companyTools.map((t) => t.definition)],
          // The reply is short; the rest is room for models that reason before they answer.
          maxTokens: 1200,
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
        const text = msg?.content?.trim() || null;
        if (text && plain === null && step + 1 < i.behaviour.maxSteps) {
          plain = text;
          messages.push(
            { role: 'assistant', content: text },
            { role: 'user', content: REPLY_TOOL_REMINDER },
          );
          continue;
        }
        // Still plain text (or nothing): the answer stands without a confidence of its own.
        plain = text ?? plain;
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
          const ct = companyTools.find((t) => t.qualifiedName === name);
          if (!ct) {
            result = { error: `Unknown tool ${name}` };
          } else {
            const res = await this.gateway.invoke(AI_CTX, {
              tool: ct.tool,
              server: ct.server,
              args: call.function.arguments,
              ticketId: i.ticket.id,
              conversationId: i.conversationId,
              customerEmail: i.customerEmail,
              reasoning: msg?.content?.trim() || null,
              evidence: last,
              dryRun: i.dryRun,
            });
            result = forModel(res);
            out.tools.push({
              name: ct.tool.name,
              summary: toolSummary(res, call.function.arguments, ct.tool.customerArg),
            });
            // A result, or a request the system accepted for approval, is something to stand on.
            if (res.status === 'ok' || res.status === 'awaiting_approval') {
              toolSources.push({
                chunkId: `tool:${res.callId ?? ct.tool.id}`,
                label: `${ct.server.name} · ${ct.tool.title ?? ct.tool.name}`,
              });
            }
            if (res.status === 'ok' && ct.tool.tier !== 'read') confirmed = true;
            if (res.status === 'ok') readByTool = true;
            usedCompanyTool = true;
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }

    out.seenSources = [...new Set(labels.values())];
    if (!final && plain) {
      final = { kind: 'reply', args: sendReplyArgs.parse({ message: plain }) };
    }
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
    // Customers rated answers like this one badly: a person sees it before the customer does.
    const caution = await this.learning
      .cautionFor({ categoryId: i.ticket.categoryId ?? null, chunkIds: cited })
      .catch(() => []);
    const grounded = cited.length + toolSources.length > 0;
    const verdict = assess({
      // A model that gave no confidence is judged on what it stood on: with a source it is
      // sent, without one a person sees it first. It used to count as 0.5 either way.
      selfConfidence: a.confidence ?? (grounded ? i.behaviour.sendAt : i.behaviour.handoverBelow),
      reply: a.message,
      citedSources: cited.length + toolSources.length,
      confirmedByTool: confirmed,
      readByTool,
      unconfidentTurnsBefore: i.unconfidentTurnsBefore,
      mode: i.mode,
      behaviour: i.behaviour,
      spoken: i.channel === 'voice',
      poorFeedback: caution.length > 0,
    });
    if (verdict.rules.includes('poor_feedback')) {
      out.tools.push({ name: 'feedback', summary: caution.map(cautionText).join('; ') });
    }
    out.decision = verdict.decision;
    out.confidence = verdict.confidence;
    out.selfConfidence = a.confidence ?? null;
    out.rules = verdict.rules;
    // An unsafe reply is not sent, drafted or quoted in the handover note.
    out.reply = verdict.rules.includes('unsafe_output') ? null : a.message || null;
    out.language = a.language?.split('-')[0] ?? i.language;
    out.intent = a.intent ?? null;
    out.resolves = !!a.resolves_issue;
    out.offTopic = !!a.off_topic;
    out.sources = [...cited.map((id) => ({ chunkId: id, label: labels.get(id)! })), ...toolSources];
    if (fast) {
      if (!i.dryRun) await this.fast.count(fast.route);
    } else if (
      general &&
      !i.dryRun &&
      out.decision === 'sent' &&
      out.resolves &&
      !out.offTopic &&
      cited.length > 0 &&
      !usedCompanyTool &&
      out.reply
    ) {
      // A sourced answer to an opening question: the next person who asks it gets this one.
      await this.fast.remember(last, scope, paths, {
        reply: out.reply,
        confidence: verdict.confidence,
        intent: out.intent,
        sources: out.sources,
      });
    }
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
    const tree = await this.org.activeCategories().catch(() => []);
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
    const tree = await this.org.activeCategories();
    const cat = tree.find((c) => c.name.toLowerCase() === catName);
    if (!cat) return null;
    const sub = subName ? cat.children.find((s) => s.name.toLowerCase() === subName) : undefined;
    return { categoryId: cat.id, subcategoryId: sub?.id ?? null };
  }
}

/**
 * The email customer-bound tools act for (ADR 0028). On a ticket of an
 * integration, only a person the app itself has named (its own id for them:
 * a ticket it raised for them, or a chat with a signed identity) is acted
 * for. An address a visitor typed into the app's chat proves nothing, and
 * must not open someone else's orders.
 *
 * The same holds without an integration: on a web chat the email is acted
 * for only when the chat itself vouched for the visitor (a signed identity),
 * never when an anonymous visitor typed it.
 */
function boundEmail(
  ticket: { integration: { slug: string } | null },
  customer: Parameters<typeof emailOf>[0],
  conv: { channel: string; metadata: Record<string, unknown> },
): string | null {
  if (ticket.integration) {
    const prefix = `${ticket.integration.slug}:`;
    const named = customer.identities.some(
      (x) => x.type === 'external_id' && x.value.startsWith(prefix),
    );
    if (!named) return null;
  } else if (conv.channel === 'webchat') {
    const vouched = conv.metadata.identity;
    if (vouched !== 'email' && vouched !== 'external_id') return null;
  }
  return emailOf(customer);
}

function emailOf(customer: {
  primaryEmail: string | null;
  identities: Array<{ type: string; value: string }>;
}): string | null {
  return (
    customer.primaryEmail ?? customer.identities.find((x) => x.type === 'email')?.value ?? null
  );
}

function toolSummary(r: InvokeResult, rawArgs: string, customerArg: string | null): string {
  let args = '';
  try {
    args = describeArgs(JSON.parse(rawArgs || '{}') as Record<string, unknown>, [
      customerArg ?? '',
    ]);
  } catch {
    args = '';
  }
  const outcome =
    r.status === 'ok'
      ? 'done'
      : r.status === 'awaiting_approval'
        ? 'sent for approval'
        : r.status === 'simulated'
          ? 'not run (dry run)'
          : `${r.status}: ${r.error}`;
  return `${args ? `${args} → ` : ''}${outcome}`.slice(0, 200);
}

type FollowUpOutcome = {
  status: 'done' | 'rejected' | 'failed' | 'expired' | 'running';
  detail: string;
};

function followUpNote(
  summary: string,
  o: FollowUpOutcome,
  reason = '',
  internalNote: string | null = null,
): string {
  const what = {
    done: 'was approved and done',
    rejected: 'was not approved',
    failed: 'was approved, but the action failed',
    expired: 'expired before anyone decided',
    running: 'was approved, but its result is unknown (the worker stopped while it ran)',
  }[o.status];
  return [
    `The request "${summary}" ${what}.`,
    reason ? `Reason given for the customer: ${reason}` : '',
    internalNote ? `Internal note: ${internalNote}` : '',
    o.detail ? `Details: ${o.detail}` : '',
    'The AI is not handling this conversation, so please let the customer know.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A turn that did nothing yet: hands over unless the model says otherwise. */
function blankResult(language: string | null): ThinkResult {
  return {
    decision: 'handover',
    reply: null,
    confidence: null,
    selfConfidence: null,
    rules: [],
    handoverReason: null,
    language,
    intent: null,
    resolves: false,
    offTopic: false,
    ticketUpdate: {},
    tools: [],
    sources: [],
    seenSources: [],
    model: null,
    costUsd: 0,
    latencyMs: 0,
    error: null,
  };
}
