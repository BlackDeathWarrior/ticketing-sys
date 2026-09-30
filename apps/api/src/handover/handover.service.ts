import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { type Database, type DbOrTx, handovers, teams, users } from '@tms/db';
import {
  AI_RULE_LABELS,
  type AiRule,
  type ContextPack,
  describeArgs,
  type HandoverSource,
  type HandoverView,
  type RequestHandoverInput,
} from '@tms/shared';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AiRunsService } from '../ai/ai-runs.service';
import { extractJson } from '../ai/json';
import { HANDOVER_PROMPT_VERSION, handoverSystemPrompt } from '../ai/prompts';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { AiPolicyService } from '../channels/ai-policy.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { type Conversation, ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { LlmClientService } from '../llm/llm-client.service';
import { TicketsService } from '../tickets/tickets.service';
import { ToolGatewayService } from '../tools/tool-gateway.service';

const packReply = z.object({
  summary: z.string().trim().min(1).max(1200),
  intent: z.string().trim().max(80).nullable().optional(),
  next_step: z.string().trim().min(1).max(400),
});

/**
 * Who answers a conversation (ADR 0014): people take it over from the AI or
 * the queue, hand it back to the AI, or pass it on; each handover gets a
 * context pack. Changes happen under row locks, so two people can't both
 * take the same conversation.
 */
@Injectable()
export class HandoverService {
  private readonly logger = new Logger(HandoverService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly aiPolicy: AiPolicyService,
    private readonly llm: LlmClientService,
    private readonly runs: AiRunsService,
    private readonly gateway: ToolGatewayService,
  ) {}

  /** The agent answers from now on; the AI stays quiet. */
  async takeOver(ctx: RequestCtx, conversationId: string) {
    const me = ctx.user!.id;
    await this.db.transaction(async (tx) => {
      const conv = await this.conversations.lock(tx, conversationId);
      await this.assertNotSomeoneElses(conv, me);
      const ticket = await this.tickets.lockRow(tx, conv.ticketId);
      await this.conversations.setController(tx, ctx, conv, 'human', me);
      await this.tickets.setHandling(tx, ticket.id, 'human');
      // Whoever takes over owns the ticket from now on.
      if (ticket.assigneeId !== me)
        await this.tickets.assignInTx(tx, ctx, ticket.id, { assigneeId: me });
      await this.tickets.moveVia(tx, ctx, ticket.id, 'in_progress', 'human_assigned');
      await this.audit.record(tx, ctx, {
        action: 'conversation.taken_over',
        targetType: 'ticket',
        targetId: ticket.id,
        data: { conversationId, from: conv.controller },
      });
    });
    return this.conversations.get(conversationId);
  }

  /** The AI answers again (only where it is on and has a model). */
  async handBack(ctx: RequestCtx, conversationId: string) {
    const conv0 = await this.conversations.get(conversationId);
    if (!(await this.aiPolicy.takesNewConversations(conv0.channel))) {
      throw new BadRequestException('The AI is off for this channel or has no model to use');
    }
    await this.db.transaction(async (tx) => {
      const conv = await this.conversations.lock(tx, conversationId);
      if (conv.controller === 'ai') throw new ConflictException('The AI is already answering');
      await this.assertNotSomeoneElses(conv, ctx.user!.id);
      const ticket = await this.tickets.lockRow(tx, conv.ticketId);
      await this.conversations.setController(tx, ctx, conv, 'ai', null);
      await this.tickets.setHandling(tx, ticket.id, 'ai');
      await this.tickets.moveVia(tx, ctx, ticket.id, 'ai_handling', 'human_assigned');
      await this.audit.record(tx, ctx, {
        action: 'conversation.handed_back',
        targetType: 'ticket',
        targetId: ticket.id,
        data: { conversationId },
      });
    });
    return this.conversations.get(conversationId);
  }

