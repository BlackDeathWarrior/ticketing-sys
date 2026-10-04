import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { type Database, type DbOrTx, llmCalls, llmModels, llmProviders, llmRoles } from '@tms/db';
import {
  type BudgetPeriod,
  budgetPeriodStart,
  type CreateLlmModelInput,
  type CreateLlmProviderInput,
  LLM_PROVIDER_INFO,
  type LlmCatalogueModel,
  type LlmModelView,
  type LlmProvider,
  type LlmProviderView,
  type LlmRoleView,
  type LlmUsageView,
  maskedLast4,
  MODEL_ROLES,
  type ModelRole,
  ROLE_REQUIREMENTS,
  type SetLlmRoleInput,
  type TestLlmModelInput,
  type UpdateLlmModelInput,
  type UpdateLlmProviderInput,
} from '@tms/shared';
import { asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV } from '../infra/tokens';
import { LiteLlmAdminClient, type LiteLlmModelInfo } from './litellm-admin.client';
import {
  costPerMTok,
  rankCandidates,
  type RoleConfig,
  roleWarning,
  type RouterModel,
  type RouterProvider,
} from './llm-router';
import { catalogueFor } from './model-catalogue';

type ProviderRow = typeof llmProviders.$inferSelect;
type ModelRow = typeof llmModels.$inferSelect;

export const modelAlias = (modelId: string) => `tms-${modelId}`;
export const modelIdFromAlias = (alias: string | null | undefined) =>
  alias?.startsWith('tms-') ? alias.slice(4) : null;

const DEFAULT_ROLE: RoleConfig = { mode: 'cheapest', modelIds: [] };

/**
 * Providers, models and roles (ADR 0008). Keys go to LiteLLM and are never
 * stored or returned by TMS; every change is audited and emits
 * `llm.config_changed`.
 */
