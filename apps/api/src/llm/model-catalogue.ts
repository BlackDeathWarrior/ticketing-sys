import { LLM_PROVIDER_INFO, type LlmCatalogueModel, type LlmProvider } from '@tms/shared';

/** One entry of LiteLLM's model list (`/public/litellm_model_cost_map`); every field may be missing. */
export interface CostMapEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  max_input_tokens?: number | null;
  supports_function_calling?: boolean | null;
  supports_response_schema?: boolean | null;
  supports_vision?: boolean | null;
  supported_output_modalities?: string[] | null;
  deprecation_date?: string | null;
}

export type CostMap = Record<string, CostMapEntry>;
export type CatalogueEntry = Omit<LlmCatalogueModel, 'added'>;

/** What `createLlmModelSchema` accepts as a model name. */
const NAME = /^[\w.:/@-]{1,200}$/;
const perMTok = (perToken: unknown) =>
  typeof perToken === 'number' ? Number((perToken * 1_000_000).toPrecision(6)) : null;
/** `…-latest` names follow the provider's newest model, so they are offered first. */
const isAlias = (name: string) => /(^|-)latest$/.test(name);

/**
 * The chat and embedding models LiteLLM knows for one kind of provider, for
 * the "Add a model" choices: no models that produce something other than
 * text, none past the day their provider retires them. Aliases first, then
 * by name (version numbers in order).
 *
 * LiteLLM's list is a catalogue, not the provider's answer for this key: a
 * model in it can still be refused when it is called.
 */
export function catalogueFor(map: CostMap, provider: LlmProvider, today: string): CatalogueEntry[] {
  const info = LLM_PROVIDER_INFO[provider];
  if (!info.catalogue) return [];
  const found = new Map<string, CatalogueEntry>();
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || entry.litellm_provider !== info.catalogue) continue;
    if (entry.mode !== 'chat' && entry.mode !== 'embedding') continue;
    const name = key.startsWith(info.prefix) ? key.slice(info.prefix.length) : key;
    if (!NAME.test(name) || found.has(name)) continue;
    const retiresOn = /^\d{4}-\d{2}-\d{2}$/.test(entry.deprecation_date ?? '')
      ? entry.deprecation_date!
      : null;
    if (retiresOn && retiresOn < today) continue;
    const outputs = entry.supported_output_modalities;
    if (entry.mode === 'chat' && Array.isArray(outputs) && !outputs.includes('text')) continue;
    found.set(name, {
      model: name,
      mode: entry.mode,
      supportsTools: !!entry.supports_function_calling,
      supportsJson: !!(entry.supports_response_schema ?? entry.supports_function_calling),
      supportsVision: !!entry.supports_vision,
      contextWindow: entry.max_input_tokens ?? null,
      inputCostPerMTok: perMTok(entry.input_cost_per_token),
      outputCostPerMTok: perMTok(entry.output_cost_per_token),
      retiresOn,
    });
  }
  return [...found.values()].sort(
    (a, b) =>
      Number(isAlias(b.model)) - Number(isAlias(a.model)) ||
      a.model.localeCompare(b.model, 'en', { numeric: true }),
  );
}
