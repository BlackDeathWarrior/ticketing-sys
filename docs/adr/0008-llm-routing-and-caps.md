# ADR 0008: TMS orders LLM calls cheapest-first and enforces per-provider caps

Status: accepted (2026-09-30). This refines ADR 0003.

## Context

- The admin supplies keys for many providers: Anthropic, OpenAI, Gemini, Sarvam, Mistral, Groq, NVIDIA NIM, OpenRouter, and Llama or Gemma through those or a local Ollama.
- They want the **cheapest capable model** used by default, and a **spending cap per provider**.
- LiteLLM's own per-provider budgets (`router_settings.provider_budget_config`) live only in its config file and have no runtime API, so the Settings page can't manage them.
- Its model groups load-balance within one group; they don't give cheapest-first across providers.

## Decision

**Registration**

- Each provider key becomes a LiteLLM **credential** (`tms-prov-<uuid>`).
- Each model becomes a LiteLLM deployment under its own alias, `tms-<model uuid>`.
- TMS stores metadata only: label, last four characters of the key, capabilities, price, cap. See `llm_providers`, `llm_models` and `llm_roles`.

**Roles**

- The app asks for a **role**: `chat_agent`, `chat_agent_voice`, `classifier`, `summarizer`, `copilot` or `embedding`.
- `LlmRouter` ranks the candidates:
  - it keeps only models that meet the role's needs: tool calling for the agents, JSON for the classifier, and embedding mode for `embedding`;
  - it sorts them by blended price, `(3 × input + output) / 4` per million tokens, with unknown prices last;
  - it skips disabled providers and models, and providers whose spend in the current period (`day`, `week` or `month`, UTC) has reached their cap.
- An admin can switch a role to a **fixed order**, or limit cheapest-first to an allowlist.

**Calls**

- `LlmClientService` sends one request to LiteLLM, with `model` set to the first choice and `fallbacks` set to the rest. LiteLLM still does retries, cooldowns and the actual fallback.
- The `x-litellm-model-id` response header tells TMS which deployment answered.
- Cost comes from LiteLLM's `x-litellm-response-cost`. For models an admin priced manually (ones LiteLLM doesn't know), TMS computes it from the tokens.

**Records**

- Every call is written to `llm_calls` (role, model, provider, tokens, cost, latency, fallbacks, error, ticket). Caps are checked against these rows.
- `llm_calls` is a metrics log, like `refresh_tokens`: rows are not individually audited.
- Every configuration change (provider, key rotation, model, role, connection test) **is** audited, and emits `llm.config_changed`.

**Embeddings are pinned**

The `embedding` role always uses its first usable model with no fallback. Vectors from different models can't be searched together, so changing the embedding model means re-indexing (Phase 4).

**Test connection**

It uses LiteLLM's `/health/test_connection` with the stored credential, so the key never has to leave LiteLLM again.

## Consequences

- Adding a provider or changing a cap is a Settings change, and takes effect on the next call.
- A cap is checked before a call, not during it: one call can overshoot the cap by its own cost. That is acceptable for spending control, not for billing.
- When every capable provider is capped or off, the call fails with `LlmUnavailableError('over_budget' | 'no_model')`. The AI agent (Phase 5) treats this as a reason to hand over to a human.
- LiteLLM's routing strategy no longer matters much (`simple-shuffle`): each alias has a single deployment.
- Offline demos and CI register the scripted **fake provider** (`apps/fake-providers`) as an OpenAI-compatible provider, and exercise the same routing, fallback and cap paths.
