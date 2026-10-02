import { Inject, Injectable, Logger } from '@nestjs/common';
import { approvals, type Database, type DbOrTx, toolCalls } from '@tms/db';
import {
  type ApprovalStatus,
  describeArgs,
  type ToolCallStatus,
  type ToolCallView,
  type ToolTier,
} from '@tms/shared';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { desc, eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV, REDIS } from '../infra/tokens';
import { callHttpTool, HttpToolError } from './http-tool';
import { callTool, McpCallError, RESULT_PREVIEW_CHARS } from './mcp-client';
import { errorText, type ServerRow, type ToolRow, ToolsService } from './tools.service';

export interface InvokeInput {
  tool: ToolRow;
  server: ServerRow;
  /** Arguments as the model (or an admin) gave them: a JSON string or an object. */
  args: string | Record<string, unknown>;
  ticketId: string | null;
  conversationId: string | null;
  /** The ticket customer's email; fills the tool's customer argument. */
  customerEmail: string | null;
  /** Transactional calls: why the AI asked, and the customer's words. */
  reasoning?: string | null;
  evidence?: string | null;
  /** Dry runs ("Try the agent"): read tools run, nothing else does, nothing is stored. */
  dryRun?: boolean;
}

export type InvokeResult =
  | { status: 'ok'; callId: string | null; result: unknown }
  | { status: 'error' | 'denied'; callId: string | null; error: string }
  | { status: 'awaiting_approval'; callId: string; approvalId: string }
  | { status: 'simulated'; callId: null };

const BREAKER_FAILURES = 5;
const BREAKER_OPEN_SECONDS = 60;

/**
 * Runs company-system tools for the AI (ADR 0013): parse → bind the customer →
 * validate against the tool's schema → check the tier → run with a timeout,
 * a retry for reads and a per-server circuit breaker → record a `tool_calls`
 * row with audit and outbox. Transactional tools don't run: they create an
 * approval, and run later in the worker once a supervisor approves.
 */
@Injectable()
export class ToolGatewayService {
  private readonly logger = new Logger(ToolGatewayService.name);
  private readonly ajv = addFormats(new Ajv({ strict: false, allErrors: false }));
  private readonly validators = new Map<string, { at: number; fn: ValidateFunction }>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
    private readonly registry: ToolsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async invoke(ctx: RequestCtx, i: InvokeInput): Promise<InvokeResult> {
    const refuse = async (reason: string): Promise<InvokeResult> => {
      const callId = i.dryRun ? null : await this.record(ctx, i, {}, 'denied', null, reason, null);
      return { status: 'denied', callId, error: reason };
    };

    let args: Record<string, unknown>;
    try {
      const parsed = typeof i.args === 'string' ? JSON.parse(i.args || '{}') : i.args;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      args = { ...(parsed as Record<string, unknown>) };
    } catch {
      return refuse('Arguments must be a JSON object');
    }

    // The customer is whoever the ticket belongs to, never what the model says.
    if (i.tool.customerArg) {
      if (!i.customerEmail) {
        return refuse('The customer is not identified: there is no email address to act for');
      }
      args[i.tool.customerArg] = i.customerEmail;
    }
    const validate = this.validator(i.tool);
    if (!validate(args)) {
      const e = validate.errors?.[0];
      return refuse(`Invalid arguments: ${e?.instancePath || 'input'} ${e?.message ?? ''}`.trim());
    }

    const tier = i.tool.tier as ToolTier;
    if (i.dryRun && tier !== 'read') return { status: 'simulated', callId: null };
    if (tier === 'transactional') return this.requestApproval(ctx, i, args);

    const run = await this.execute(i.server, i.tool, args, tier === 'read' ? 2 : 1);
    if (i.dryRun) {
      return run.ok
        ? { status: 'ok', callId: null, result: run.result }
        : { status: 'error', callId: null, error: run.error };
    }
    const callId = await this.record(
      ctx,
      i,
      args,
      run.ok ? 'ok' : 'error',
      run.ok ? run.result : null,
      run.ok ? null : run.error,
      run,
    );
    return run.ok
      ? { status: 'ok', callId, result: run.result }
      : { status: 'error', callId, error: run.error };
  }

