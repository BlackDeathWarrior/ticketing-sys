# ticketing-sys

Ticket Management System for companies: an omnichannel helpdesk (email, WhatsApp, web chat, later voice) where an AI agent handles first-level support, calls company systems through governed MCP/API tools, and hands off to human agents in one workspace.

- Architecture map (open in a browser): [`docs/architecture.html`](docs/architecture.html)
- Phased build plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Decisions: [`docs/adr/`](docs/adr)

## Status

| Phase | Scope                                                                                                                                                 | State   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker Compose infra, API/worker skeletons, CI                                                                                              | Done    |
| 1     | Auth + RBAC, customers, tickets + workflow, audit log, outbox events, barebones UI                                                                    | Done    |
| 2     | Channel gateway + orchestrator, web chat widget, email (IMAP/SMTP), agent replies, live updates                                                       | Done    |
| —     | Orbit Desk console wired to the API (ADR 0005), reports overview (ADR 0006), sample data + Playwright E2E suite (ADR 0007)                            | Done    |
| 3     | LLM platform on LiteLLM, Settings for AI and channel keys, cheapest-first routing with per-provider caps (ADR 0008, 0009)                             | Done    |
| 4     | Knowledge base: uploads, URL and FAQ sources, review, pgvector hybrid search with citations (ADR 0010)                                                | Done    |
| 5     | AI agent: answers chat, drafts email, hands over; confidence policy, classifier, AI marks in Orbit Desk (ADR 0011)                                    | Done    |
| 5b    | Help center: public request form (channel `web_form`) with attachments, email acknowledgement and replies (ADR 0012)                                  | Done    |
| 6     | Tools over MCP (Demo Store sample server), risk tiers, supervisor approvals, AI follow-ups (ADR 0013)                                                 | Done    |
| 7     | Handover with context packs, take-over/hand-back, routing (rules, skills, presence), SLA timers, notifications, copilot, AI-vs-human views (ADR 0014) | Done    |
| 8     | WhatsApp on the Meta Cloud API (ported from whatsapp-crm): signed webhook, media, delivery and read reports, 24-hour window, templates (ADR 0015)     | Done    |
| 8b    | Channel status lights (green, amber, red, grey) with per-channel checks, a connection monitor, and one-step "Connect WhatsApp" (ADR 0016)             | Done    |
| 9     | Voice agent on Sarvam STT/TTS, in the browser (see `docs/research/voice-sarvam.md`)                                                                   | Next    |
| 10    | Reporting (AI vs human, SLA, CSAT), admin settings, customer portal (sign-in link, my tickets, reply, rate)                                           | Planned |
| 11    | Hardening for the demo                                                                                                                                | Planned |
| 12    | AWS live demo                                                                                                                                         | Planned |

