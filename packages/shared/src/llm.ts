import { z } from 'zod';

/**
 * LLM providers an admin can add in Settings. Keys are stored in LiteLLM
 * (encrypted with its salt key); TMS keeps only metadata and the last four
 * characters. Llama and Gemma models are reached through Groq, OpenRouter,
 * NVIDIA NIM or a local Ollama.
 */
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'mistral',
  'groq',
  'nvidia_nim',
  'openrouter',
  'sarvam',
  'ollama',
  'openai_compatible',
] as const;
export const llmProviderSchema = z.enum(LLM_PROVIDERS);
export type LlmProvider = z.infer<typeof llmProviderSchema>;

export interface LlmProviderInfo {
  label: string;
  /** LiteLLM model prefix, e.g. `anthropic/` in `anthropic/claude-haiku-4-5`. */
  prefix: string;
  keyRequired: boolean;
  /** A base URL must be given (local or self-hosted endpoints). */
  baseUrlRequired: boolean;
  defaultBaseUrl?: string;
  /**
   * Used by "Test connection" when the provider has no models yet. Prefer a
   * provider's "latest" alias over a dated name: providers retire models, and
   * a retired test model makes a good key look broken.
   */
  testModel: string;
  /**
   * The provider's name in LiteLLM's model list, which is where the choices in
   * "Add a model" come from. Absent for endpoints whose models only their
   * owner knows (local and self-hosted ones): there the name is typed.
   */
  catalogue?: string;
}

export const LLM_PROVIDER_INFO: Record<LlmProvider, LlmProviderInfo> = {
  anthropic: {
    label: 'Anthropic',
    prefix: 'anthropic/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'claude-haiku-4-5',
    catalogue: 'anthropic',
  },
  openai: {
    label: 'OpenAI',
    prefix: 'openai/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'gpt-4o-mini',
    catalogue: 'openai',
  },
  gemini: {
    label: 'Google Gemini',
    prefix: 'gemini/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'gemini-flash-lite-latest',
    catalogue: 'gemini',
  },
  mistral: {
    label: 'Mistral',
    prefix: 'mistral/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'mistral-small-latest',
    catalogue: 'mistral',
  },
  groq: {
    label: 'Groq',
    prefix: 'groq/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'llama-3.1-8b-instant',
    catalogue: 'groq',
  },
  nvidia_nim: {
    label: 'NVIDIA NIM',
    prefix: 'nvidia_nim/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'meta/llama-3.1-8b-instruct',
    catalogue: 'nvidia_nim',
  },
  openrouter: {
    label: 'OpenRouter',
    prefix: 'openrouter/',
    keyRequired: true,
    baseUrlRequired: false,
    testModel: 'meta-llama/llama-3.1-8b-instruct',
    catalogue: 'openrouter',
  },
  sarvam: {
    label: 'Sarvam',
    // Sarvam's chat API is OpenAI-compatible.
    prefix: 'openai/',
    keyRequired: true,
    baseUrlRequired: false,
    defaultBaseUrl: 'https://api.sarvam.ai/v1',
    testModel: 'sarvam-105b',
  },
  ollama: {
    label: 'Ollama (local)',
    prefix: 'ollama/',
    keyRequired: false,
    baseUrlRequired: true,
    defaultBaseUrl: 'http://host.docker.internal:11434',
    testModel: 'gemma3',
  },
  openai_compatible: {
    label: 'OpenAI-compatible',
    prefix: 'openai/',
    keyRequired: false,
    baseUrlRequired: true,
    testModel: 'default',
  },
};

/**
 * What the app asks LiteLLM for. Every role but `embedding` routes to the
 * cheapest capable model; embeddings are pinned because vectors from
 * different models can't be searched together.
 */
export const MODEL_ROLES = [
  'chat_agent',
  'chat_agent_voice',
  'classifier',
  'summarizer',
  'copilot',
  'embedding',
] as const;
export const modelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof modelRoleSchema>;

export const MODEL_MODES = ['chat', 'embedding'] as const;
export type ModelMode = (typeof MODEL_MODES)[number];

export interface RoleRequirement {
  label: string;
  mode: ModelMode;
  tools?: boolean;
  json?: boolean;
  /** Only `ordered`: the embedding space must not change per call. */
  pinned?: boolean;
}

export const ROLE_REQUIREMENTS: Record<ModelRole, RoleRequirement> = {
  chat_agent: { label: 'AI agent (chat and email)', mode: 'chat', tools: true },
  chat_agent_voice: { label: 'AI agent (voice)', mode: 'chat', tools: true },
  classifier: { label: 'Ticket classifier', mode: 'chat', json: true },
  summarizer: { label: 'Summaries and handover notes', mode: 'chat' },
  copilot: { label: 'Agent copilot', mode: 'chat' },
  embedding: { label: 'Knowledge base embeddings', mode: 'embedding', pinned: true },
};

export const ROLE_MODES = ['cheapest', 'ordered'] as const;
export type RoleMode = (typeof ROLE_MODES)[number];

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

// ---- API contracts ----

const baseUrl = z.string().trim().url().max(500);
const apiKey = z.string().trim().min(8, 'The key looks too short').max(500);
const budgetUsd = z.number().min(0).max(100_000).nullable();

export const createLlmProviderSchema = z
  .object({
    provider: llmProviderSchema,
    label: z.string().trim().min(1).max(100),
    apiKey: apiKey.optional(),
    baseUrl: baseUrl.optional(),
    budgetUsd: budgetUsd.default(null),
    budgetPeriod: z.enum(BUDGET_PERIODS).default('month'),
  })
  .superRefine((v, ctx) => {
    const info = LLM_PROVIDER_INFO[v.provider];
    if (info.keyRequired && !v.apiKey)
      ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'An API key is required' });
    if (info.baseUrlRequired && !v.baseUrl)
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'A base URL is required' });
  });