@Injectable()
export class LlmSettingsService {
  private readonly logger = new Logger(LlmSettingsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly litellm: LiteLlmAdminClient,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  // ---- Providers ----

  async listProviders(): Promise<LlmProviderView[]> {
    const rows = await this.db.select().from(llmProviders).orderBy(asc(llmProviders.label));
    const spend = await this.periodSpend(rows);
    return rows.map((p) => toProviderView(p, spend.get(p.id) ?? 0));
  }

  async createProvider(ctx: RequestCtx, input: CreateLlmProviderInput): Promise<LlmProviderView> {
    const id = randomUUID();
    const credential = `tms-prov-${id}`;
    const info = LLM_PROVIDER_INFO[input.provider];
    // Local endpoints ignore the key, but LiteLLM wants a credential to reference.
    await this.litellm.createCredential(
      credential,
      { api_key: input.apiKey ?? 'not-needed' },
      input.provider,
    );
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(llmProviders).values({
          id,
          provider: input.provider,
          label: input.label,
          baseUrl: input.baseUrl ?? info.defaultBaseUrl ?? null,
          keyLast4: input.apiKey ? maskedLast4(input.apiKey) : null,
          litellmCredential: credential,
          budgetUsd: input.budgetUsd,
          budgetPeriod: input.budgetPeriod,
          createdBy: ctx.user?.id ?? null,
        });
        await this.record(tx, ctx, 'llm.provider_created', 'llm_provider', id, {
          provider: input.provider,
          label: input.label,
          keySet: !!input.apiKey,
          budgetUsd: input.budgetUsd,
          budgetPeriod: input.budgetPeriod,
        });
      });
    } catch (err) {
      await this.litellm.deleteCredential(credential).catch(() => undefined);
      throw err;
    }
    return this.getProvider(id);
  }

  async updateProvider(
    ctx: RequestCtx,
    id: string,
    input: UpdateLlmProviderInput,
  ): Promise<LlmProviderView> {
    const current = await this.providerRow(id);
    if (input.apiKey) {
      await this.litellm.updateCredential(
        current.litellmCredential,
        { api_key: input.apiKey },
        current.provider,
      );
    }
    const baseUrlChanged = input.baseUrl !== undefined && input.baseUrl !== current.baseUrl;
    if (
      baseUrlChanged &&
      input.baseUrl === null &&
      LLM_PROVIDER_INFO[current.provider as LlmProvider].baseUrlRequired
    ) {
      throw new BadRequestException('This provider needs a base URL');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(llmProviders)
        .set({
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.apiKey ? { keyLast4: maskedLast4(input.apiKey) } : {}),
          ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
          ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}),
          ...(input.budgetPeriod !== undefined ? { budgetPeriod: input.budgetPeriod } : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        })
        .where(eq(llmProviders.id, id));
      const { apiKey, ...rest } = input;
      await this.record(
        tx,
        ctx,
        apiKey ? 'llm.provider_key_rotated' : 'llm.provider_updated',
        'llm_provider',
        id,
        {
          ...rest,
          ...(apiKey ? { key: 'rotated', last4: maskedLast4(apiKey) } : {}),
        },
      );
    });
    if (baseUrlChanged) {
      // The base URL lives on each model deployment, so re-register them.
      const models = await this.db.select().from(llmModels).where(eq(llmModels.providerId, id));
      const provider = await this.providerRow(id);
      for (const m of models) {
        await this.litellm.deleteModel(modelAlias(m.id));
        await this.litellm.addModel(modelAlias(m.id), deploymentParams(provider, m.model), m.mode);
      }
    }
    return this.getProvider(id);
  }

  async deleteProvider(ctx: RequestCtx, id: string): Promise<void> {
    const current = await this.providerRow(id);
    const models = await this.db.select().from(llmModels).where(eq(llmModels.providerId, id));
    for (const m of models) await this.litellm.deleteModel(modelAlias(m.id));
    await this.litellm.deleteCredential(current.litellmCredential);
    await this.db.transaction(async (tx) => {
      await this.removeFromRoles(
        tx,
        models.map((m) => m.id),
      );
      await tx.delete(llmProviders).where(eq(llmProviders.id, id));
      await this.record(tx, ctx, 'llm.provider_deleted', 'llm_provider', id, {
        provider: current.provider,
        label: current.label,
        models: models.length,
      });
    });
  }

  /**
   * A tiny real completion (or embedding) through the provider's stored key,
   * with one of the provider's own models when it has any (an enabled one
   * first): the built-in test model is only a guess at what the provider
   * still offers.
   */
  async testProvider(ctx: RequestCtx, id: string) {
    const provider = await this.providerRow(id);
    const [model] = await this.db
      .select()
      .from(llmModels)
      .where(eq(llmModels.providerId, id))
      .orderBy(desc(llmModels.enabled), asc(llmModels.createdAt))
      .limit(1);
    const info = LLM_PROVIDER_INFO[provider.provider as LlmProvider];
    const modelName = model?.model ?? `${info.prefix}${info.testModel}`;
    const started = Date.now();
    let result: { ok: boolean; error?: string };
    try {
      result = await this.litellm.testConnection(
        model?.mode === 'embedding' ? 'embedding' : 'chat',
        deploymentParams(provider, modelName),
      );
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    const lastTest = {
      ok: result.ok,
      at: new Date().toISOString(),
      ...(result.error ? { error: result.error } : {}),
    };
    await this.db.transaction(async (tx) => {
      await tx.update(llmProviders).set({ lastTest }).where(eq(llmProviders.id, id));
      await this.record(tx, ctx, 'llm.provider_tested', 'llm_provider', id, {
        model: modelName,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
    });
    return { ...result, model: modelName, latencyMs: Date.now() - started };
  }

  /**
   * A tiny real call to one model with the provider's stored key, before the
   * model is registered. LiteLLM's list is a catalogue: only the provider can
   * say whether this key may use a model. Says nothing about the provider's
   * own connection, so `lastTest` is left alone.
   */
  async testModel(id: string, input: TestLlmModelInput) {
    const provider = await this.providerRow(id);
    const prefix = LLM_PROVIDER_INFO[provider.provider as LlmProvider].prefix;
    const model = input.model.startsWith(prefix) ? input.model : `${prefix}${input.model}`;
    const started = Date.now();
    let result: { ok: boolean; error?: string };
    try {
      result = await this.litellm.testConnection(input.mode, deploymentParams(provider, model));
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }
    return { ...result, model, latencyMs: Date.now() - started };
  }

  // ---- Models ----

  /** The models LiteLLM knows for this provider: what "Add a model" offers to choose from. */
  async catalogue(providerId: string): Promise<LlmCatalogueModel[]> {
    const provider = await this.providerRow(providerId);
    const kind = provider.provider as LlmProvider;
    if (!LLM_PROVIDER_INFO[kind].catalogue) return [];
    const [map, registered] = await Promise.all([
      // Without the list the name is typed, as before: not a reason to fail the form.
      this.litellm.costMap().catch((err: Error) => {
        this.logger.warn(`LiteLLM's model list is not available: ${err.message}`);
        return {};
      }),
      this.db
        .select({ model: llmModels.model })
        .from(llmModels)
        .where(eq(llmModels.providerId, providerId)),
    ]);
    const prefix = LLM_PROVIDER_INFO[kind].prefix;
    const added = new Set(registered.map((m) => m.model));
    return catalogueFor(map, kind, new Date().toISOString().slice(0, 10)).map((m) => ({
      ...m,
      added: added.has(`${prefix}${m.model}`),
    }));
  }

  async listModels(): Promise<LlmModelView[]> {
    const rows = await this.db
      .select({ model: llmModels, provider: llmProviders })
      .from(llmModels)
      .innerJoin(llmProviders, eq(llmProviders.id, llmModels.providerId))
      .orderBy(asc(llmProviders.label), asc(llmModels.label));
    return rows.map(({ model, provider }) => toModelView(model, provider));
  }

  async createModel(ctx: RequestCtx, input: CreateLlmModelInput): Promise<LlmModelView> {
    const provider = await this.providerRow(input.providerId);
    const prefix = LLM_PROVIDER_INFO[provider.provider as LlmProvider].prefix;
    const full = input.model.startsWith(prefix) ? input.model : `${prefix}${input.model}`;
    const id = randomUUID();
    await this.litellm.addModel(modelAlias(id), deploymentParams(provider, full), input.mode);
    try {
      const info = await this.litellm.modelInfo(modelAlias(id)).catch(() => null);
      const caps = capabilities(info, input);
      await this.db.transaction(async (tx) => {
        await tx.insert(llmModels).values({
          id,
          providerId: provider.id,
          model: full,
          label: input.label ?? input.model,
          mode: input.mode,
          ...caps,
        });
        await this.record(tx, ctx, 'llm.model_created', 'llm_model', id, {
          providerId: provider.id,
          model: full,
          mode: input.mode,
          costSource: caps.costSource,
        });
      });
    } catch (err) {
      await this.litellm.deleteModel(modelAlias(id)).catch(() => undefined);
      throw err;
    }
    return this.getModel(id);
  }

  async updateModel(
    ctx: RequestCtx,
    id: string,
    input: UpdateLlmModelInput,
  ): Promise<LlmModelView> {
    await this.modelRow(id);
    const set: Partial<ModelRow> = {};
    if (input.label !== undefined) set.label = input.label;
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.supportsTools !== undefined) set.supportsTools = input.supportsTools;
    if (input.supportsJson !== undefined) set.supportsJson = input.supportsJson;
    if (input.inputCostPerMTok !== undefined) {
      set.inputCostPerToken = perToken(input.inputCostPerMTok);
      set.costSource = 'manual';
    }
    if (input.outputCostPerMTok !== undefined) {
      set.outputCostPerToken = perToken(input.outputCostPerMTok);
      set.costSource = 'manual';
    }
    await this.db.transaction(async (tx) => {
      await tx.update(llmModels).set(set).where(eq(llmModels.id, id));
      await this.record(tx, ctx, 'llm.model_updated', 'llm_model', id, { ...input });
    });
    return this.getModel(id);
  }

  async deleteModel(ctx: RequestCtx, id: string): Promise<void> {
    const current = await this.modelRow(id);
    await this.litellm.deleteModel(modelAlias(id));
    await this.db.transaction(async (tx) => {
      await this.removeFromRoles(tx, [id]);
      await tx.delete(llmModels).where(eq(llmModels.id, id));
      await this.record(tx, ctx, 'llm.model_deleted', 'llm_model', id, { model: current.model });
    });
  }

  // ---- Roles ----

  async listRoles(): Promise<LlmRoleView[]> {
    const snapshot = await this.routingSnapshot();
    return MODEL_ROLES.map((role) => {
      const config = snapshot.roles.get(role) ?? DEFAULT_ROLE;
      const candidates = rankCandidates(role, config, snapshot.models, snapshot.providers);
      let warning = roleWarning(role, candidates);
      if (!warning && ROLE_REQUIREMENTS[role].pinned && config.mode === 'cheapest') {
        warning = 'Embeddings always use the first model in the list, so search stays consistent.';
      }
      return {
        role,
        label: ROLE_REQUIREMENTS[role].label,
        mode: config.mode,
        modelIds: config.modelIds,
        candidates,
        warning,
      };
    });
  }

  async setRole(ctx: RequestCtx, role: ModelRole, input: SetLlmRoleInput): Promise<LlmRoleView> {
    if (input.modelIds.length) {
      const found = await this.db
        .select({ id: llmModels.id })
        .from(llmModels)
        .where(inArray(llmModels.id, input.modelIds));
      if (found.length !== new Set(input.modelIds).size)
        throw new BadRequestException('Unknown model id(s)');
    }
    if (input.mode === 'ordered' && !input.modelIds.length)
      throw new BadRequestException('An ordered role needs at least one model');
    await this.db.transaction(async (tx) => {
      await tx
        .insert(llmRoles)
        .values({
          role,
          mode: input.mode,
          modelIds: input.modelIds,
          updatedBy: ctx.user?.id ?? null,
        })
        .onConflictDoUpdate({
          target: llmRoles.role,
          set: { mode: input.mode, modelIds: input.modelIds, updatedBy: ctx.user?.id ?? null },
        });
      await this.record(tx, ctx, 'llm.role_updated', 'llm_role', role, { ...input });
    });
    return (await this.listRoles()).find((r) => r.role === role)!;
  }

  // ---- Routing inputs and usage ----

  /**
   * The routing snapshot, at most a few seconds old (`LLM_SNAPSHOT_MS`). Every model call needs
   * it twice (to choose a model, then to price the call) and each read is
   * four queries; a turn makes several calls. Settings pages read the fresh
   * one, so a change shows at once; a call picks it up within seconds.
   */
  async recentSnapshot(): Promise<Awaited<ReturnType<LlmSettingsService['routingSnapshot']>>> {
    const now = Date.now();
    if (!this.recent || now - this.recent.at >= this.env.LLM_SNAPSHOT_MS) {
      this.recent = { at: now, value: this.routingSnapshot() };
      // A failed read is not kept.
      this.recent.value.catch(() => (this.recent = undefined));
    }
    return this.recent.value;
  }

  private recent?: {
    at: number;
    value: ReturnType<LlmSettingsService['routingSnapshot']>;
  };

  /** What the router needs: models, providers with current-period spend, role configs. */
  async routingSnapshot() {
    const [providerRows, modelRows, roleRows] = await Promise.all([
      this.db.select().from(llmProviders),
      this.db.select().from(llmModels),
      this.db.select().from(llmRoles),
    ]);
    const spend = await this.periodSpend(providerRows);
    const providerKind = new Map(providerRows.map((p) => [p.id, p.provider as LlmProvider]));
    const models: RouterModel[] = modelRows.map((m) => ({
      id: m.id,
      providerId: m.providerId,
      provider: providerKind.get(m.providerId)!,
      label: m.label,
      mode: m.mode as RouterModel['mode'],
      supportsTools: m.supportsTools,
      supportsJson: m.supportsJson,
      inputCostPerToken: m.inputCostPerToken,
      outputCostPerToken: m.outputCostPerToken,
      enabled: m.enabled,
    }));
    const providers: RouterProvider[] = providerRows.map((p) => ({
      id: p.id,
      enabled: p.enabled,
      budgetUsd: p.budgetUsd,
      spentUsd: spend.get(p.id) ?? 0,
    }));
    const roles = new Map(
      roleRows.map((r) => [
        r.role as ModelRole,
        { mode: r.mode, modelIds: r.modelIds } as RoleConfig,
      ]),
    );
    const modelById = new Map(modelRows.map((m) => [m.id, m]));
    return { models, providers, roles, modelById };
  }

  async usage(days: number, now = new Date()): Promise<LlmUsageView> {
    const since = new Date(now.getTime() - days * 86_400_000);
    const inRange = gte(llmCalls.createdAt, since);
    const [providers, byProvider, byRole, byDay, recent] = await Promise.all([
      this.listProviders(),
      this.db
        .select({
          providerId: llmCalls.providerId,
          costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(llmCalls)
        .where(inRange)
        .groupBy(llmCalls.providerId),
      this.db
        .select({
          role: llmCalls.role,
          costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(llmCalls)
        .where(inRange)
        .groupBy(llmCalls.role),
      this.db
        .select({
          date: sql<string>`to_char(date_trunc('day', ${llmCalls.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
          costUsd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float8`,
          calls: sql<number>`count(*)::int`,
        })
        .from(llmCalls)
        .where(inRange)
        .groupBy(sql`1`)
        .orderBy(sql`1`),
      this.db.select().from(llmCalls).where(inRange).orderBy(desc(llmCalls.id)).limit(25),
    ]);
    const providerById = new Map(providers.map((p) => [p.id, p]));
    return {
      since: since.toISOString(),
      totalUsd: byProvider.reduce((s, r) => s + r.costUsd, 0),
      byProvider: byProvider.map((r) => {
        const p = r.providerId ? providerById.get(r.providerId) : undefined;
        return {
          providerId: r.providerId,
          label: p?.label ?? 'Deleted provider',
          costUsd: r.costUsd,
          calls: r.calls,
          budgetUsd: p?.budgetUsd ?? null,
          periodSpentUsd: p?.spentUsd ?? 0,
        };
      }),
      byRole,
      byDay,
      recent: recent.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        role: r.role,
        model: r.model,
        status: r.status,
        costUsd: r.costUsd,
        latencyMs: r.latencyMs,
        error: r.error,
      })),
    };
  }

  // ---- helpers ----

  private async getProvider(id: string) {
    const view = (await this.listProviders()).find((p) => p.id === id);
    if (!view) throw new NotFoundException('Provider not found');
    return view;
  }

  private async getModel(id: string) {
    const view = (await this.listModels()).find((m) => m.id === id);
    if (!view) throw new NotFoundException('Model not found');
    return view;
  }

  private async providerRow(id: string): Promise<ProviderRow> {
    const [row] = await this.db.select().from(llmProviders).where(eq(llmProviders.id, id));
    if (!row) throw new NotFoundException('Provider not found');
    return row;
  }

  private async modelRow(id: string): Promise<ModelRow> {
    const [row] = await this.db.select().from(llmModels).where(eq(llmModels.id, id));
    if (!row) throw new NotFoundException('Model not found');
    return row;
  }

  /** Spend per provider since the start of each provider's own budget period. */
  private async periodSpend(
    providers: ProviderRow[],
    now = new Date(),
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (!providers.length) return result;
    const starts = new Map(
      providers.map((p) => [p.id, budgetPeriodStart(p.budgetPeriod as BudgetPeriod, now)]),
    );
    const earliest = new Date(Math.min(...[...starts.values()].map((d) => d.getTime())));
    const rows = await this.db
      .select({
        providerId: llmCalls.providerId,
        day: sql<string>`date_trunc('day', ${llmCalls.createdAt} at time zone 'UTC')::date::text`,
        costUsd: sql<number>`sum(${llmCalls.costUsd})::float8`,
      })
      .from(llmCalls)
      .where(gte(llmCalls.createdAt, earliest))
      .groupBy(llmCalls.providerId, sql`2`);
    for (const r of rows) {
      if (!r.providerId) continue;
      const start = starts.get(r.providerId);
      if (start && new Date(`${r.day}T00:00:00Z`) >= start) {
        result.set(r.providerId, (result.get(r.providerId) ?? 0) + r.costUsd);
      }
    }
    return result;
  }

  private async removeFromRoles(tx: DbOrTx, modelIds: string[]) {
    for (const id of modelIds) {
      await tx
        .update(llmRoles)
        .set({ modelIds: sql`array_remove(${llmRoles.modelIds}, ${id}::uuid)` })
        .where(sql`${id}::uuid = any(${llmRoles.modelIds})`);
    }
  }

  private async record(
    tx: DbOrTx,
    ctx: RequestCtx,
    action: string,
    targetType: string,
    targetId: string,
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, { action, targetType, targetId, data });
    await this.outbox.publish(tx, ctx, {
      type: 'llm.config_changed',
      aggregateType: 'llm',
      aggregateId: targetId,
      payload: { action, targetType },
    });
  }
}

/** LiteLLM params for one deployment: the key comes from the stored credential. */
function deploymentParams(provider: ProviderRow, model: string): Record<string, unknown> {
  return {
    model,
    litellm_credential_name: provider.litellmCredential,
    ...(provider.baseUrl ? { api_base: provider.baseUrl } : {}),
  };
}

const perToken = (perMTok: number | null) => (perMTok === null ? null : perMTok / 1_000_000);

function capabilities(info: LiteLlmModelInfo | null, input: CreateLlmModelInput) {
  const manualCost = input.inputCostPerMTok !== undefined || input.outputCostPerMTok !== undefined;
  const knownCost =
    typeof info?.input_cost_per_token === 'number' &&
    typeof info?.output_cost_per_token === 'number';
  return {
    supportsTools: input.supportsTools ?? !!info?.supports_function_calling,
    supportsJson:
      input.supportsJson ?? !!(info?.supports_response_schema ?? info?.supports_function_calling),
    supportsVision: !!info?.supports_vision,
    contextWindow: info?.max_input_tokens ?? null,
    inputCostPerToken: manualCost
      ? perToken(input.inputCostPerMTok ?? null)
      : (info?.input_cost_per_token ?? null),
    outputCostPerToken: manualCost
      ? perToken(input.outputCostPerMTok ?? null)
      : (info?.output_cost_per_token ?? null),
    costSource: manualCost ? 'manual' : knownCost ? 'litellm' : 'unknown',
  };
}

function toProviderView(p: ProviderRow, spentUsd: number): LlmProviderView {
  return {
    id: p.id,
    provider: p.provider as LlmProvider,
    label: p.label,
    baseUrl: p.baseUrl,
    keyLast4: p.keyLast4,
    enabled: p.enabled,
    budgetUsd: p.budgetUsd,
    budgetPeriod: p.budgetPeriod as BudgetPeriod,
    spentUsd,
    lastTest: p.lastTest ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toModelView(m: ModelRow, p: ProviderRow): LlmModelView {
  return {
    id: m.id,
    providerId: p.id,
    provider: p.provider as LlmProvider,
    providerLabel: p.label,
    model: m.model,
    label: m.label,
    mode: m.mode as LlmModelView['mode'],
    supportsTools: m.supportsTools,
    supportsJson: m.supportsJson,
    supportsVision: m.supportsVision,
    contextWindow: m.contextWindow,
    inputCostPerMTok: costPerMTok(m.inputCostPerToken),
    outputCostPerMTok: costPerMTok(m.outputCostPerToken),
    costSource: m.costSource as LlmModelView['costSource'],
    enabled: m.enabled,
  };
}
