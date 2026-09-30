# ADR 0003: All LLM traffic through a LiteLLM proxy

Status: accepted (2026-09-30)

## Context

The business wants to use several model providers (OpenAI, Anthropic, Gemini, Gemma, Mistral, NVIDIA NIM and local models), switch between them without code changes, balance load, and let admins enter API keys from a settings page.

## Decision

- Run the LiteLLM proxy as a container (`infra/docker-compose.yml`) with `STORE_MODEL_IN_DB=True`. Provider keys are stored in LiteLLM's own database, encrypted with `LITELLM_SALT_KEY`.
- The TMS settings module (Phase 3) calls LiteLLM's admin API to add credentials and model deployments. TMS keeps only metadata (provider, label, last four characters). Keys are never returned to the browser.
- The app calls LiteLLM through its OpenAI-compatible API using the `openai` npm SDK, addressing **model groups** by role (`chat_agent`, `classifier`, `summarizer`, `embedding`, `copilot`). Several deployments in a group give load balancing; fallbacks are configured per group.
- Routing, retries and cooldowns are set in `infra/litellm/config.yaml`.

## Consequences

- Swapping or adding a provider is a settings change.
- LiteLLM is on the critical path for AI features, so it is monitored in `/health/ready` and must run with more than one replica in production.
- Tests use LiteLLM's `mock_response` so AI flows run offline in CI.
