import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, llmCalls } from '@tms/db';
import type { ModelRole } from '@tms/shared';
import { lt } from 'drizzle-orm';
import type Redis from 'ioredis';
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Env } from '../config/env';
import { DB, ENV, REDIS } from '../infra/tokens';
import { currentTrace, currentTraceId, SpanKind, withSpan } from '../telemetry/tracing';
import { rankCandidates, routeOrder } from './llm-router';
import { LlmSettingsService, modelAlias, modelIdFromAlias } from './llm-settings.service';

/** Nothing can serve the role: no capable model, all disabled, or every provider over budget. */
export class LlmUnavailableError extends Error {
  constructor(
    readonly role: ModelRole,
    readonly reason: 'no_model' | 'over_budget',
  ) {
    super(
      reason === 'over_budget'
        ? `Every provider for ${role} is over its budget`
        : `No usable model is configured for ${role}`,
    );
    this.name = 'LlmUnavailableError';
  }
}

export interface CallContext {
  ticketId?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
}

export interface ChatRequest extends CallContext {
  role: Exclude<ModelRole, 'embedding'>;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  responseFormat?: ChatCompletionCreateParamsNonStreaming['response_format'];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface CallMeta {
  modelId: string | null;
  model: string;
  costUsd: number;
  latencyMs: number;
  fallbacksAttempted: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Short texts only: a question, an FAQ title, a tool description. */
const EMBED_CACHE_MAX_CHARS = 600;
const EMBED_CACHE_SECONDS = 7 * 86_400;
const EMBED_CACHE_PREFIX = 'tms:llm:emb:';

/**
 * Every LLM call in the app goes through here (ADR 0003, 0008). TMS picks the
 * order (cheapest capable model first, providers over their cap skipped) and
 * LiteLLM executes it with the rest as per-request fallbacks. Each call is
 * written to `llm_calls` with its cost, which is what the caps are checked
 * against.
 */
/** Passes the trace on to LiteLLM, which continues it when its own tracing is on. */
function traceHeaders(): Record<string, string> | undefined {
  const traceparent = currentTrace();
  return traceparent ? { traceparent } : undefined;
}

@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly client: OpenAI;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settings: LlmSettingsService,
  ) {
    this.client = new OpenAI({
      baseURL: new URL('/v1', env.LITELLM_URL).toString(),
      apiKey: env.LITELLM_MASTER_KEY ?? 'unset',
      maxRetries: 0, // LiteLLM retries and falls back
    });
  }