  /** Runs a call a supervisor approved. Idempotent: only an `approved` call runs, once. */
  async executeApproved(ctx: RequestCtx, toolCallId: string) {
    const claimed = await this.db.transaction(async (tx) => {
      const [call] = await tx
        .select()
        .from(toolCalls)
        .where(eq(toolCalls.id, toolCallId))
        .for('update');
      if (!call || call.status !== 'approved') return null;
      // Claimed: a retry after a crash finds `running`, never runs the action twice.
      await tx
        .update(toolCalls)
        .set({ status: 'running', attempts: call.attempts + 1 })
        .where(eq(toolCalls.id, toolCallId));
      return call;
    });
    if (!claimed) {
      const [call] = await this.db.select().from(toolCalls).where(eq(toolCalls.id, toolCallId));
      return {
        status: (call?.status ?? 'error') as ToolCallStatus,
        result: call?.result ?? null,
        error: call?.error ?? null,
      };
    }
    const { tool, server } = await this.registry.tool(claimed.toolId);
    const run = await this.execute(server, tool, claimed.args, 1);
    const status: ToolCallStatus = run.ok ? 'ok' : 'error';
    await this.db.transaction(async (tx) => {
      await tx
        .update(toolCalls)
        .set({
          status,
          result: run.ok ? (run.result as object) : null,
          error: run.ok ? null : run.error,
          latencyMs: run.latencyMs,
          completedAt: new Date(),
        })
        .where(eq(toolCalls.id, toolCallId));
      await this.called(tx, ctx, claimed.ticketId, {
        toolCallId,
        tool: tool.name,
        server: server.slug,
        status,
        approved: true,
        ...(run.ok ? {} : { error: run.error }),
      });
    });
    return { status, result: run.ok ? run.result : null, error: run.ok ? null : run.error };
  }

  async callsForTicket(ticketId: string): Promise<ToolCallView[]> {
    const rows = await this.db
      .select({ call: toolCalls, approval: approvals })
      .from(toolCalls)
      .leftJoin(approvals, eq(approvals.toolCallId, toolCalls.id))
      .where(eq(toolCalls.ticketId, ticketId))
      .orderBy(desc(toolCalls.createdAt))
      .limit(100);
    const all = await this.registry.listTools();
    return rows.map(({ call, approval }) => {
      const t = all.find((x) => x.id === call.toolId);
      return {
        id: call.id,
        tool: {
          name: t?.name ?? 'unknown',
          title: t?.title ?? null,
          qualifiedName: t?.qualifiedName ?? 'unknown',
          serverName: t?.serverName ?? '',
          tier: t?.tier ?? 'read',
          customerArg: t?.customerArg ?? null,
        },
        status: call.status as ToolCallStatus,
        actor: call.actorType === 'ai' ? 'ai' : 'user',
        args: call.args,
        result: call.result,
        error: call.error,
        latencyMs: call.latencyMs,
        createdAt: call.createdAt.toISOString(),
        approval: approval
          ? {
              id: approval.id,
              status: approval.status as ApprovalStatus,
              expiresAt: approval.expiresAt.toISOString(),
            }
          : null,
      };
    });
  }

  private async requestApproval(
    ctx: RequestCtx,
    i: InvokeInput,
    args: Record<string, unknown>,
  ): Promise<InvokeResult> {
    if (!i.ticketId) return { status: 'denied', callId: null, error: 'Approvals need a ticket' };
    const expiresAt = new Date(Date.now() + this.env.APPROVAL_TTL_MINUTES * 60_000);
    const summary =
      `${i.tool.title ?? i.tool.name}: ${describeArgs(args, i.tool.customerArg ? [i.tool.customerArg] : []) || 'no details'}`.slice(
        0,
        300,
      );
    return this.db.transaction(async (tx) => {
      const [call] = await tx
        .insert(toolCalls)
        .values({
          toolId: i.tool.id,
          ticketId: i.ticketId,
          conversationId: i.conversationId,
          actorType: ctx.actor.type === 'user' ? 'user' : 'ai',
          actorId: ctx.actor.id,
          args,
          status: 'awaiting_approval',
        })
        .returning();
      const [approval] = await tx
        .insert(approvals)
        .values({
          toolCallId: call!.id,
          ticketId: i.ticketId!,
          conversationId: i.conversationId,
          summary,
          reasoning: i.reasoning?.slice(0, 2000) ?? null,
          evidence: i.evidence?.slice(0, 2000) ?? null,
          expiresAt,
        })
        .returning();
      const data = {
        approvalId: approval!.id,
        toolCallId: call!.id,
        tool: i.tool.name,
        server: i.server.slug,
        summary,
        expiresAt: expiresAt.toISOString(),
      };
      await this.audit.record(tx, ctx, {
        action: 'approval.requested',
        targetType: 'ticket',
        targetId: i.ticketId!,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'approval.requested',
        aggregateType: 'approval',
        aggregateId: approval!.id,
        payload: { ...data, ticketId: i.ticketId, conversationId: i.conversationId },
      });
      return { status: 'awaiting_approval' as const, callId: call!.id, approvalId: approval!.id };
    });
  }

