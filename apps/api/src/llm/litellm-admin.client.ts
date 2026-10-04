import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
import { litellmErrorReason } from './litellm-error';
import type { CostMap } from './model-catalogue';

export interface LiteLlmModelInfo {
  mode?: string;
  input_cost_per_token?: number | null;
  output_cost_per_token?: number | null;
  max_input_tokens?: number | null;
  supports_function_calling?: boolean | null;
  supports_response_schema?: boolean | null;
  supports_vision?: boolean | null;
}

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 15_000;
/** LiteLLM's model list is a few megabytes and changes when LiteLLM is upgraded. */
const COST_MAP_TTL_MS = 10 * 60_000;

/**
 * LiteLLM's admin API (ADR 0003). Provider keys go into LiteLLM credentials
 * and never come back out; TMS registers each model under the alias
 * `tms-<model id>` so routing stays in TMS's hands (ADR 0008).
 */
@Injectable()
export class LiteLlmAdminClient {
  private costMapCache: { at: number; map: CostMap } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Every model LiteLLM knows, with its kind, price and capabilities. Kept for ten minutes. */
  async costMap(): Promise<CostMap> {
    const cached = this.costMapCache;
    if (cached && Date.now() - cached.at < COST_MAP_TTL_MS) return cached.map;
    const map = ((await this.call('GET', '/public/litellm_model_cost_map')) ?? {}) as CostMap;
    this.costMapCache = { at: Date.now(), map };
    return map;
  }

  createCredential(name: string, values: Record<string, string>, provider: string) {
    return this.call('POST', '/credentials', {
      credential_name: name,
      credential_values: values,
      credential_info: { custom_llm_provider: provider },
    });
  }

  /** Replaces the credential's values (key rotation); models that use it pick it up. */
  updateCredential(name: string, values: Record<string, string>, provider: string) {
    return this.call('PATCH', `/credentials/${encodeURIComponent(name)}`, {
      credential_name: name,
      credential_values: values,
      credential_info: { custom_llm_provider: provider },
    });
  }

  async deleteCredential(name: string) {
    await this.call('DELETE', `/credentials/${encodeURIComponent(name)}`).catch((err: Error) => {
      if (!/not found|404/i.test(err.message)) throw err;
    });
  }

  addModel(alias: string, params: Record<string, unknown>, mode: string) {
    return this.call('POST', '/model/new', {
      model_name: alias,
      litellm_params: params,
      model_info: { id: alias, mode },
    });
  }

  async deleteModel(alias: string) {
    await this.call('POST', '/model/delete', { id: alias }).catch((err: Error) => {
      if (!/not found|404|400/i.test(err.message)) throw err;
    });
  }

  async modelInfo(alias: string): Promise<LiteLlmModelInfo | null> {
    const res = (await this.call(
      'GET',
      `/model/info?litellm_model_id=${encodeURIComponent(alias)}`,
    )) as { data?: Array<{ model_info?: LiteLlmModelInfo }> };
    return res.data?.[0]?.model_info ?? null;
  }

  /** A tiny real call with the given params, without registering a model. */
  async testConnection(
    mode: 'chat' | 'embedding',
    params: Record<string, unknown>,
  ): Promise<TestConnectionResult> {
    const res = (await this.call('POST', '/health/test_connection', {
      mode,
      litellm_params: params,
    })) as { status?: string; result?: { error?: string } };
    if (res.status === 'success') return { ok: true };
    return {
      ok: false,
      error: litellmErrorReason(res.result?.error) ?? 'The provider rejected the request',
    };
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.env.LITELLM_URL), {
        method,
        headers: {
          authorization: `Bearer ${this.env.LITELLM_MASTER_KEY ?? ''}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ServiceUnavailableException(`LiteLLM is unreachable: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `LiteLLM ${method} ${path.split('?')[0]} → ${res.status}: ${text.slice(0, 300)}`,
      );
    return text ? JSON.parse(text) : undefined;
  }
}
