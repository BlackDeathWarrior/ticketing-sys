# ADR 0021: Hardening for the demo

Status: accepted (2026-10-01)

## Context

The demo will be on the public internet with fictional data. Before that, four things were missing: nothing limited how often a stranger could call the public routes or guess a password; operational data grew for ever; a background job that failed for good was visible only in logs; and nobody could follow one request across the API, the worker and the model.

## Decision

### Rate limits

- **One small limiter of our own** (`RateLimiterService`, `common/rate-limit.ts`): a fixed-window counter in Redis, so every API instance shares the counts. A route opts in with `@RateLimit({ name, limit, windowSeconds })`; `RateLimitGuard` runs before authentication. A refused call gets 429, a `Retry-After` header and a sentence saying when to come back.
- **Why not `@fastify/rate-limit`:** the plan named it, but three of the limits are not HTTP routes (sign-in lockout per account, voice and chat sockets), and they should share one implementation and one switch.
- **If Redis is down the limiter lets calls through.** Refusing every sign-in because the counter is unreachable would be the worse failure.
- **`RATE_LIMITS=off`** switches the per-route limits and the lockout off (the integration tests do; `security.int.test.ts` switches them on). The portal's five-links-per-address limit is always on: it protects customers' inboxes.

| What                           | Limit, per network address                                                  |
| ------------------------------ | --------------------------------------------------------------------------- |
| Sign-in                        | 300 a minute; and 10 wrong passwords for one account lock it for 15 minutes |
| Token refresh                  | 120 a minute                                                                |
| Request form                   | 20 a minute                                                                 |
| Rating page                    | 60 a minute                                                                 |
| Portal sign-in, session, pages | 20, 30 and 240 a minute                                                     |
| WhatsApp webhook               | 1,200 a minute (Meta sends bursts; the signature is checked first)          |
| Voice call start               | 6 a minute                                                                  |
| Web chat                       | 60 new chats and 120 messages a minute, on top of 10 per 10 s per chat      |

- **Lockout** counts failures per account _and_ address, so a stranger can't lock a colleague out from elsewhere. The answer is the same whether the account exists. A successful sign-in clears the count. Each refusal is audited (`auth.login_locked`).

### Who is calling

Limits are only as good as the address they count. The API used to believe any `X-Forwarded-For` header, so a caller could invent a new address per request.

- `clientAddress` (`common/client-address.ts`) believes the header only as far as our own proxies wrote it: an entry counts only when the address that reported it is private (loopback, RFC 1918, link-local, unique-local). Fastify uses the same rule (`trustProxy: isPrivateAddress`), and so do the chat and voice sockets.
- Consequence: the API must sit behind a proxy on a private network (nginx or Caddy in the same Docker network), which is how both the compose stack and the planned AWS demo run. A proxy on a public address would need this rule extended.
- In development, where the browser reaches the API from a private address, the header is believed. That is harmless there.

### Retention

- One setting (`retention`, Settings → System, permission `system:manage`, admins only): model-call log 90 days, read and unread notifications 90 days, delivered outbox events 30 days, used or expired portal sign-in links 7 days. Call recordings stay fixed at 30 days because the call page tells callers so (ADR 0018).
- `RetentionService.run` deletes through each owning module (`purgeCalls`, `purge`, `purgePublished`, `purgeLogins`, recordings) and records what it deleted as `system.retention_ran`. The worker runs it once a day (`RETENTION_SWEEP_HOURS`, 0 = off); "Run now" does the same on demand.
- **Never deleted:** tickets, messages, customers, the audit log, AI runs and ratings. Deleting customer data on request is a different feature (erasure), not built.

### Failed background jobs

- BullMQ keeps a job that failed after its last retry. `GET /system/jobs` lists each queue with its counts and its failed jobs; an admin can retry or remove one (both audited: `system.job_retried`, `system.job_removed`).
- A job is shown by **identifiers and the error message only** (event type, record id, attempts, when). Job payloads can hold message text, so they are never returned.

### What the AI may say (red team)

- The model's reply is checked before it is used: `leaksInternals` in `ai/policy.ts` looks for our prompt's own section markers and instructions. A reply that carries them is dropped and the ticket goes to a person (rule `unsafe_output`). This sits next to the existing rules (no promises without a tool result, no answers without a source).
- `apps/api/test/evals/redteam.yaml` holds the attacks as golden conversations: a customer asking for the system prompt, a fake system message inside a customer message, a request for another customer's details, and a customer posing as staff to get money promised. A poisoned knowledge base article that tells the AI to promise refunds is an integration test. They run in CI with the scripted model (which is scripted to give in, so the guard is what is tested) and against real models with `pnpm ai:eval`.

### Tracing

- OpenTelemetry, **with spans created by hand** at the hand-over points instead of auto-instrumentation: nothing has to load before everything else, and with no collector configured nothing happens at all.
- One trace follows a request: the API's request span (`TracingInterceptor`) → the outbox row carries the `traceparent` (`outbox_events.trace_context`) → the worker's span per event → AI jobs carry it in their data → a client span per model call, and the header goes on to LiteLLM. `llm_calls.trace_id` holds the trace id.
- Spans carry route patterns, event types and record ids. They never carry URLs (tokens live in some paths), bodies or message text. Health probes are not traced.
- `OTEL_EXPORTER_OTLP_ENDPOINT` switches it on (OTLP over HTTP). `--profile observability` starts a collector that prints one line per span.

### Dependencies

- `pnpm audit` runs in CI: any known vulnerability of moderate severity or worse in what we ship fails the build, and high or worse in the tooling.
- Fixing the first run meant upgrading Fastify (5.12.5, by override: Nest pins an older one), nodemailer (6 → 10), OpenTelemetry (1 → 2) and js-yaml.
- Accepted for now: three moderate findings in development tools only (vitest's dev server, and esbuild inside drizzle-kit). Neither runs a server in our use.

## Found by the security review

1. `X-Forwarded-For` was believed from anyone (above). Fixed.
2. The web chat limited messages per connection only; reconnecting reset it, and each message can cost a model call. Fixed with per-address limits.
3. nginx kept the API's old address after the API container was recreated and answered 502 until restarted. It now asks Docker's DNS again every few seconds. Orbit Desk also shows a plain sentence instead of a JSON parse error when a proxy answers, and no longer signs the user out when a token refresh fails for a reason other than a refused token.
4. Voice calls were limited per connection address, which behind nginx is nginx: every caller shared one allowance. Fixed with `clientAddress`.

Checked and found in order: every webhook verifies its signature before anything else (WhatsApp is the only webhook); no raw SQL is built from input; secrets have a minimum length and are required in production; the customer pages build no HTML from customer text; helmet's headers are on every API response.

## Consequences

- A whole office behind one address shares each allowance. The limits are set well above what people do by hand; raise them in the decorators if a real customer hits one.
- Fixed windows allow up to twice the limit across a window edge. That is fine for abuse protection, and it is one Redis command per call.
- Traces need a collector and somewhere to look at them; the demo ships only the printing collector. Metrics and dashboards are not built.
- Trace ids arriving from outside are continued, so a caller can attach requests to a trace id of their choosing. It only affects what a trace viewer groups together.

## Not in this phase

SSO and MFA (after the demo, as agreed), erasing a customer's data on request, field-level encryption of customer data, alerting on failed jobs, backups and load tests (backups belong to Phase 12).