export type CreateLlmProviderInput = z.infer<typeof createLlmProviderSchema>;

export const updateLlmProviderSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    /** Rotates the key. */
    apiKey,
    baseUrl: baseUrl.nullable(),
    budgetUsd,
    budgetPeriod: z.enum(BUDGET_PERIODS),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateLlmProviderInput = z.infer<typeof updateLlmProviderSchema>;

/** Cost per million tokens in USD, the unit providers publish prices in. */
const costPerMTok = z.number().min(0).max(10_000).nullable();

export const createLlmModelSchema = z.object({
  providerId: z.string().uuid(),
  /** The provider's model name without the LiteLLM prefix, e.g. `claude-haiku-4-5`. */
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[\w.:/@-]+$/, 'Letters, digits and . : / @ - _ only'),
  label: z.string().trim().min(1).max(100).optional(),
  mode: z.enum(MODEL_MODES).default('chat'),
  /** Overrides what LiteLLM reports (or fills it in when LiteLLM doesn't know the model). */
  inputCostPerMTok: costPerMTok.optional(),
  outputCostPerMTok: costPerMTok.optional(),
  supportsTools: z.boolean().optional(),
  supportsJson: z.boolean().optional(),
});
export type CreateLlmModelInput = z.infer<typeof createLlmModelSchema>;

/** A model to try with the provider's stored key before it is registered. */
export const testLlmModelSchema = createLlmModelSchema.pick({ model: true, mode: true });
export type TestLlmModelInput = z.infer<typeof testLlmModelSchema>;

export const updateLlmModelSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    inputCostPerMTok: costPerMTok,
    outputCostPerMTok: costPerMTok,
    supportsTools: z.boolean(),
    supportsJson: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateLlmModelInput = z.infer<typeof updateLlmModelSchema>;

export const setLlmRoleSchema = z.object({
  mode: z.enum(ROLE_MODES),
  /**
   * `ordered`: the models to try, in order. `cheapest`: an optional allowlist
   * (empty means every capable model).
   */
  modelIds: z.array(z.string().uuid()).max(20).default([]),
});
export type SetLlmRoleInput = z.infer<typeof setLlmRoleSchema>;

export const llmUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const testLlmRoleSchema = z.object({
  prompt: z.string().trim().min(1).max(500).default('Reply with the single word OK.'),
});

// ---- Views (what the API returns; keys never appear) ----

export interface LlmProviderView {
  id: string;
  provider: LlmProvider;
  label: string;
  baseUrl: string | null;
  /** Last four characters of the key, or null when there is no key. */
  keyLast4: string | null;
  enabled: boolean;
  budgetUsd: number | null;
  budgetPeriod: BudgetPeriod;
  /** Spend in the current budget period. */
  spentUsd: number;
  lastTest: { ok: boolean; at: string; error?: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LlmModelView {
  id: string;
  providerId: string;
  provider: LlmProvider;
  providerLabel: string;
  /** Full LiteLLM model string, e.g. `anthropic/claude-haiku-4-5`. */
  model: string;
  label: string;
  mode: ModelMode;
  supportsTools: boolean;
  supportsJson: boolean;
  supportsVision: boolean;
  contextWindow: number | null;
  inputCostPerMTok: number | null;
  outputCostPerMTok: number | null;
  costSource: 'litellm' | 'manual' | 'unknown';
  enabled: boolean;
}

/** A model the provider offers, from LiteLLM's model list: a choice in "Add a model". */
export interface LlmCatalogueModel {
  /** The provider's model name without the LiteLLM prefix, e.g. `claude-haiku-4-5`. */
  model: string;
  mode: ModelMode;
  supportsTools: boolean;
  supportsJson: boolean;
  supportsVision: boolean;
  contextWindow: number | null;
  inputCostPerMTok: number | null;
  outputCostPerMTok: number | null;
  /** The day the provider has said it will retire the model (YYYY-MM-DD), when known. */
  retiresOn: string | null;
  /** Already registered for this provider. */
  added: boolean;
}

export interface LlmRoleCandidate {
  modelId: string;
  label: string;
  provider: LlmProvider;
  /** Blended cost per million tokens used for ordering (3 parts input to 1 output). */
  blendedCostPerMTok: number | null;
  /** Why the router would skip it right now. */
  skipped?: 'provider_disabled' | 'model_disabled' | 'over_budget' | 'missing_capability';
}

export interface LlmRoleView {
  role: ModelRole;
  label: string;
  mode: RoleMode;
  modelIds: string[];
  /** In the order the router would try them. */
  candidates: LlmRoleCandidate[];
  warning: string | null;
}

export interface LlmUsageView {
  since: string;
  totalUsd: number;
  byProvider: Array<{
    providerId: string | null;
    label: string;
    costUsd: number;
    calls: number;
    budgetUsd: number | null;
    periodSpentUsd: number;
  }>;
  byRole: Array<{ role: string; costUsd: number; calls: number }>;
  byDay: Array<{ date: string; costUsd: number; calls: number }>;
  recent: Array<{
    id: number;
    createdAt: string;
    role: string;
    model: string;
    status: string;
    costUsd: number;
    latencyMs: number;
    error: string | null;
  }>;
}

/** Blended cost per million tokens: support traffic sends about three input tokens per output token. */
export function blendedCostPerMTok(input: number | null, output: number | null): number | null {
  if (input === null || output === null) return null;
  return (3 * input + output) / 4;
}

/** Start of the current budget period in UTC (weeks start on Monday). */
export function budgetPeriodStart(period: BudgetPeriod, now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === 'month') d.setUTCDate(1);
  return d;
}