  async chat(req: ChatRequest): Promise<{ completion: ChatCompletion } & CallMeta> {
    const order = await this.order(req.role);
    const started = Date.now();
    const body = {
      model: modelAlias(order[0]!),
      fallbacks: order.slice(1).map(modelAlias),
      messages: req.messages,
      ...(req.tools?.length ? { tools: req.tools } : {}),
      ...(req.responseFormat ? { response_format: req.responseFormat } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      metadata: { tms_role: req.role, ticket_id: req.ticketId ?? undefined },
    } as ChatCompletionCreateParamsNonStreaming;
    return withSpan(
      `llm chat ${req.role}`,
      { kind: SpanKind.CLIENT, attributes: { 'tms.llm.role': req.role } },
      async (span) => {
        req = { ...req, traceId: req.traceId ?? currentTraceId() };
        try {
          const { data, response } = await this.client.chat.completions
            .create(body, { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, headers: traceHeaders() })
            .withResponse();
          const meta = await this.record(req, response.headers, order[0]!, started, 'ok', {
            prompt: data.usage?.prompt_tokens,
            completion: data.usage?.completion_tokens,
          });
          span.setAttributes({ 'tms.llm.model': meta.model, 'tms.llm.cost_usd': meta.costUsd });
          return { completion: data, ...meta };
        } catch (err) {
          await this.recordError(req, order[0]!, started, err);
          throw err;
        }
      },
    );
  }

  /**
   * Embeds short texts, such as a customer's question, through a cache in
   * Redis: the same words asked again cost nothing. Texts already cached are
   * left out of the request; when all are, no model is called at all.
   * Documents being indexed (long texts, large batches) are not cached.
   */
  async embed(
    input: string[],
    ctx: CallContext & { dimensions?: number } = {},
  ): Promise<{ vectors: number[][] } & CallMeta> {
    const order = await this.order('embedding');
    const cacheable = input.every((t) => t.length <= EMBED_CACHE_MAX_CHARS);
    if (!cacheable) return this.embedNow(input, ctx, order);

    const started = Date.now();
    const keys = input.map(
      (t) =>
        `${EMBED_CACHE_PREFIX}${order[0]}:${ctx.dimensions ?? 0}:${createHash('sha256').update(t).digest('hex')}`,
    );
    const found = await this.redis.mget(keys).catch(() => keys.map(() => null));
    const vectors: Array<number[] | null> = found.map((raw) => {
      try {
        return raw ? (JSON.parse(raw) as number[]) : null;
      } catch {
        return null;
      }
    });
    const missing = vectors.flatMap((v, i) => (v ? [] : [i]));
    if (!missing.length) {
      return {
        vectors: vectors as number[][],
        modelId: order[0]!,
        model: modelAlias(order[0]!),
        costUsd: 0,
        latencyMs: Date.now() - started,
        fallbacksAttempted: 0,
      };
    }
    const fresh = await this.embedNow(
      missing.map((i) => input[i]!),
      ctx,
      order,
    );
    const write = this.redis.multi();
    missing.forEach((at, n) => {
      vectors[at] = fresh.vectors[n]!;
      write.set(keys[at]!, JSON.stringify(fresh.vectors[n]), 'EX', EMBED_CACHE_SECONDS);
    });
    await write.exec().catch(() => undefined);
    return { ...fresh, vectors: vectors as number[][] };
  }

  private async embedNow(
    input: string[],
    ctx: CallContext & { dimensions?: number },
    order: string[],
  ): Promise<{ vectors: number[][] } & CallMeta> {
    const req = { ...ctx, role: 'embedding' as const };
    const started = Date.now();
    try {
      const { data, response } = await this.client.embeddings
        .create(
          {
            model: modelAlias(order[0]!),
            input,
            // The SDK defaults to base64, which not every provider behind LiteLLM returns.
            encoding_format: 'float',
            ...(ctx.dimensions ? { dimensions: ctx.dimensions } : {}),
          },
          { headers: traceHeaders() },
        )
        .withResponse();
      const meta = await this.record(req, response.headers, order[0]!, started, 'ok', {
        prompt: data.usage?.prompt_tokens,
      });
      return { vectors: data.data.map((d) => d.embedding), ...meta };
    } catch (err) {
      await this.recordError(req, order[0]!, started, err);
      throw err;
    }
  }

  /** Model ids to try for the role, or throws LlmUnavailableError. */
  async order(role: ModelRole): Promise<string[]> {
    const snap = await this.settings.recentSnapshot();
    const candidates = rankCandidates(
      role,
      snap.roles.get(role) ?? { mode: 'cheapest', modelIds: [] },
      snap.models,
      snap.providers,
    );
    const order = routeOrder(candidates, role);
    if (!order.length) {
      const overBudget = candidates.some((c) => c.skipped === 'over_budget');
      throw new LlmUnavailableError(role, overBudget ? 'over_budget' : 'no_model');
    }
    return order;
  }

  private async record(
    req: CallContext & { role: ModelRole },
    headers: Headers,
    firstChoice: string,
    started: number,
    status: 'ok',
    tokens: { prompt?: number; completion?: number },
  ): Promise<CallMeta> {
    const snap = await this.settings.recentSnapshot();
    const modelId = modelIdFromAlias(headers.get('x-litellm-model-id')) ?? firstChoice;
    const model = snap.modelById.get(modelId);
    // Manual prices (models LiteLLM doesn't know) are applied here; otherwise LiteLLM's cost.
    const headerCost = Number(headers.get('x-litellm-response-cost') ?? 0);
    const cost =
      model?.costSource === 'manual'
        ? (tokens.prompt ?? 0) * (model.inputCostPerToken ?? 0) +
          (tokens.completion ?? 0) * (model.outputCostPerToken ?? 0)
        : headerCost;
    const meta: CallMeta = {
      modelId: model ? modelId : null,
      model: model?.model ?? modelAlias(modelId),
      costUsd: Number.isFinite(cost) ? cost : 0,
      latencyMs: Date.now() - started,
      fallbacksAttempted: Number(headers.get('x-litellm-attempted-fallbacks') ?? 0) || 0,
    };
    await this.db.insert(llmCalls).values({
      role: req.role,
      modelId: meta.modelId,
      providerId: model?.providerId ?? null,
      model: meta.model,
      status,
      promptTokens: tokens.prompt ?? 0,
      completionTokens: tokens.completion ?? 0,
      costUsd: meta.costUsd,
      latencyMs: meta.latencyMs,
      fallbacksAttempted: meta.fallbacksAttempted,
      ticketId: req.ticketId ?? null,
      conversationId: req.conversationId ?? null,
      traceId: req.traceId ?? null,
    });
    return meta;
  }

  private async recordError(
    req: CallContext & { role: ModelRole },
    firstChoice: string,
    started: number,
    err: unknown,
  ) {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`${req.role} call failed: ${message.slice(0, 200)}`);
    const snap = await this.settings.routingSnapshot().catch(() => null);
    const model = snap?.modelById.get(firstChoice);
    await this.db
      .insert(llmCalls)
      .values({
        role: req.role,
        modelId: model ? firstChoice : null,
        providerId: model?.providerId ?? null,
        model: model?.model ?? modelAlias(firstChoice),
        status: 'error',
        latencyMs: Date.now() - started,
        error: message.slice(0, 500),
        ticketId: req.ticketId ?? null,
        conversationId: req.conversationId ?? null,
        traceId: req.traceId ?? null,
      })
      .catch(() => undefined);
  }

  /** Deletes the log of model calls made before `before` (usage figures then start later). */
  async purgeCalls(before: Date): Promise<number> {
    const rows = await this.db
      .delete(llmCalls)
      .where(lt(llmCalls.createdAt, before))
      .returning({ id: llmCalls.id });
    return rows.length;
  }
}