Not built yet, although the UI or schema hints at them: CSAT (Phase 10) and voice (Phase 9). WhatsApp is built but switched off until you connect a Meta app. The full gap list is in the [reality check](docs/IMPLEMENTATION_PLAN.md#reality-check-30-september-2026).

## Layout

```
apps/
  api/          NestJS (Fastify) codebase with two entry points:
                  dist/main.js    HTTP API + Socket.IO  → http://localhost:3000/api/v1, docs at /docs
                  dist/worker.js  background worker: outbox relay, delivery, mailbox polling
  web/          Barebones React test console           → http://localhost:5173
  orbit-desk/   Orbit Desk: the product console        → http://localhost:5175 (design: docs/DESIGN.md)
  chat-widget/  Embeddable web chat widget (one script tag)
packages/
  shared/       Zod schemas, permissions, workflow defaults, channel envelope, event contracts
  db/           Drizzle schema, SQL migrations, seed
scripts/sample-data/  Fictional demo data loader (pnpm sample:load)
e2e/                  Playwright suite against the running stack (pnpm e2e)
infra/
  docker-compose.yml   Postgres (pgvector), Redis, SeaweedFS (S3), GreenMail + Mailpit (dev mail), LiteLLM, OTel
```

## Run everything in Docker

Requirements: Docker with Compose v2. Nothing else is needed on the host.

```bash
pnpm docker:up     # or: docker compose -f infra/docker-compose.yml --profile app up -d --build
```

This builds the images from the root `Dockerfile`, starts the infrastructure, runs the `migrate` container (migrations + idempotent seed with demo data), then starts the API, worker and web console.

| What                        | URL                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| Web console                 | http://localhost:8080 (sign in as `admin@example.com` / `ChangeMe123!`)                         |
| Orbit Desk dashboard        | http://localhost:8081 (same accounts)                                                           |
| Chat widget demo page       | http://localhost:8080/widget/demo.html                                                          |
| Help center (request form)  | http://localhost:8080/help/: customers submit a request with files; replies come by email       |
| API                         | http://localhost:3000/api/v1 (health: `/api/v1/health/ready`)                                   |
| API docs                    | http://localhost:3000/docs                                                                      |
| Outgoing mail (Mailpit)     | http://localhost:8025: replies TMS sends to customers                                           |
| Support mailbox (GreenMail) | SMTP `localhost:3025`, IMAP `localhost:3143`, address `support@tms.local`                       |
| S3 object storage           | http://localhost:9000 (SeaweedFS; key `tms` / `tms-dev-secret`), filer UI http://localhost:8888 |
| LiteLLM proxy               | http://localhost:4000                                                                           |
| Fake providers              | http://localhost:4010: a scripted LLM so AI features work with no real keys (never real data)   |

Override defaults with environment variables or a `.env` next to the compose file: `JWT_SECRET` (set this for anything shared), `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_DATA`, `API_DOCS`, `LOG_LEVEL`, and the `EMAIL_*` settings to point at a real mailbox.

`pnpm docker:logs` follows the app logs; `pnpm docker:down` stops everything (add `-v` to the compose command to also delete the data volumes). Behind a TLS-intercepting corporate proxy, build with its CA: `docker build --secret id=extra_ca,src=/path/to/ca.pem ...`. Rate-limited by Docker Hub? Build with `--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-bookworm-slim --build-arg NGINX_IMAGE=mirror.gcr.io/library/nginx:1.27-alpine`.

## Sample data

`pnpm sample:load` fills a running stack with fictional demo data through the public API, so audit, outbox, realtime and email all behave as they do for real traffic:

- 4 teams, 7 agents and leads, 25 customers (invented people and companies on `example.*` domains).
- 40 tickets across every status, priority and channel, with assignments, internal notes, email replies and status changes.
- 3 web chats sent through the widget socket and 3 customer emails sent to the support mailbox.
- Ticket timestamps spread over the last 14 days (a dev-only SQL step; skip with `-- --no-backdate`).

Sign in as the admin, or as any sample user with the password `Sample-Passw0rd!`:

| User                          | Role       | Team     |
| ----------------------------- | ---------- | -------- |
| `maya.lindqvist@tms.example`  | Team lead  | Orders   |
| `priya.natarajan@tms.example` | Supervisor | Platform |
| `jonah.reyes@tms.example`     | Agent      | Orders   |
| `aiko.tanaka@tms.example`     | Agent      | Billing  |
| `nora.quist@tms.example`      | Agent      | Billing  |
| `sam.okafor@tms.example`      | Agent      | Returns  |
| `leo.martin@tms.example`      | Agent      | Platform |

The loader skips if the data is already there; to start over, `docker compose -f infra/docker-compose.yml --profile app down -v` and bring the stack up again. The data lives in `scripts/sample-data/data.ts`.

## AI providers and keys

Admins manage AI providers, models and channel credentials in Orbit Desk under **Settings** (`#/settings`):

- **AI providers:** add a key for Anthropic, OpenAI, Gemini, Mistral, Groq, NVIDIA NIM, OpenRouter, Sarvam, a local Ollama or any OpenAI-compatible endpoint.
  - Keys go to LiteLLM and are never shown again; only the last four characters appear.
  - Each provider can have a spending cap per day, week or month.
- **Models & roles:** register models (capabilities and prices come from LiteLLM) and decide what each AI feature uses.
  - By default a role uses the cheapest capable model and falls back to the next one.
  - Providers over their cap are skipped.
- **Channels:** a status light for every channel, and the settings for email, WhatsApp and Sarvam.
  - **Lights:** green means working, amber means working but something needs a look, red means not working, grey means off. Each channel lists what was checked and why a check failed. **Check now** tries the mail server and Meta at once; the worker also checks every five minutes and notifies admins when a working channel stops.
  - **Connect WhatsApp:** one form for the IDs and keys from Meta. They are checked with Meta and saved only when Meta accepts them. The card also shows the webhook address for Meta and the synced templates.
  - Keys are write-only.
- **Usage:** spend by provider and role, and the recent calls.

Keys are admin-only (`settings:secrets`), encrypted, and every change is audited. See ADR 0008 and ADR 0009. The sample data registers the scripted **Demo model** provider, so everything works offline. Walkthrough: [`docs/runbooks/phase-3-demo.md`](docs/runbooks/phase-3-demo.md).

## AI agent

When a model is configured (Settings), new web chats, WhatsApp chats and calls go to the AI agent, and emails get AI drafts.

- **Each turn:** the agent searches the knowledge base, calls tools, and ends with a reply and an honest confidence.
- **What happens next:**
  - at 80% or more on a channel that answers on its own, the reply is sent;
  - between 60% and 80%, or on email, it becomes a draft that an agent sends, edits or discards;
  - below 60%, or when the customer asks for a person, the AI hands over with an internal note.
- **Guardrails:** replies that promise refunds or dates no tool confirmed are never sent.
- **Classification:** new customer tickets get a suggested category, priority, language, intent and sentiment.
- **Visibility in Orbit Desk:** AI work shows an **AI** mark and is slightly dimmed; the drawer has "AI is replying", the classification and an "AI activity" list.
- **Settings → AI behaviour** sets each channel's mode and the thresholds, and has **Try the agent** for a dry run.

`pnpm ai:eval` runs the golden conversations against the configured models. See ADR 0011 and [`docs/runbooks/phase-5-demo.md`](docs/runbooks/phase-5-demo.md).

## Company tools and approvals

The AI can look up and act on company systems through MCP servers (ADR 0013).

- **Register a server:** an admin adds it in Orbit Desk → Settings → Tools & MCP, stores its token (write-only), and syncs its tools.
- **Switch tools on:** each tool starts off. The admin enables it and sets its risk:
  - read only;
  - changes data;
  - needs approval.
- **Customer binding:** TMS fills the customer's email into the tool from the ticket, so the AI can only reach that customer's data.
- **Approvals:** a needs-approval tool (such as a refund) doesn't run. It waits in **Approvals** (`#/approvals`, supervisors) and inline in the ticket drawer. Once someone approves, the worker runs it and the AI tells the customer the result. Rejected and expired requests are handled too.
- **Demo:** the sample data registers **Demo Store systems**, a fictional order and payment server inside `fake-providers`. Try "Where is my order DS-20517?" or "I was charged twice for order DS-20533" in the widget.

See [`docs/runbooks/phase-6-demo.md`](docs/runbooks/phase-6-demo.md).

## Handover, routing and SLA

- **Handover:** when the AI (or an agent) hands over, the ticket is routed. Ordered rules pick a team; an online agent with the skill and room under their capacity is chosen. The person gets a notification, and the drawer shows a **context pack**: a summary, what was done and the next step.
- **Taking over:** agents take a conversation over from the AI or the queue, and only one person can. They can hand it back to the AI, pass it to another team, or escalate it.
- **SLA:** first-response and resolution targets per priority and customer type, counted in business hours (time zone, holidays) and paused while waiting on the customer. At 80% the ticket is at risk; at 100% it is breached. The assignee and team leads are told, and breaches are also emailed.
- **AI vs human:** the queue filters by who is handling each ticket and shows SLA countdowns. The drawer can show the conversation as **AI | People** lanes, and history filters by who acted.
- **Where to set it up:** Settings → Routing and Settings → SLA.

See [`docs/runbooks/phase-7-demo.md`](docs/runbooks/phase-7-demo.md).

## Knowledge base

Orbit Desk → **Knowledge base** (`#/kb`) searches approved documents with citations, the same search the AI agent uses.

- **Managers** (`kb:manage`, supervisors and admins) add documents: PDF, Word, Markdown, HTML or text files, web pages, or FAQ entries. They also approve, archive and re-index them.
- **Indexing** runs in the worker: text extraction, heading-aware chunks, and embeddings through the Settings "Knowledge base embeddings" role. Search then combines pgvector similarity and full-text rank.
- **Visibility:** public documents may be quoted to customers; internal and team documents are for agents only.
- **In a ticket:** the drawer suggests articles and inserts a cited passage into the reply.

`pnpm kb:eval` reports recall@5 on labelled questions. See ADR 0010 and [`docs/runbooks/phase-4-demo.md`](docs/runbooks/phase-4-demo.md).

## Try the channels

- **Web chat:** open http://localhost:8080/widget/demo.html, click **Chat with us** and send a message. A ticket appears in the console (channel `webchat`) without a refresh; reply from the ticket page and the visitor sees it live.
- **Email:** `pnpm demo:email -- --subject "Where is my order?"` sends a customer email to `support@tms.local`. The worker picks it up within seconds and opens a ticket. Reply from the ticket page; the reply lands in Mailpit, threaded and tagged `[TMS-n]`. To answer as the customer, copy the reply's Message-ID from Mailpit: `pnpm demo:email -- --subject "Re: ..." --in-reply-to "<id>"`.
- **WhatsApp:** it needs a Meta app, and there is no simulator. Once connected in Settings → Channels:
  - customers' messages and files open tickets, and the AI or an agent replies;
  - each reply shows whether it was delivered and read, or why it failed;
  - more than 24 hours after the customer's last message, WhatsApp only allows approved templates, and the reply box offers those.

  Setup steps are in [`docs/runbooks/phase-8-demo.md`](docs/runbooks/phase-8-demo.md); the design is ADR 0015.

- **Embedding the widget on a site:**
  ```html
  <script src="https://tms.example.com/widget/tms-chat.js"></script>
  <script>
    TMSChat.init({ server: 'https://tms.example.com', title: 'Chat with us' });
  </script>
  ```
  For logged-in visitors, pass `identityToken`: an HS256 JWT with `sub` (your customer id) and/or `email`, signed with `CHAT_IDENTITY_SECRET`. Only vouched-for identities link a chat to an existing customer.

## Local development

Requirements: Node 22 (see `.nvmrc`), pnpm 9 (`corepack enable`), Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up            # Postgres, Redis, SeaweedFS, GreenMail, Mailpit, LiteLLM
pnpm build               # builds all packages (the API and worker run from apps/api/dist)
pnpm db:migrate
pnpm db:seed             # roles, default workflow, admin from SEED_ADMIN_*, demo data
pnpm dev                 # tsc --watch + API + worker + web (:5173) + widget dev page (:5174)
```

Sign in at http://localhost:5173 with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`.
Check `GET http://localhost:3000/api/v1/health/ready`: database and Redis must be `up`; LiteLLM and the worker are reported too.

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test                # unit tests
pnpm test:int            # integration tests against real Postgres, Redis, S3 and GreenMail
```

Integration tests need `pnpm infra:up` plus the fake LLM (`docker compose -f infra/docker-compose.yml --profile fake up -d fake-providers`), or at least `postgres redis objectstore greenmail litellm fake-providers`. They wipe and migrate the database at `TEST_DATABASE_URL` (default `postgres://tms:tms@localhost:5432/tms_test`) and use Redis db 15. Create the database once with `docker compose -f infra/docker-compose.yml exec postgres createdb -U tms tms_test`.

WhatsApp is tested without a stand-in for Meta: the tests post signed webhooks to the real route, and the integration tests answer calls to `graph.facebook.com` inside the test process.

End-to-end tests (`e2e/`, Playwright) drive both consoles, the chat widget and the mailbox against a running stack loaded with sample data:

```bash
pnpm docker:up && pnpm sample:load
pnpm --filter @tms/e2e exec playwright install chromium   # once
pnpm e2e                                                  # report: e2e/playwright-report
```

On Windows hosts where `@swc/core` refuses its cache folder, run the CI check job in a Linux container instead: `bash scripts/check-in-docker.sh` (all steps) or `bash scripts/check-in-docker.sh test:int`. To use a Chromium that is already installed, set `CHROMIUM_PATH` for `pnpm e2e`.

They default to the Docker ports; point them elsewhere with `API_URL`, `ORBIT_URL`, `WEB_URL`, `WIDGET_URL`, `MAILPIT_URL` and `SMTP_HOST`/`SMTP_PORT`. The latest run is written up in [`docs/testing/TEST_REPORT.md`](docs/testing/TEST_REPORT.md).

## Conventions

- Every state change goes through a service that writes the change, an `audit_log` row and an `outbox_events` row in **one transaction**. The worker relays the outbox to the `domain-events` queue, where handlers (delivery, realtime fan-out, later SLA/AI) react.
- Channels only produce a `MessageEnvelope` (`packages/shared/src/channels.ts`); `InboundService` does the rest. Outbound messages are stored `pending` and delivered by the worker.
- Request and response contracts live in `packages/shared` as zod schemas; the API validates with `ZodPipe`, the web app imports the same types.
- Routes are authenticated by default. Use `@Public()` to opt out and `@RequirePermission('ticket:assign')` to require permissions.
- Schema changes: edit `packages/db/src/schema`, then `pnpm db:generate`, and commit the generated SQL in `packages/db/drizzle`.
