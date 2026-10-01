# TMS Implementation Plan (phased)

## Context

The brief (forwarded email "Sub") asks for an omnichannel Ticket Management System: Email, WhatsApp, Web Chat and Voice channels, an AI Agent for first-level support that uses a knowledge base and MCP/API tools, AI-to-human handover, a unified Agent UI, routing/SLA, reporting, and RBAC/audit. We already published the target architecture as an interactive artifact (https://claude.ai/artifact/LCpSt9syuh5wmwAXRqQ5gH; source committed as `docs/architecture.html`). The repo `ticketing-sys` was empty (README only) when this plan was written, so it builds everything from scratch, following that architecture.

Decisions confirmed with the user:

- **TypeScript / Node** backend, **modular monolith** (one API + one worker process, clear internal modules).
- **LiteLLM** as the LLM layer: load balancing, fallbacks, many providers (OpenAI, Anthropic, Gemini, Gemma, Mistral, NVIDIA NIM, local via Ollama/vLLM/LM Studio). Admins enter API keys in a dashboard settings page.
- **Docker Compose first**, cloud later.
- **UI stays barebones** (unstyled React pages) until the final Frontend phase.

Phases 0–2 were built on `claude/pensive-planck-yp2tyi` and Orbit Desk on `claude/gifted-clarke-yl2r34`. Both are merged into `main`. From now on each phase is a feature branch and a pull request into `main`, and ends with a working demo.

## Progress

| Phase                       | State   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Foundations               | Done    | Monorepo, compose infra, API/worker skeletons, health checks, CI, ADRs 0001–0003, session hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 1 Core domain               | Done    | Auth (JWT + rotating refresh tokens), RBAC, users/teams/categories, customers with identity resolution and merge, tickets with configurable workflow, notes, history, append-only audit log, outbox → BullMQ relay, barebones UI. 4 unit + 23 API integration + 4 worker integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2 Channels                  | Done    | Channel envelope + inbound orchestrator (dedupe, identity resolution, email threading, reopen), agent replies with async delivery and status, web chat widget (Socket.IO, resumable sessions, signed identity), email over IMAP/SMTP with attachments in S3, live console updates. 23 unit + 35 integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| — Console and reports       | Done    | Orbit Desk dashboard wired to the API (ADR 0005), `GET /reports/overview` (ADR 0006), fictional sample data loader and a 23-test Playwright suite against the Docker stack (ADR 0007). 52 unit + 38 integration + 23 E2E tests. See `docs/testing/TEST_REPORT.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3 LLM platform + keys       | Done    | Settings module (AES-GCM secrets, typed app settings, channel config with env fallback, test connection), LLM module on LiteLLM (providers, models, roles, cheapest-first routing with per-provider caps, fallbacks, `llm_calls`), Orbit Desk Settings, `apps/fake-providers`, outbox events for org/workflow. ADR 0008, 0009                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 4 Knowledge base            | Done    | `kb_documents`/`kb_chunks` (pgvector 1024 + tsvector), file/URL/FAQ/text sources in S3, review (draft/approved/archived) and visibility (public/internal/team), `kb-ingest` worker queue with heading-aware chunking and pinned embeddings (keyword fallback), hybrid search with RRF and citations, Orbit Desk KB page and drawer panel, `pnpm kb:eval`. ADR 0010                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5 AI agent                  | Done    | AI takes new conversations per channel mode; `ai-turns` worker queue with per-conversation lock; agent loop (search_knowledge, update_ticket, request_human, send_reply) with versioned prompts; confidence policy (send ≥ 0.8 on auto channels, draft, hand over < 0.6; source and promise rules; repeated failures); drafts with approve/edit/discard; handover note and message; classifier; language detection; `ai_runs`; Orbit Desk AI marks, drafts, classification, AI activity and Settings → AI behaviour; golden evals (`pnpm ai:eval`). ADR 0011                                                                                                                                                                                                                                                                                               |
| 5b Help center form         | Done    | Public "Submit a request" page (`apps/help-center`, served at `/help/`) as channel `web_form`: topics, order number, up to 3 attachments, honeypot, idempotent submission id; worker-sent acknowledgement email; replies and customer follow-ups thread by email onto the form's conversation; AI drafts (like email). Orbit Desk: channel filter, message attachments, category and paragraph breaks in the drawer. ADR 0012                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 6 Tools and approvals       | Done    | MCP servers (streamable HTTP, SSRF-checked on every call, tokens as `tool.<slug>.token` secrets), tool registry with admin settings (enabled, risk tier read/write/transactional, timeout, customer-email binding), tool gateway (ajv validation, customer binding, retries for reads, per-server circuit breaker, `tool_calls` with audit and outbox), approvals for transactional tools (inbox, decide, expiry job, worker runs approved calls), AI follow-up after decisions, `agent-v2` prompt, tool goldens, sample Demo Store MCP server in `apps/fake-providers`. Orbit Desk: Settings → Tools & MCP, `#/approvals`, drawer company actions. ADR 0013                                                                                                                                                                                               |
| 7 Handover, routing, SLA    | Done    | Take-over (row-locked, 409 names the holder) / hand-back / agent handover / escalate; `tickets.handling`; handover rows with context packs (`summarizer`, template fallback); ordered routing rules (channel, priority, category, language, customer type) with skills, presence and capacity (least loaded, round robin, team queue); SLA policies, business hours and holidays, DST-safe business-time maths, idempotent timer reconcile, 30 s sweep for at-risk and breached; notifications (bell, live, email for breaches and approvals); copilot; queue handling filter and SLA countdowns, drawer control bar, lanes, history by actor. ADR 0014                                                                                                                                                                                                    |
| 8 WhatsApp                  | Done    | Meta Cloud API adapter ported from whatsapp-crm (MIT, `THIRD_PARTY_NOTICES.md`): public webhook with verify-token handshake and HMAC check of the raw body, `whatsapp-webhooks` queue, inbound text and media (copied to S3), `whatsapp_bsuid` identity for username-only senders, `WhatsAppSender` with Meta error explanations and permanent-versus-retryable failures, delivered/read/failed status reports, 24-hour window (409 for late free text), template sync, template sends and starting a conversation with a template. Orbit Desk: delivery labels and failure reasons, window note, template picker, Settings card with webhook address and templates. **No simulator and no fake Graph API** (decided 2026-10-01); the channel is off until real credentials are entered. ADR 0015                                                          |
| 8b Channel status           | Done    | Added on request (2026-10-01). Status lights for email, WhatsApp, web chat, the help-center form and voice: `GET /channels/health` with per-channel checks from pure rules; live probes (`ChannelConfigService.probe`) on a worker timer, on settings changes and on "Check now"; shared observations in Redis (`ChannelSignalsService`); `channel.down` notification when a working channel stops. One-step `POST /whatsapp/connect` following whatsapp-crm: verify the token and number, check the number belongs to the account, save, register with a PIN, subscribe. Orbit Desk: `StatusLight` (the one use of green/amber/red, DESIGN.md exception), overview tiles, check lists, connect form. ADR 0016                                                                                                                                             |
| 8c Custom tools             | Done    | Added on request (2026-10-01). Custom HTTP tools (`POST/PUT/DELETE /tools/custom`, test route) stored in `tools.http` under a built-in holder (`mcp_servers.kind = custom`) and run by the existing gateway (validation, customer binding, tiers, approvals, `tool_calls`); SSRF check on save and on every call, no placeholders in the host, redirects refused, per-tool circuit breaker. Permission `tool:create` (admins) that an admin can grant to roles (`GET /roles`, `PUT/DELETE /roles/:key/permissions/:permission`, delegable permissions only; the seed keeps grants). Orbit Desk: Custom tools card and dialog, "Who can create custom tools", Tools tab for `tool:create` holders. ADR 0017                                                                                                                                                 |
| 9 Voice                     | Done    | In-browser calls on Sarvam streaming speech (`saaras:v4`, `bulbul:v3`): public `/voice` socket and call page (`/widget/voice.html`, `tms-voice.js`) with a recording notice; `VoiceSession` state machine behind a `SpeechProvider` interface (`SarvamSpeech`); caller speech goes through `InboundService`, the AI turn runs inline, replies are stored `sent` (`message.spoken`); barge-in; drafts become handovers; agents join by voice from the ticket (`voice:answer`), and their speech is transcribed; stereo WAV recordings in S3 (`voice:recording_read`, audited, deleted after 30 days); `VOICE_MAX_CALLS`; Voice status light. No fake Sarvam (decided 2026-10-01): not yet run against the real service. Real phone numbers are out of scope. ADR 0018                                                                                       |
| 10 Reporting, portal, admin | Done    | `GET /reports/performance` (AI vs people: resolution, deflection, handover, first reply, time to final answer, SLA, ratings, cost per provider; filters for period, channel, team), `/reports/tickets` and audited CSV export (`report:export`). The AI resolves tickets it answered after 72 quiet hours (`autoResolveHours`, worker sweep, `POST /ai/auto-resolve`). Ratings: `csat_responses`, asked once in the chat or by email, given only by customers (survey link, chat, portal), low ratings notify. Customer portal in `apps/help-center`: one-time emailed link, 60-minute session, own tickets across channels, reply (joins the ticket's email thread), rate. Admin: `PATCH`/`DELETE /teams/:id`, `PATCH /categories/:id`; Orbit Desk Reports page and Settings → People, Tickets, Customers. Retention settings moved to Phase 11. ADR 0019 |
| 10b Learning from ratings   | Done    | Added on request (2026-10-01). `ai_feedback` per rated ticket the AI worked on; topics and documents with 3+ AI-alone ratings averaging 2.5 or lower make the AI draft instead of send (rule `poor_feedback`); a reviewer inbox (`learning_reviews`) for low-rated AI answers and well-rated human answers after a handover; outcomes: a staff-written lesson (`ai_lessons`, in the agent prompt, `agent-v3`), a knowledge base draft, or nothing; `learning:manage` (supervisors, admins); Orbit Desk Learning page; ratings per agent in Reports; switch in AI behaviour. Customers' comments never reach the AI. ADR 0020                                                                                                                                                                                                                               |
| 11 Hardening                | Done    | Rate limits on every public route and socket, sign-in lockout (10 wrong passwords, 15 minutes), the caller's address taken only from our own proxies; retention settings and a daily clean-up; failed-jobs view with retry and remove (`system:manage`); output guard `unsafe_output` and red-team goldens; OpenTelemetry traces API → outbox → worker → model call (`OTEL_EXPORTER_OTLP_ENDPOINT`); `pnpm audit` in CI with Fastify, nodemailer and OpenTelemetry upgraded; a security review with four fixes. Not built: SSO, MFA, erasure on request, alerts, load tests. ADR 0021                                                                                                                                                                                                                                                                      |
| 12 AWS demo                 | Planned | Needs the AWS profile and an approved plan and cost first. The old Phase 11 (frontend) is folded into each phase's Orbit Desk work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 13a Integrations, API keys  | Done    | Added on request (2026-10-01): the first step of making TMS pluggable into any app. `integrations` (an outside app, switched off rather than deleted) and `api_keys` (`tms_sk_…`, SHA-256 stored, shown once, scopes from an allow-list, per-minute limit, expiry, revoke). Keys work only on routes marked `@ApiKeyAuth()`, which refuse staff tokens; scopes are checked by `PermissionsGuard`; actor type `integration`; `GET /integration` tells a key who it is. Permissions `integration:manage`, `integration:ticket`, `integration:event`. Orbit Desk: Settings → Integrations. `scripts/check-in-docker.sh` takes `TMS_TEST_DB`. ADR 0022                                                                                                                                                                                                         |
| 13b Integration tickets     | Done    | Channel `api`: `POST /integration/tickets` raises a ticket in one call through the inbound pipeline (customer by the app's own id or email, category by name, priority, tags, `externalRef`, `metadata`, `ai: off`, `Idempotency-Key`), follow-ups, polling for customer-visible messages, list by reference and state, ratings. An integration only reaches tickets it raised (404 otherwise). `tickets.integration_id`, `external_ref`, `metadata`; `InboundService.handleInTx`; `ApiSender`; AI on `api` drafts by default; prompt `agent-v4` with a bounded `<ticket_context>` block. Orbit Desk: "Context from the app" in the drawer. ADR 0023                                                                                                                                                                                                       |
| 13c Incidents               | Done    | `POST /integration/events` (scope `integration:event`): an app reports a problem of its own by fingerprint. The first report opens an incident and a ticket through the inbound pipeline (tag `incident`, priority from severity, no AI and no classification); repeats are counted on it and noted at 2, 10, 100 and 1,000; a worse severity raises the priority; `status: resolved` resolves the incident and, when nobody has taken it, the ticket. A problem that returns reopens the same ticket unless it was closed. `incidents` table with one open incident per fingerprint; `GET /integration/incidents`, `GET /tickets/:id/incidents`. Orbit Desk: the drawer says how often it happened and whether it has recovered. ADR 0024                                                                                                                 |
| 13d Webhooks                | Done    | Webhook subscriptions per integration (`webhook_subscriptions`: address, events, scope `own` or `all`) and a delivery log (`webhook_deliveries`, identifiers and outcomes only). Public events mapped from domain events: tickets, customer-visible messages, incidents, approvals, ratings. Bodies are built at send time from what the integration API returns, signed `X-TMS-Signature: t=…,v1=HMAC-SHA256` with a `whsec_` secret shown once. `WebhookDispatchHandler` queues; `WebhookDeliveryWorker` sends on the `webhook-deliveries` queue with doubling retries, refuses redirects, and switches a subscription off after 15 failed deliveries in a row (admins are notified). Public https only, or hosts in `WEBHOOK_PRIVATE_HOSTS`. Test ping, redelivery, secret rotation, retention. Orbit Desk: Webhooks card with the log. ADR 0025        |

Also done: the whole stack runs in Docker (`pnpm docker:up`: root multi-stage `Dockerfile` with `api`, `worker`, `migrate`, `web`, `orbit-desk` targets; compose profile `app`). CI runs a `check` job (format, lint, build, typecheck, unit and integration tests) and an `e2e` job (Docker stack + sample data + Playwright).

## Reality check (30 September 2026)

An audit of `main` at `2605316` against this plan, the ADRs, the README and both consoles. Research for the next phases is in [`docs/research/whatsapp-crm.md`](research/whatsapp-crm.md) and [`docs/research/voice-sarvam.md`](research/voice-sarvam.md).

### What exists

**Platform**

- pnpm + Turborepo monorepo.
- Docker Compose with Postgres 16 (pgvector image), Redis, SeaweedFS (S3), GreenMail, Mailpit and LiteLLM, plus an optional `observability` profile with an OTel collector.
- A five-target `Dockerfile` and CI with `check` and `e2e` jobs.
- Health: `/health/live` and `/health/ready`. Readiness checks the database and Redis, and also reports LiteLLM and the worker heartbeat.
- pino logs with request IDs, Swagger at `/docs`, helmet, CORS, and an exception filter that maps Postgres errors 23505 → 409 and 23503 → 400.

**Auth and RBAC**

- argon2 passwords and 15-minute JWT access tokens.
- Rotating refresh tokens with reuse detection (reuse revokes every session). Logout and `/me`.
- Failed and successful logins are audited.
- 19 permission strings and 4 system roles (agent, team lead, supervisor, admin), enforced by global `AuthGuard` + `PermissionsGuard`.

**People and reference data**

- **Users:** list, get, create, update (name, roles, teams, password, deactivate).
- **Teams:** list and create.
- **Categories:** a two-level tree; list and create.
- **Workflow:** statuses and transitions are configurable at runtime: upsert status, deactivate status, replace transitions.

**Customers**

- List with fuzzy search, get, create and update.
- Identities: email, phone, whatsapp, webchat session, external id. Values are normalised; only verified identities can link to an existing customer.
- Resolve-or-create and merge.

**Tickets**

- List with filters, search and pagination (at most 200 per page). Get by UUID or `TMS-n`.
- Create, update with a field-level diff, and workflow-checked transitions.
- Assign. Assigning someone moves a New or AI Handling ticket to Human Assigned.
- Internal notes, and history built from the audit log.
- Lifecycle timestamps: first response, resolved, closed.

**Audit and events**

- Append-only `audit_log`, enforced by a trigger, and `GET /audit`.
- Transactional outbox with an insert trigger that sends NOTIFY. The relay uses SKIP LOCKED and publishes to the BullMQ `domain-events` queue, with 5 attempts and exponential backoff.

**Channels**

- `MessageEnvelope`, and `InboundService`, which:
  - takes an advisory lock per sender and drops duplicates;
  - resolves the customer;
  - threads email by Message-ID, then by a `[TMS-n]` subject tag (only when the sender owns that ticket);
  - opens a new ticket when the old one is closed, and reopens resolved or pending tickets.
- `OutboundService`: agent replies are stored as `pending`; an agent can also start a new email thread.
- The worker's `DeliveryHandler` sends through the webchat and email senders.
- Attachments are stored in S3, with a download endpoint.

**Web chat**

- The `/chat` Socket.IO namespace, with 30-day signed session tokens.
- Host-signed identity tokens (HS256).
- A rate limit of 10 messages per 10 seconds, and history on reconnect.
- A vanilla TypeScript widget and a demo page.

**Email**

- IMAP IDLE with a Redis lock so only one worker reads the mailbox, plus a fallback poll.
- Auto-replies are filtered out.
- Replies go out over SMTP with Message-ID, In-Reply-To and References headers.

**Realtime**

- The `/agent` namespace (token-authenticated) with the Socket.IO Redis adapter.
- The worker fans out ticket, message and conversation events through the Redis emitter.

**Reports:** `GET /reports/overview` returns open and unassigned counts, resolved today and in 7 days, median resolution and first-response times, counts by status, channel and priority, 14-day volume, per-agent load and an activity feed.

**Consoles**

- **Basic console** (`apps/web`): login, ticket list, new ticket, ticket page (reply, start email, notes, history, assign, transitions) and customer pages.
- **Orbit Desk** (`apps/orbit-desk`):
  - login;
  - a dashboard with a triage card, KPI tiles, the volume chart, queue breakdown, team load and activity feed;
  - a queue with four saved views, search and status tabs;
  - a ticket drawer with details, transitions, priority, assignee, notes and reply;
  - a new-ticket dialog with customer search or inline create;
  - live updates, a phone layout and an elements gallery.

**Test data and tests**

- `pnpm sample:load`: fictional teams, users, customers, 40 tickets, live chats and emails, loaded through the public API.
- 23 Playwright specs and `docs/testing/TEST_REPORT.md`.

### Gap list: named in the plan, ADRs, README or UI, but missing or partial

| Area                                                | Missing                                                                                                                                                                                                                                                                      | Partial                                                                                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM platform (Phase 3)**                          | Settings module, providers/models/roles, LiteLLM admin calls, "test connection", `llm_calls`, usage and budgets, settings UI in either console. The `settings:llm` permission exists but no route uses it                                                                    | LiteLLM runs in compose, and readiness reports it                                                                                                                                                                                  |
| **Knowledge base (Phase 4)**                        | Sources, ingestion, chunking, embeddings, hybrid search, citations, KB UI. The `vector` extension is not created (only `pg_trgm`)                                                                                                                                            | Postgres image ships pgvector                                                                                                                                                                                                      |
| **AI agent (Phase 5)**                              | Agent loop, classifier, guardrails, confidence, prompts, evals. Nothing ever sets `controller=ai` or writes `authorType='ai'`, and `ai_handling` is reachable only by a manual transition. Orbit Desk would render AI messages as "system"                                   | The schema has `controller` and `author_type='ai'`; the activity feed has an AI avatar ring                                                                                                                                        |
| **Tools, MCP, approvals (Phase 6)**                 | Tool registry, MCP client, REST connectors, `secrets` table and encryption, `tool_calls`, approval queue and UI. The `approval:approve` permission exists but no route uses it                                                                                               | —                                                                                                                                                                                                                                  |
| **Handover, routing, SLA, notifications (Phase 7)** | Handover triggers and context packs, take-over and hand-back endpoints, routing rules, skills, presence, assignment strategies, SLA policies, business hours, timers, breach events, notifications, copilot. `tickets.sla_policy_id` has no table behind it                  | The controller moves `none` → `human` on the first agent reply. Orbit Desk hides SLA and CSAT: the "SLA at risk" view was removed and `SlaIndicator` appears only on the elements page. The sidebar's team entries are not filters |
| **WhatsApp (Phase 8)**                              | Built on 2026-10-01 (ADR 0015). Not built: sending files, interactive messages, several numbers                                                                                                                                                                              | Works once a Meta app is connected in Settings. Sample tickets on the WhatsApp channel are still labels created through `POST /tickets`, with no conversations                                                                     |
| **Voice**                                           | Built on 2026-10-01 (ADR 0018), in the browser only. Not built: phone numbers (Twilio, Exotel, Plivo), streaming the AI's reply token by token, calls shared across API instances                                                                                            | —                                                                                                                                                                                                                                  |
| **Reporting and admin**                             | Built on 2026-10-01 (ADR 0019). Not built: fact tables (reports are live queries), a role editor beyond delegable permissions, retention settings (Phase 11)                                                                                                                 | `GET /reports/overview`                                                                                                                                                                                                            |
| **Hardening (Phase 10)**                            | Built on 2026-10-01 (ADR 0021): rate limits and lockout, retention, tracing, a failed-jobs view, the dependency audit. Still missing: OIDC SSO, MFA, field encryption, DLQ alerts, backups, load tests, IaC. `StorageService` needs static S3 keys and can't use an IAM role | helmet, CORS, the append-only audit log, graceful shutdown                                                                                                                                                                         |
| **Frontend (Phase 11)**                             | 3-pane workspace, full ticket and customer pages, settings and admin, reports page, approvals, KB search, a branded widget, a WCAG audit                                                                                                                                     | Orbit Desk implements the design system, dashboard, queue and drawer (ADR 0005)                                                                                                                                                    |

### Where the code contradicts the docs

1. **Outbox events** (fixed in Phase 3): CLAUDE.md and ADR 0002 say every state change writes an audit row **and** an outbox event. But:
   - `OrgService` (team and category create) and `WorkflowService` (status upsert and deactivate, transition replace) write audit rows only.
   - `DOMAIN_EVENT_TYPES` has no team, category or workflow events.
   - Login is audited without an event, which is acceptable for auth.

   This needs fixing in the next phase that touches admin settings.

2. **`docs/DESIGN.md` paths:** it pointed at `frontend/…`; the code is in `apps/orbit-desk/…`. Fixed in this update.
3. **Layout and verification sections below:** they describe the original target.
   - The worker is not `apps/worker`; it is a second entry point of `apps/api` (ADR 0004).
   - `packages/core`, `ai`, `tools`, `channels` and `mcp-servers` do not exist yet.
   - E2E tests live in `e2e/` (Playwright), not `apps/api/test/e2e/`.
   - Validation uses the custom `ZodPipe`, not `nestjs-zod`.
   - There is no WhatsApp simulator script, and there won't be one (decided 2026-10-01, ADR 0015).
4. **Phase 11:** the plan says to replace barebones pages and pick shadcn/Tailwind or Mantine. Orbit Desk already took that role, using CSS Modules and no UI library (ADR 0005). Phase 11 now means finishing Orbit Desk; `apps/web` stays a barebones test console.
5. **Orbit Desk README:** it says lavender marks "breached SLAs", but SLA isn't shown anywhere yet.
6. **`docs/architecture.html`:** it describes the target. Where it names a technology, the build sometimes differs: email uses IMAP/SMTP, not Graph or Gmail push; events use a Postgres outbox with BullMQ, not Kafka. The map now shows what exists per component.

Deviations from the plan so far:

- Object storage is SeaweedFS (S3 API) instead of MinIO, which no longer publishes free images.

- Audit entries are written by services inside the change's transaction, not by an HTTP interceptor. This records field-level before/after values and can't be lost if the request fails.
- CI uses service containers instead of Testcontainers.
- No `organizations` table yet: single-tenant MVP (see ADR 0002).
- `skills` / `user_skills` move to Phase 7 with routing, where they are first used.
- The barebones web app uses a small fetch hook instead of TanStack Query; revisit in the frontend phase.
- Phase 2: the worker moved into the API codebase as a second entry point (ADR 0004). Dev mail uses GreenMail (support mailbox over IMAP) plus Mailpit (outgoing), because Mailpit has no IMAP. Chat sessions are created over the socket handshake rather than a REST call, so the widget needs no CORS setup on the REST API.

## Stack

| Concern               | Choice                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo              | pnpm workspaces + Turborepo                                                                                                                       |
| API                   | NestJS (Fastify adapter), OpenAPI via `@nestjs/swagger`, zod DTO validation (`nestjs-zod`)                                                        |
| DB                    | PostgreSQL 16 + **pgvector**; **Drizzle ORM** + drizzle-kit migrations (native pgvector support)                                                  |
| Queue / jobs / timers | Redis + **BullMQ** (worker process)                                                                                                               |
| Events                | Transactional **outbox** table in Postgres, relayed to BullMQ topics (swap to Kafka later without changing publishers)                            |
| Realtime              | Socket.IO gateway (Redis adapter) for Agent UI + web chat                                                                                         |
| Files                 | S3-compatible object storage (SeaweedFS locally; MinIO stopped publishing free images)                                                            |
| LLM                   | **LiteLLM proxy** container (OpenAI-compatible); app talks to it with the `openai` npm SDK                                                        |
| MCP                   | `@modelcontextprotocol/sdk` (client in Tool Gateway; sample servers in repo)                                                                      |
| Auth                  | Local accounts + JWT first, OIDC SSO in hardening; permission-based RBAC                                                                          |
| Secrets               | App-level AES-256-GCM envelope encryption (master key from env / later cloud KMS); LiteLLM stores provider keys encrypted with `LITELLM_SALT_KEY` |
| Web (barebones)       | Vite + React + React Router + TanStack Query, no styling library                                                                                  |
| Tests                 | Vitest, Testcontainers (Postgres/Redis), supertest; LiteLLM `mock_response` for deterministic AI tests                                            |
| Observability         | pino logs, OpenTelemetry traces/metrics; optional Langfuse via LiteLLM callback                                                                   |
| Dev mail / chat       | Mailpit (SMTP/IMAP sink). WhatsApp has no simulator: tests post signed webhooks to the real route (ADR 0015)                                      |

## Repo layout (original target)

Today the layout is `apps/api` (API **and** worker entry points), `apps/web`, `apps/orbit-desk`, `apps/chat-widget`, `packages/shared`, `packages/db`, `scripts/sample-data`, `e2e` and `infra`. The packages below are created when their phase needs them.

```
apps/
  api/            NestJS app (HTTP + Socket.IO); entrypoint main.ts
  worker/         BullMQ processors; imports modules from api via packages
  web/            barebones React (agent console, admin, settings)
  chat-widget/    embeddable web chat (vanilla TS bundle)
packages/
  db/             Drizzle schema, migrations, seed
  shared/         zod schemas: MessageEnvelope, events, ticket enums, permissions
  core/           domain modules (tickets, conversations, customers, routing, sla…)
  ai/             agent loop, prompts, classifiers, guardrails, LiteLLM client
  tools/          Tool Gateway, MCP client, connector registry, approvals
  channels/       adapters: webchat, email, whatsapp, voice
  mcp-servers/    sample MCP servers: orders, customers, payments (mock data)
infra/
  docker-compose.yml, litellm/config.yaml, otel/
docs/
  architecture.html (the published artifact), ADRs, runbooks
```

## Core data model (Phase 1, extended later)

`organizations` (single-tenant now, column kept for future) · `users` (agents) · `roles`, `role_permissions`, `user_roles` · `teams`, `team_members`, `skills`, `user_skills` · `customers` · `customer_identities` (type: email|phone|whatsapp|webchat_session|external_id, value, verified) · `tickets` (all §7 attributes: number, customer_id, channel, subject, description, category_id, subcategory_id, priority, status_id, sla_policy_id, team_id, assignee_id, resolution, tags[], timestamps) · `ticket_statuses` + `workflow_transitions` (configurable) · `categories` · `conversations` (ticket_id, channel, external_thread_id, **controller**: ai|human|none, controller_user_id, state) · `messages` (conversation_id, direction, author_type: customer|ai|agent|system, body, attachments, channel_message_id, delivery_status) · `internal_notes` · `audit_log` (append-only: actor, action, target, payload, trace_id) · `outbox_events`.
Later phases add: `llm_*`, `kb_*`, `tools`, `tool_calls`, `approvals`, `handovers`, `routing_rules`, `sla_policies`, `sla_timers`, `business_hours`, `notifications`, `reporting_*`.

---

## Phase 0 — Foundations

**Goal:** a repo anyone can clone and `docker compose up`.

- pnpm/Turbo monorepo, TS strict, ESLint + Prettier, Vitest, commit hooks.
- `infra/docker-compose.yml`: postgres (pgvector image), redis, S3 object store (SeaweedFS), mailpit, litellm (+ its own Postgres DB schema), otel-collector (optional profile).
- NestJS skeleton: config module (zod-validated env), health endpoints (`/health/live`, `/health/ready` checking DB/Redis/LiteLLM), pino logging with request/trace IDs, global error filter, OpenAPI at `/docs`.
- Worker skeleton with BullMQ connection and a heartbeat job.
- `packages/db` with Drizzle config, first empty migration, seed script.
- GitHub Actions CI: install, lint, typecheck, unit tests, integration tests with service containers.
- Commit `docs/architecture.html` (the artifact) and ADR-001 (stack), ADR-002 (modular monolith), ADR-003 (LiteLLM).
- SessionStart hook so cloud sessions can run tests.

**Exit:** `docker compose up` + `pnpm dev` → `/health/ready` is green; CI passes.

## Phase 1 — Core domain: users, RBAC, customers, tickets, audit, events

- Auth: login (argon2 hashed passwords), JWT access + refresh, `/me`.
- RBAC: permission strings (`ticket:read`, `ticket:assign`, `approval:refund`, `settings:llm`, …) in `packages/shared/permissions.ts`; guard decorator `@RequirePermission()`; seeded roles: agent, team_lead, supervisor, admin.
- Customers + identities; identity-resolution service (`resolveOrCreate(identity)`), merge endpoint.
- Tickets CRUD, search/filter/paginate, configurable statuses + transitions validated by a workflow service; default workflow from the brief (New → AI Handling → Human Assigned → In Progress → Pending Customer → Resolved → Closed).
- Conversations/messages tables (no channels yet), internal notes, tags, categories.
- **Audit log** interceptor for every mutating request; **outbox** writer used inside the same DB transaction as domain changes; worker relays outbox → BullMQ `events` queue.
- Barebones web: login, ticket list (table), ticket detail (fields + history + notes), customer page.

**Exit:** create/assign/transition tickets through API and barebones UI; every change shows in `audit_log` and emits an event. Integration tests for workflow rules and RBAC denials.

## Phase 2 — Channel Gateway, Orchestrator, Web Chat + Email (human-only helpdesk)

- `MessageEnvelope` zod schema in `packages/shared` (channel, customer handle, conversation key, content parts, attachments, raw ref).
- Channel adapter interface: `receive(raw) → Envelope`, `send(conversation, OutboundMessage)`, `capabilities`. Idempotency via `channel_message_id` unique index.
- **Orchestrator** module: inbound pipeline (dedupe → resolve customer → find/open conversation+ticket → persist message → dispatch by `controller`), per-conversation ordering via BullMQ group/Redis lock, outbound pipeline (agent reply → adapter of originating channel → delivery status).
- **Web chat:** Socket.IO namespace `/chat`, anonymous or signed-JWT customer identity, `apps/chat-widget` minimal bundle + a demo HTML page.
- **Email:** IMAP (imapflow, IDLE) inbound + SMTP (nodemailer) outbound against Mailpit; thread matching by `Message-ID`/`In-Reply-To`/ticket number in subject; attachments to S3 storage. Graph/Gmail API adapters noted for later.
- Agent realtime: Socket.IO `/agent` namespace pushes new messages/ticket updates.
- Barebones web: conversation view with message thread + reply box.

**Exit:** customer chats from widget and emails Mailpit → tickets appear; agent replies from barebones UI and the reply reaches the originating channel.

## Phase 3 — LLM platform on LiteLLM (settings dashboard for keys)

- LiteLLM proxy run with `store_model_in_db: true`, master key + salt key from env; routing strategy `simple-shuffle`/`usage-based-routing-v2`, retries, fallbacks, cooldowns configured in `infra/litellm/config.yaml`.
- **LLM Settings module** (API; permission `settings:llm`):
  - `providers`: add provider credential (OpenAI, Anthropic, Gemini, Mistral, NVIDIA NIM, OpenAI-compatible/local e.g. Ollama/vLLM/LM Studio with base URL). Keys go to LiteLLM via its `/credentials` + `/model/new` admin API; our DB keeps only metadata (provider, label, last-4, created_by) — keys never returned to the browser.
  - `models`: register deployments (`litellm_params.model` like `anthropic/…`, `gemini/…`, `nvidia_nim/…`, `ollama/gemma…`), rpm/tpm limits, weights.
  - **Model roles** (app-level): `chat_agent`, `classifier`, `summarizer`, `embedding`, `copilot` → each maps to a LiteLLM model group alias with fallback list. Multiple deployments per group = load balancing.
  - "Test connection" endpoint (tiny completion/embedding call) and capability check (`/model/info`: supports function calling, vision, JSON mode, context window). Warn when a model assigned to `chat_agent` lacks tool calling.
  - Usage/cost read from LiteLLM spend logs; per-role budgets.
- `packages/ai/llm-client.ts`: `openai` SDK with `baseURL=LITELLM_URL`, per-call metadata (ticket_id, role, trace_id) for spend attribution; timeouts; every call written to `llm_calls` (model, tokens, latency, cost, status).
- Barebones web: Settings → Providers / Models / Roles forms, test button, usage table.

**Exit:** admin adds an OpenAI key and a local Ollama model from the UI, assigns both to `chat_agent`, and a test call succeeds; disabling one provider falls back to the other.

## Phase 4 — Knowledge Base (RAG)

- Sources: file upload (PDF, DOCX, MD, HTML, TXT), URL fetch, manual FAQ entries; connector interface for SharePoint/Confluence/Drive later.
- Ingestion job: extract text (pdf-parse, mammoth), chunk (heading-aware, ~500–800 tokens, overlap), embed via LiteLLM `embedding` role, store in `kb_chunks` (pgvector, HNSW index) + Postgres full-text `tsvector`.
- Hybrid search (vector + BM25-ish ts_rank, reciprocal rank fusion), optional reranker role later; **permission filter** by document visibility (public / internal / team).
- Document versioning, re-index on change, approval status (only `approved` docs used by the AI).
- Search API used by both AI and agents; returns citations (doc, section, url).
- Barebones web: KB documents list, upload, status, search box.

**Exit:** upload a returns-policy PDF; search returns the right chunk with citation; eval script reports recall@5 on a small labelled question set.

## Phase 5 — AI Agent (first-level support)

- Agent loop in `packages/ai/agent.ts`: build context (customer profile, ticket, last N messages + rolling summary, retrieved KB), call LiteLLM `chat_agent` with tools, execute tool calls (Phase 6 wires real tools; now: `search_knowledge`, `update_ticket`, `ask_clarifying_question`, `request_human`), loop with max steps/timeouts.
- Classification/prioritisation job on new tickets (`classifier` role, JSON-schema output with fallback parsing) → category, sub-category, priority, language, intent, sentiment.
- **Guardrails:** system prompt policy, data-scope rules (only the customer's own data), PII redaction in logs, output checks (no unsupported promises), confidence score = combination of model self-assessment + retrieval score + rule hits; below threshold → draft-only / handover.
- Channel-aware response style (email formal+signature, chat short).
- Conversation memory: rolling summary stored on conversation.
- Every AI step audited: prompt version, model used, tools called, retrieved chunk IDs.
- Orchestrator: when `controller=ai`, inbound messages go to the agent job; the ticket moves to `AI Handling`.
- Prompts versioned in repo (`packages/ai/prompts/*.md`), config per org (tone, allowed actions, auto-send on/off per channel).
- **Eval harness**: golden conversations in `packages/ai/evals/*.yaml` run against mock and real models; CI runs the mock suite.
- Barebones web: ticket view shows AI actions timeline and classification.

**Exit:** "Order status on chat" scenario works up to the tool call (answered from KB for now); email triage classifies and drafts replies.

## Phase 6 — Tool Gateway, MCP & approvals

- Tool registry (`tools` table): name, source (mcp server | REST connector), JSON input/output schema, auth method, required permission, **risk tier** (read | write | transactional), timeout, retries, enabled per role.
- MCP client manager: connect to registered MCP servers (streamable HTTP/stdio), sync tool lists, map to OpenAI tool format for LiteLLM.
- REST/GraphQL connector: declarative config (endpoint, method, param mapping, auth ref) for systems without MCP.
- Credentials: stored encrypted (`secrets` table, AES-GCM, key from env/KMS), injected at call time, never in prompts or logs.
- Execution pipeline: validate input (zod from JSON schema) → authorize (customer scope + role) → risk check → execute with timeout/retry/circuit breaker → validate output → audit `tool_calls`.
- **Approval queue** for transactional tools: `approvals` table, AI tells customer it's pending, supervisors approve/reject (permission `approval:<tool>`), expiry job, resume the agent loop with result.
- `packages/mcp-servers`: sample `orders`, `customers`, `payments` MCP servers with seed data (customer lookup, order status, payment status, issue_refund) to demo end-to-end; real CRM/ERP/OMS connectors are integration work per system.
- Barebones web: Tools admin (enable, tier, test call), Approvals inbox.

**Exit:** "Order status on chat" and "Refund with approval" scenarios run end-to-end with audit entries for every call.

## Phase 7 — Handover, routing, SLA, notifications

- **Handover triggers** (§8): explicit request (intent), low confidence, missing info, business rule, approval required, negative sentiment / repeated failure counter, system errors, configurable rules.
- **Context pack** generation (`summarizer` role): customer, history, summary, intent, ticket info, actions done, tools used, data retrieved, recommended next action → `handovers` table.
- Controller switching: take over (agent), hand back to AI, AI muted while human controls; race-safe via row lock.
- **Routing engine:** ordered rules on category, priority, customer type, language, channel, product, team; skills-based queues; agent presence (online/away/capacity) via Socket.IO; assignment strategies (round-robin, least-loaded); manual reassign/escalate.
- **SLA:** policies per priority/customer type, business hours + holidays, first-response & resolution timers as BullMQ delayed jobs, pause on `Pending Customer`, breach/at-risk events.
- **Notifications:** in-app (Socket.IO) + email; events: new ticket, assignment, escalation, SLA breach, approval needed.
- AI copilot for agents: suggested reply + KB search from the ticket view (`copilot` role).
- Barebones web: queue view, presence toggle, take-over / hand-back buttons, context pack panel, routing rules & SLA config forms, notification list.

**Exit:** "WhatsApp to human"-style flow works on web chat: customer asks for a person → routed → agent takes over → replies; SLA breach notification fires in a test with shortened timers.

## Phase 8 — WhatsApp channel

- Meta WhatsApp Cloud API adapter: webhook verify + signature (`X-Hub-Signature-256`), inbound text/media, statuses (sent/delivered/read), outbound text/media, **24-hour window** tracking and approved template messages outside it, template registry.
- Media download to S3 storage; phone-number identity resolution.
- ~~Dev simulator script posting signed webhook payloads~~ (dropped on 2026-10-01: no simulator and no fake Graph API); Meta's test number for real testing.
- Settings: WhatsApp business number(s), tokens (encrypted), templates.

**Exit:** the "WhatsApp to human" scenario passes in the integration tests (signed webhooks, the real queue, worker and sender), and works against a Meta test number once an app is connected (`docs/runbooks/phase-8-demo.md`).

## Phase 9 — Reporting & admin configuration

- Event consumers write reporting tables (`fact_tickets`, `fact_messages`, `fact_handovers`, `fact_tool_calls`, daily rollups).
- Metrics from §13: totals by channel/category/status, AI-resolved vs human-resolved, handover rate, avg first response & resolution time, SLA compliance, agent workload, AI/tool usage & LLM cost, escalation trends, CSAT (post-resolution survey on chat/email).
- Reports API with filters + CSV export.
- Admin config consolidated: statuses/workflows, categories, teams, skills, business hours, AI behaviour (auto-send per channel, confidence threshold), retention.
- Barebones web: reports page with plain tables.

**Exit:** reports match seeded scenario data in an automated test.

## Phase 10 — Hardening & MVP release readiness

- Security: OIDC SSO (Entra ID/Okta), MFA via IdP, rate limiting, CSRF/CORS, helmet, webhook signature checks everywhere, field-level encryption for sensitive customer data, data retention & deletion jobs, `pnpm audit`/Snyk, security review.
- Observability: OTel traces across API → worker → LiteLLM → tools, dashboards (Grafana), alerts (channel delivery failures, LLM error rate, queue lag, SLA breaches).
- Reliability: DLQs, idempotent consumers, graceful shutdown, backups, load test (k6) for chat latency and ingest throughput.
- AI quality: expanded eval suite, red-team prompts (prompt injection via customer messages and KB docs), regression gate in CI.
- Deployment: production Dockerfiles, compose profile for staging; cloud target decision + IaC skeleton (Terraform) and runbooks.

**Exit:** all five artifact scenarios (except voice) pass as automated E2E tests; load and security checks signed off.

## Phase 11 — Frontend implementation (final)

> Update (ADR 0005): Orbit Desk (`apps/orbit-desk`) is now the product console, built on `docs/DESIGN.md` with CSS Modules and no UI library. This phase finishes it: workspace, settings, reports, approvals, KB search. `apps/web` stays a barebones test console.

- Replace barebones pages with the designed product: design system/tokens, component library (e.g. shadcn/ui + Tailwind or Mantine — decide at phase start), accessibility (WCAG 2.1 AA), dark mode.
- Unified Agent UI: 3-pane workspace (queue / conversation / customer + AI context), keyboard shortcuts, live typing, take-over UX, approvals, copilot, KB search.
- Admin & settings UI (including the LLM providers/models/roles dashboard), reports with charts, branded chat widget.
- Playwright E2E for the core flows.

## Follow-on (brief's "Phase 2")

Voice channel (SIP/CCaaS e.g. Twilio/Exotel, streaming STT/TTS via LiteLLM audio endpoints or dedicated providers, live transfer/bridging to agent softphone), advanced analytics, sentiment/intent trends, more enterprise connectors, advanced AI workflows. The channel adapter and controller design from Phases 2/7 is built so voice plugs in as another adapter.

---

## Cross-cutting conventions (all phases)

- Every module: service + controller + zod schemas + tests; mutations go through a service that writes audit + outbox in one transaction.
- No module reads another module's tables directly; use its service (keeps a future service split possible).
- Feature flags per channel/AI capability in config.
- Each phase: ADR for notable choices, README update, seed data for its demo scenario.

## Verification (per phase and overall)

- `pnpm lint && pnpm typecheck && pnpm test` (unit) and `pnpm test:int` (Testcontainers) in CI on every push.
- Phase exit demos are scripted as Playwright specs in `e2e/tests` against the Docker stack loaded with `pnpm sample:load` (ADR 0007). They use the chat widget, the Mailpit API, signed WhatsApp webhooks and the scripted model, so they run offline in CI. API-level checks live in `apps/api/test/*.int.test.ts`.
- A manual demo checklist per phase in `docs/runbooks/phase-N-demo.md`, mirroring the scenarios in the architecture artifact.
