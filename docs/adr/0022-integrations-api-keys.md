# ADR 0022: Integrations and API keys

Status: accepted (2026-10-01)

## Context

TMS is to be sold as a helpdesk that any app can plug into. Until now the only way for an outside system to call the API was to sign in as a person: a 15-minute access token, a rotating refresh token and a staff role. The sample-data loader did exactly that. An outside app needs a credential of its own that an admin can scope, limit and revoke without touching anyone's account.

## Decision

### Integrations

- An **integration** is one outside app (`integrations`: slug, name, on/off). Its API keys belong to it; its webhooks, chat identity secret and widget settings will too (later phases).
- The slug names the integration's secrets (`integration.<slug>.<field>`, already accepted by `secretKeySchema`) and cannot change.
- Integrations are switched off, never deleted, so tickets and audit entries keep a valid reference. Switching one off refuses all its keys at once.

### API keys

- Format `tms_sk_` + 32 random bytes as base64url. The prefix makes a leaked key recognisable to secret scanners.
- Only the SHA-256 of the key is stored (`api_keys.key_hash`, unique). A fast hash is right for a full-entropy random string: there is nothing to guess, and a slow hash would only slow every request. `api-key.util.ts` is ported from whatsapp-crm (MIT).
- The key is returned **once**, in the answer to creating it. This is the one place a route returns a credential, and the exception to ADR 0009's "no route returns a secret's value": TMS generates this value, so it has to hand it over once; it cannot be read again because it is not stored.
- A key has a name, scopes, a per-minute limit (default 120), an optional expiry, and can be revoked. Revocation is permanent. There is no "rotate": create a new key, switch the app over, revoke the old one.
- Creating a key needs `integration:manage` and `settings:secrets`; everything else needs `integration:manage`. Admins hold both.

### Authentication

- A key is sent as `Authorization: Bearer tms_sk_…`.
- Keys are **opt-in per route**. Routes marked `@ApiKeyAuth()` take a key and refuse staff tokens; every other route refuses keys with 403. A key therefore never reaches code written for a signed-in person, whatever its scopes say.
- The check is a branch in the global `AuthGuard`. It sets `req.apiKey`; `PermissionsGuard` then treats the key's scopes as its permissions, so `@RequirePermission` works unchanged.
- Scopes are permission strings from an allow-list (`API_KEY_SCOPES`): `integration:ticket`, `integration:event` and `kb:read`. A key cannot be given a staff permission.
- The actor on audit rows and events is `{ type: 'integration', id: <key id> }`.
- Keys are looked up on every request, with no cache, so revoking a key or switching its integration off works on the next request.

### Limits

- Each key has its own allowance per minute, counted across all addresses (`RateLimiterService.hit('api-key', keyId, …)`), answered with 429 and `Retry-After`.
- Wrong keys are counted per network address (20 a minute), which slows guessing.
- Both follow `RATE_LIMITS`, like the other limits (ADR 0021). The `@RateLimit` decorator is not used here because it runs before authentication and counts by address.

### What is recorded

- Creating or changing an integration, and creating or revoking a key, write audit and outbox rows (`integration.config_changed`). They carry the key's id, name and prefix, never the key.
- `api_keys.last_used_at` is written at most once a minute and is not audited. It is a usage hint for Settings, like `llm_calls` is a metrics log (ADR 0008).

### Orbit Desk

Settings → Integrations: add an integration, switch it on or off, create keys (the key is shown once with a copy button), see scopes, limit, last use and state, and revoke.

## Consequences

- An app that loses its key cannot recover it; it needs a new one.
- A key's scopes cannot be edited. To change them, create another key.
- Multi-tenancy later adds one column to `integrations`. The key lookup stays a global lookup by hash, and the tenant comes from the integration row, so the key format does not need to carry it.
- `GET /integration` (who the key is) is the only integration route in this phase. Tickets, incidents and webhooks follow in ADRs 0023 to 0025.
