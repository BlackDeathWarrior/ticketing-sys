import { Inject, Injectable, Logger } from '@nestjs/common';
import { type Database, llmCalls } from '@tms/db';
import type { ModelRole } from '@tms/shared';
import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
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

/**
 * Every LLM call in the app goes through here (ADR 0003, 0008). TMS picks the
 * order (cheapest capable model first, providers over their cap skipped) and
 * LiteLLM executes it with the rest as per-request fallbacks. Each call is
 * written to `llm_calls` with its cost, which is what the caps are checked
 * against.
 */
@Injectable()
export class LlmClientService {
  private readonly logger = new Logger(LlmClientService.name);
  private readonly client: OpenAI;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) env: Env,
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
    try {
      const { data, response } = await this.client.chat.completions
        .create(body, { timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS })
        .withResponse();
      const meta = await this.record(req, response.headers, order[0]!, started, 'ok', {
        prompt: data.usage?.prompt_tokens,
        completion: data.usage?.completion_tokens,
      });
      return { completion: data, ...meta };
    } catch (err) {
      await this.recordError(req, order[0]!, started, err);
      throw err;
    }
  }

  async embed(
    input: string[],
    ctx: CallContext & { dimensions?: number } = {},
  ): Promise<{ vectors: number[][] } & CallMeta> {
    const req = { ...ctx, role: 'embedding' as const };
    const order = await this.order('embedding');
    const started = Date.now();
    try {
      const { data, response } = await this.client.embeddings
        .create({
          model: modelAlias(order[0]!),
          input,
          ...(ctx.dimensions ? { dimensions: ctx.dimensions } : {}),
        })
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
    const snap = await this.settings.routingSnapshot();
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
    const snap = await this.settings.routingSnapshot();
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
}