  /**
   * An agent passes the ticket on (to the queue, or to a team): nobody
   * controls the conversation until routing or a person picks it up.
   */
  async requestHandover(ctx: RequestCtx, ticketRef: string, input: RequestHandoverInput) {
    const ticket0 = await this.tickets.get(ticketRef);
    if (input.teamId) {
      const [team] = await this.db.select().from(teams).where(eq(teams.id, input.teamId));
      if (!team) throw new BadRequestException('Team not found');
    }
    const convs = await this.conversations.listForTicket(ticket0.id);
    const latest = convs.sort(
      (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
    )[0];
    const id = await this.db.transaction(async (tx) => {
      const ticket = await this.tickets.lockRow(tx, ticket0.id);
      if (latest) {
        const conv = await this.conversations.lock(tx, latest.id);
        await this.conversations.setController(tx, ctx, conv, 'none', null);
      }
      await this.tickets.setHandling(tx, ticket.id, 'handed_over');
      await this.tickets.assignInTx(tx, ctx, ticket.id, {
        assigneeId: null,
        ...(input.teamId ? { teamId: input.teamId } : {}),
      });
      return this.createInTx(tx, ctx, {
        ticketId: ticket.id,
        conversationId: latest?.id ?? null,
        source: 'agent',
        reason: input.reason,
        rules: [],
        teamId: input.teamId ?? null,
      });
    });
    return (await this.forTicket(ticket0.id)).find((h) => h.id === id)!;
  }

  /** Records a handover and asks for routing and a context pack (`handover.requested`). */
  async createInTx(
    tx: DbOrTx,
    ctx: RequestCtx,
    h: {
      ticketId: string;
      conversationId: string | null;
      source: HandoverSource;
      reason: string;
      rules: string[];
      teamId?: string | null;
    },
  ): Promise<string> {
    const [row] = await tx
      .insert(handovers)
      .values({
        ticketId: h.ticketId,
        conversationId: h.conversationId,
        source: h.source,
        reason: h.reason.slice(0, 500),
        rules: h.rules,
        requestedBy: ctx.user?.id ?? null,
      })
      .returning({ id: handovers.id });
    const data = {
      handoverId: row!.id,
      conversationId: h.conversationId,
      source: h.source,
      reason: h.reason,
      rules: h.rules,
      teamId: h.teamId ?? null,
    };
    await this.audit.record(tx, ctx, {
      action: 'handover.requested',
      targetType: 'ticket',
      targetId: h.ticketId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'handover.requested',
      aggregateType: 'ticket',
      aggregateId: h.ticketId,
      payload: data,
    });
    return row!.id;
  }

  async get(id: string) {
    const [h] = await this.db.select().from(handovers).where(eq(handovers.id, id));
    if (!h) throw new NotFoundException('Handover not found');
    return h;
  }

  async setRouted(id: string, teamId: string | null, userId: string | null) {
    await this.db
      .update(handovers)
      .set({ routedTeamId: teamId, routedUserId: userId })
      .where(eq(handovers.id, id));
  }

  /**
   * Writes the context pack: facts gathered from the ticket, the
   * conversation, AI runs and tool calls, plus a summary and next step from
   * the `summarizer` role (a template when no model answers).
   */
  async buildPack(handoverId: string): Promise<ContextPack> {
    const h = await this.get(handoverId);
    const ticket = await this.tickets.get(h.ticketId);
    const customer = await this.customers.get(ticket.customerId).catch(() => null);
    const transcript = h.conversationId
      ? await this.conversations.transcript(h.conversationId, 30)
      : [];
    const runs = await this.runs.forTicket(ticket.id);
    const calls = await this.gateway.callsForTicket(ticket.id);

    const aiReplies = transcript.filter((m) => m.authorType === 'ai').length;
    const actions = [
      ...(aiReplies ? [`The AI sent ${aiReplies} repl${aiReplies === 1 ? 'y' : 'ies'}`] : []),
      ...calls.map(
        (c) =>
          `${c.tool.title ?? c.tool.name}: ${describeArgs(c.args, c.tool.customerArg ? [c.tool.customerArg] : []) || 'no details'} → ${c.status.replace(/_/g, ' ')}`,
      ),
    ].slice(0, 12);
    const retrieved = [
      ...new Set(runs.flatMap((r) => r.sources.map((s) => s.label))),
      ...calls
        .filter((c) => c.status === 'ok' && c.result)
        .map((c) => `${c.tool.title ?? c.tool.name}: ${JSON.stringify(c.result).slice(0, 160)}`),
    ].slice(0, 10);
    const lastIntent = runs.find((r) => r.intent)?.intent ?? null;
    const email =
      customer?.primaryEmail ?? customer?.identities.find((i) => i.type === 'email')?.value ?? null;

    let summary = fallbackSummary(transcript, ticket.subject);
    let intent = lastIntent;
    let next = fallbackNextStep(h.rules as AiRule[], h.reason);
    let writtenBy: ContextPack['writtenBy'] = 'rules';
    try {
      const r = await this.llm.chat({
        role: 'summarizer',
        messages: [
          { role: 'system', content: handoverSystemPrompt() },
          {
            role: 'user',
            content: [
              `Handover reason: ${h.reason}`,
              ...transcript.map((m) => {
                const tag = m.authorType === 'customer' ? 'customer' : 'reply';
                return `<${tag}>${m.body.slice(0, 1200)}</${tag}>`;
              }),
              ...actions.map((a) => `<action>${a}</action>`),
            ].join('\n'),
          },
        ],
        maxTokens: 350,
        ticketId: ticket.id,
        conversationId: h.conversationId,
      });
      const parsed = packReply.safeParse(
        extractJson(r.completion.choices[0]?.message.content ?? ''),
      );
      if (parsed.success) {
        summary = parsed.data.summary;
        intent = parsed.data.intent ?? intent;
        next = parsed.data.next_step;
        writtenBy = 'model';
      }
    } catch (err) {
      this.logger.warn(
        `context pack for ${ticket.reference} fell back to rules: ${(err as Error).message}`,
      );
    }

    const pack: ContextPack = {
      summary,
      intent,
      customer: {
        name: ticket.customer.displayName,
        type: ticket.customer.customerType,
        email,
        ticketCount: customer?.recentTickets.length ?? 1,
      },
      ticket: {
        reference: ticket.reference,
        subject: ticket.subject,
        priority: ticket.priority,
        category: ticket.category?.id
          ? `${ticket.category.name}${ticket.subcategory?.id ? ` › ${ticket.subcategory.name}` : ''}`
          : null,
      },
      actions,
      retrieved,
      recommendedNextStep: next,
      writtenBy,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .update(handovers)
        .set({ pack: pack as unknown as Record<string, unknown>, packStatus: 'ready' })
        .where(eq(handovers.id, h.id));
      const data = { handoverId: h.id, writtenBy, promptVersion: HANDOVER_PROMPT_VERSION };
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'handover.context_ready',
        targetType: 'ticket',
        targetId: ticket.id,
        data,
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'handover.context_ready',
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        payload: data,
      });
    });
    return pack;
  }

  async forTicket(ticketRef: string): Promise<HandoverView[]> {
    const ticket = await this.tickets.get(ticketRef);
    const rows = await this.db
      .select()
      .from(handovers)
      .where(eq(handovers.ticketId, ticket.id))
      .orderBy(desc(handovers.createdAt));
    const people = await this.db.select({ id: users.id, name: users.name }).from(users);
    const teamRows = await this.db.select({ id: teams.id, name: teams.name }).from(teams);
    const person = (id: string | null) => (id ? (people.find((p) => p.id === id) ?? null) : null);
    return rows.map((h) => ({
      id: h.id,
      ticketId: h.ticketId,
      conversationId: h.conversationId,
      source: h.source as HandoverSource,
      reason: h.reason,
      rules: h.rules,
      pack: (h.pack as ContextPack | null) ?? null,
      packStatus: h.packStatus as HandoverView['packStatus'],
      routedTeam: h.routedTeamId ? (teamRows.find((t) => t.id === h.routedTeamId) ?? null) : null,
      routedUser: person(h.routedUserId),
      requestedBy: person(h.requestedBy),
      createdAt: h.createdAt.toISOString(),
    }));
  }

  /** Someone else already answering is a 409 naming them, so the UI can say who. */
  private async assertNotSomeoneElses(conv: Conversation, me: string) {
    if (conv.controller === 'human' && conv.controllerUserId && conv.controllerUserId !== me) {
      const [who] = await this.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, conv.controllerUserId));
      throw new ConflictException({
        message: `${who?.name ?? 'Someone else'} is already answering this conversation`,
        controllerUserId: conv.controllerUserId,
      });
    }
  }
}

function fallbackSummary(
  transcript: Array<{ authorType: string; body: string }>,
  subject: string,
): string {
  const asks = transcript
    .filter((m) => m.authorType === 'customer')
    .map(
      (m) =>
        m.body
          .replace(/\s+/g, ' ')
          .trim()
          .split(/(?<=[.!?।])\s/)[0] ?? '',
    )
    .filter(Boolean)
    .slice(-3);
  return asks.length ? `The customer wrote: ${asks.join(' … ')}` : `Ticket: ${subject}`;
}

function fallbackNextStep(rules: AiRule[], reason: string): string {
  if (rules.includes('asked_for_human'))
    return 'Reply personally: the customer asked for a person.';
  if (rules.includes('approval_expired'))
    return 'Decide on the request that expired, then tell the customer.';
  if (rules.includes('action_failed'))
    return 'Check the failed action in the company system before replying.';
  if (rules.includes('budget_exhausted') || rules.includes('no_model'))
    return 'Answer the customer; the AI could not run.';
  if (rules.length)
    return `Answer the customer; the AI stopped because: ${rules.map((r) => AI_RULE_LABELS[r] ?? r).join(', ')}.`;
  return `Pick up the conversation: ${reason}`;
}
