# TMS Implementation Plan (phased)

## Context
The brief (forwarded email "Sub") asks for an omnichannel Ticket Management System: Email, WhatsApp, Web Chat and Voice channels, an AI Agent for first-level support that uses a knowledge base and MCP/API tools, AI-to-human handover, a unified Agent UI, routing/SLA, reporting, and RBAC/audit. We already published the target architecture as an interactive artifact (https://claude.ai/artifact/LCpSt9syuh5wmwAXRqQ5gH; source in scratchpad `tms-architecture.html`). The repo `ticketing-sys` is empty (README only), so this plan builds everything from scratch, following that architecture.

Decisions confirmed with the user:
- **TypeScript / Node** backend, **modular monolith** (one API + one worker process, clear internal modules).
- **LiteLLM** as the LLM layer: load balancing, fallbacks, many providers (OpenAI, Anthropic, Gemini, Gemma, Mistral, NVIDIA NIM, local via Ollama/vLLM/LM Studio). Admins enter API keys in a dashboard settings page.
- **Docker Compose first**, cloud later.
- **UI stays barebones** (unstyled React pages) until the final Frontend phase.

Work happens on branch `claude/pensive-planck-yp2tyi`; each phase ends with a commit/push and a working demo.

## Stack
| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| API | NestJS (Fastify adapter), OpenAPI via `@nestjs/swagger`, zod DTO validation (`nestjs-zod`) |
| DB | PostgreSQL 16 + **pgvector**; **Drizzle ORM** + drizzle-kit migrations (native pgvector support) |
| Queue / jobs / timers | Redis + **BullMQ** (worker process) |
| Events | Transactional **outbox** table in Postgres, relayed to BullMQ topics (swap to Kafka later without changing publishers) |
| Realtime | Socket.IO gateway (Redis adapter) for Agent UI + web chat |
| Files | MinIO (S3 API) |
| LLM | **LiteLLM proxy** container (OpenAI-compatible); app talks to it with the `openai` npm SDK |
| MCP | `@modelcontextprotocol/sdk` (client in Tool Gateway; sample servers in repo) |
| Auth | Local accounts + JWT first, OIDC SSO in hardening; permission-based RBAC |
| Secrets | App-level AES-256-GCM envelope encryption (master key from env / later cloud KMS); LiteLLM stores provider keys encrypted with `LITELLM_SALT_KEY` |
| Web (barebones) | Vite + React + React Router + TanStack Query, no styling library |
| Tests | Vitest, Testcontainers (Postgres/Redis), supertest; LiteLLM `mock_response` for deterministic AI tests |
| Observability | pino logs, OpenTelemetry traces/metrics; optional Langfuse via LiteLLM callback |
| Dev mail / chat | Mailpit (SMTP/IMAP sink), WhatsApp webhook simulator script |

## Repo layout (target)
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
- `infra/docker-compose.yml`: postgres (pgvector image), redis, minio, mailpit, litellm (+ its own Postgres DB schema), otel-collector (optional profile).
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
- **Email:** IMAP (imapflow, IDLE) inbound + SMTP (nodemailer) outbound against Mailpit; thread matching by `Message-ID`/`In-Reply-To`/ticket number in subject; attachments to MinIO. Graph/Gmail API adapters noted for later.
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
- Media download to MinIO; phone-number identity resolution.
- Dev simulator script posting signed webhook payloads; sandbox number for real testing.
- Settings: WhatsApp business number(s), tokens (encrypted), templates.

**Exit:** full "WhatsApp to human" scenario against the simulator and a Meta test number.

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
- Phase exit demos scripted as E2E tests in `apps/api/test/e2e/` using the chat widget socket client, Mailpit API, WhatsApp simulator and LiteLLM `mock_response` so they run offline in CI.
- A manual demo checklist per phase in `docs/runbooks/phase-N-demo.md`, mirroring the scenarios in the architecture artifact.