  /** One call with a timeout, retried once for reads, behind a per-server circuit breaker. */
  private async execute(
    server: ServerRow,
    tool: ToolRow,
    args: Record<string, unknown>,
    attempts: number,
  ): Promise<
    | { ok: true; result: unknown; latencyMs: number; attempts: number }
    | { ok: false; error: string; latencyMs: number; attempts: number }
  > {
    const started = Date.now();
    // Custom tools each talk to their own system, so each has its own breaker.
    const breaker = `tms:tools:breaker:${tool.http ? tool.id : server.id}`;
    const label = tool.http ? (tool.title ?? tool.name) : server.name;
    if (Number(await this.redis.get(breaker)) >= BREAKER_FAILURES) {
      return {
        ok: false,
        error: `${label} is unavailable right now (too many recent failures)`,
        latencyMs: 0,
        attempts: 0,
      };
    }
    const http = tool.http;
    const call = http
      ? async () =>
          callHttpTool(http, args, {
            token: await this.registry.customToken(tool),
            timeoutMs: tool.timeoutMs,
            privateHosts: this.registry.privateHosts,
          })
      : async () => callTool(await this.registry.target(server), tool.name, args, tool.timeoutMs);
    let last = 'The tool failed';
    for (let n = 1; n <= attempts; n++) {
      try {
        const result = await call();
        await this.redis.del(breaker);
        return { ok: true, result, latencyMs: Date.now() - started, attempts: n };
      } catch (err) {
        last = errorText(err);
        // The tool said no (e.g. "order not found"): a real answer, not an outage.
        if ((err instanceof McpCallError || err instanceof HttpToolError) && err.fromTool) break;
        await this.redis.multi().incr(breaker).expire(breaker, BREAKER_OPEN_SECONDS).exec();
        this.logger.warn(`tool ${server.slug}/${tool.name} failed (attempt ${n}): ${last}`);
      }
    }
    return { ok: false, error: last, latencyMs: Date.now() - started, attempts };
  }

  private async record(
    ctx: RequestCtx,
    i: InvokeInput,
    args: Record<string, unknown>,
    status: ToolCallStatus,
    result: unknown,
    error: string | null,
    run: { latencyMs: number; attempts: number } | null,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [call] = await tx
        .insert(toolCalls)
        .values({
          toolId: i.tool.id,
          ticketId: i.ticketId,
          conversationId: i.conversationId,
          actorType: ctx.actor.type === 'user' ? 'user' : 'ai',
          actorId: ctx.actor.id,
          args,
          status,
          result: (result ?? null) as object | null,
          error,
          latencyMs: run?.latencyMs ?? null,
          attempts: run?.attempts ?? 0,
          completedAt: new Date(),
        })
        .returning({ id: toolCalls.id });
      await this.called(tx, ctx, i.ticketId, {
        toolCallId: call!.id,
        tool: i.tool.name,
        server: i.server.slug,
        status,
        ...(error ? { error } : {}),
      });
      return call!.id;
    });
  }

  private async called(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticketId: string | null,
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, {
      action: 'tool.called',
      targetType: ticketId ? 'ticket' : 'tool',
      targetId: ticketId ?? String(data.toolCallId),
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'tool.called',
      aggregateType: ticketId ? 'ticket' : 'tool',
      aggregateId: ticketId ?? String(data.toolCallId),
      payload: data,
    });
  }

  private validator(tool: ToolRow): ValidateFunction {
    const cached = this.validators.get(tool.id);
    if (cached && cached.at === tool.updatedAt.getTime()) return cached.fn;
    let fn: ValidateFunction;
    try {
      fn = this.ajv.compile({ type: 'object', ...tool.inputSchema });
    } catch {
      fn = this.ajv.compile({ type: 'object' });
    }
    this.validators.set(tool.id, { at: tool.updatedAt.getTime(), fn });
    return fn;
  }
}

/** What the model gets back from a call: short, and never secrets. */
export function forModel(r: InvokeResult): Record<string, unknown> {
  switch (r.status) {
    case 'ok': {
      const text = JSON.stringify(r.result ?? null);
      return {
        ok: true,
        result:
          text.length > RESULT_PREVIEW_CHARS
            ? `${text.slice(0, RESULT_PREVIEW_CHARS)}… (truncated)`
            : r.result,
      };
    }
    case 'awaiting_approval':
      return {
        status: 'pending_approval',
        message:
          'Submitted for approval by a supervisor. It has NOT happened yet. Tell the customer their request is with the team for review and that they will hear back; do not say it is done.',
      };
    case 'simulated':
      return { status: 'simulated', message: 'Dry run: this action was not performed.' };
    default:
      return { ok: false, error: r.error };
  }
}
