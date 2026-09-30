import {
  blendedCostPerMTok,
  type LlmProvider,
  type LlmRoleCandidate,
  type ModelMode,
  type ModelRole,
  ROLE_REQUIREMENTS,
  type RoleMode,
} from '@tms/shared';

export interface RouterModel {
  id: string;
  providerId: string;
  provider: LlmProvider;
  label: string;
  mode: ModelMode;
  supportsTools: boolean;
  supportsJson: boolean;
  /** USD per token. */
  inputCostPerToken: number | null;
  outputCostPerToken: number | null;
  enabled: boolean;
}

export interface RouterProvider {
  id: string;
  enabled: boolean;
  budgetUsd: number | null;
  /** Spend in the provider's current budget period. */
  spentUsd: number;
}

export interface RoleConfig {
  mode: RoleMode;
  modelIds: string[];
}

export const costPerMTok = (perToken: number | null) =>
  perToken === null ? null : perToken * 1_000_000;

/**
 * Every model that could serve `role`, in the order the router tries them.
 * Candidates the router would skip right now carry the reason.
 *
 * - `cheapest`: capable models (optionally limited to `modelIds`) by blended
 *   cost, unknown cost last.
 * - `ordered`: exactly `modelIds`, in that order.
 * - Pinned roles (embeddings) use only the first usable model: vectors from
 *   different models can't be mixed, so there is no fallback.
 */
export function rankCandidates(
  role: ModelRole,
  config: RoleConfig,
  models: RouterModel[],
  providers: RouterProvider[],
): LlmRoleCandidate[] {
  const req = ROLE_REQUIREMENTS[role];
  const byId = new Map(models.map((m) => [m.id, m]));
  const providerById = new Map(providers.map((p) => [p.id, p]));

  let ordered: RouterModel[];
  if (config.mode === 'ordered') {
    ordered = config.modelIds.map((id) => byId.get(id)).filter((m): m is RouterModel => !!m);
  } else {
    const allow = config.modelIds.length ? new Set(config.modelIds) : null;
    ordered = models
      .filter((m) => !allow || allow.has(m.id))
      .sort((a, b) => {
        const ca = blendedCost(a);
        const cb = blendedCost(b);
        if (ca === cb) return a.label.localeCompare(b.label);
        if (ca === null) return 1;
        if (cb === null) return -1;
        return ca - cb;
      });
  }

  return ordered
    .filter((m) => m.mode === req.mode)
    .map((m) => {
      const provider = providerById.get(m.providerId);
      let skipped: LlmRoleCandidate['skipped'];
      if (!provider || !provider.enabled) skipped = 'provider_disabled';
      else if (!m.enabled) skipped = 'model_disabled';
      else if ((req.tools && !m.supportsTools) || (req.json && !m.supportsJson))
        skipped = 'missing_capability';
      else if (provider.budgetUsd !== null && provider.spentUsd >= provider.budgetUsd)
        skipped = 'over_budget';
      return {
        modelId: m.id,
        label: m.label,
        provider: m.provider,
        blendedCostPerMTok: blendedCost(m),
        ...(skipped ? { skipped } : {}),
      };
    });
}

/** Model ids to try, first choice first. Empty means nothing can serve the role right now. */
export function routeOrder(candidates: LlmRoleCandidate[], role: ModelRole): string[] {
  const usable = candidates.filter((c) => !c.skipped).map((c) => c.modelId);
  return ROLE_REQUIREMENTS[role].pinned ? usable.slice(0, 1) : usable;
}

/** A human-readable problem with the role's setup, or null. */
export function roleWarning(role: ModelRole, candidates: LlmRoleCandidate[]): string | null {
  const req = ROLE_REQUIREMENTS[role];
  if (!candidates.length) {
    return req.mode === 'embedding'
      ? 'No embedding model is registered.'
      : 'No chat model is registered for this role.';
  }
  const usable = candidates.filter((c) => !c.skipped);
  if (!usable.length) {
    if (candidates.every((c) => c.skipped === 'missing_capability'))
      return req.tools
        ? 'None of these models supports tool calling, which this role needs.'
        : 'None of these models supports JSON output, which this role needs.';
    if (candidates.some((c) => c.skipped === 'over_budget'))
      return 'Every usable provider is over its budget; calls for this role will fail.';
    return 'Every model for this role is disabled.';
  }
  return null;
}

function blendedCost(m: RouterModel): number | null {
  return blendedCostPerMTok(costPerMTok(m.inputCostPerToken), costPerMTok(m.outputCostPerToken));
}
