# ticketing-sys

Ticket Management System for companies: an omnichannel helpdesk (email, WhatsApp, web chat, voice calls in the browser, phone calls) where an AI agent handles first-level support, calls company systems through governed MCP/API tools, and hands off to human agents in one workspace.

It is built to be plugged into an app you already have. Your app raises tickets, reports its own failures, shows the chat on its pages and lends the AI its tools, all through a public integration API. TMS holds no code for any particular app.

- Architecture map (open in a browser): [`docs/architecture.html`](docs/architecture.html)
- Connecting your app: [`docs/integration/README.md`](docs/integration/README.md)
- Phased build plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Decisions: [`docs/adr/`](docs/adr)
- Licence: [MIT](LICENSE)

## Use it with your own app

This repository is a template. Press **Use this template** on GitHub, or clone it, then:

1. **Start the stack.** You need Docker with Compose v2 and nothing else.

   ```bash
   docker compose -f infra/docker-compose.yml --profile app up -d --build
   ```

   Open Orbit Desk at http://localhost:8081 and sign in as `admin@example.com` / `ChangeMe123!`. The first start loads a small fictional company; set `SEED_DEMO_DATA=false` for an empty desk.

2. **Name your company.** Settings → Customers sets the company name and the sign-off that the help center and the AI use.
3. **Add a model.** Settings → AI providers takes a key for Anthropic, OpenAI, Gemini, Mistral, Groq and others; then pick a model under Models & roles. With no key, `pnpm sample:load` (it needs Node 22 and pnpm) registers a scripted Demo model, so you can click through everything offline.
4. **Give the AI something to know.** Knowledge base: upload documents, add FAQ entries, or connect a source (a website, GitHub, Notion, Google Drive, S3-compatible storage, a folder, PostgreSQL or MySQL).
5. **Connect your app.** Settings → Integrations → **Add integration**, then **Create key** with the scope `integration:ticket`. The key is shown once. From your server:

   ```bash
   curl -X POST http://localhost:3000/api/v1/integration/tickets \
     -H "Authorization: Bearer $TMS_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{
       "customer": { "externalId": "user-42", "name": "Asha Verma", "email": "asha@example.com" },
       "subject": "Where is my order?",
       "body": "I ordered on Monday and have heard nothing.",
       "externalRef": "ORDER-1001"
     }'
   ```

   The ticket appears in Orbit Desk with an answer the AI drafted for a person to send. To let the AI answer app tickets by itself, set that channel to "auto" under Settings → AI behaviour. Your app reads the answer back or is told by a signed webhook.

6. **Put the chat on your pages.** The same integration page shows the snippet:

   ```html
   <script src="http://localhost:8080/widget/tms-chat.js"></script>
   <script>
     TMSChat.init({ integration: 'your-identifier' });
   </script>
   ```

7. **Let the AI act in your app.** Settings → Tools & MCP → new custom tool. Describe what you want in the **AI helper** ("look up an order by its number") and it fills in the form; if your app serves an `openapi.json`, the helper reads the routes from it. A tool starts switched off, and you choose its risk: read only, changes data, or needs a supervisor's approval.

When your app runs on the same machine outside Docker, the stack reaches it as `host.docker.internal`, and tools may only call hosts you allow. Put this in `infra/.env` before step 1 (`CORS_ORIGINS` is needed only when your own pages call the API directly; add their address to it):

```bash
TOOL_PRIVATE_HOSTS=fake-providers,host.docker.internal
CORS_ORIGINS=http://localhost:8080,http://localhost:8081,http://localhost:5173
```

Webhooks to `host.docker.internal` are allowed by default. Anything else an app is given must be a public `https` address. The full guide, with incidents, webhooks, signed-in visitors, phone numbers and the Node and Python clients, is [`docs/integration/README.md`](docs/integration/README.md).

## Status

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | State   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker Compose infra, API/worker skeletons, CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Done    |
| 1     | Auth + RBAC, customers, tickets + workflow, audit log, outbox events, barebones UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Done    |
| 2     | Channel gateway + orchestrator, web chat widget, email (IMAP/SMTP), agent replies, live updates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Done    |
| —     | Orbit Desk console wired to the API (ADR 0005), reports overview (ADR 0006), sample data + Playwright E2E suite (ADR 0007)                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Done    |
| 3     | LLM platform on LiteLLM, Settings for AI and channel keys, cheapest-first routing with per-provider caps (ADR 0008, 0009)                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done    |
| 4     | Knowledge base: uploads, URL and FAQ sources, review, pgvector hybrid search with citations (ADR 0010)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Done    |
| 5     | AI agent: answers chat, drafts email, hands over; confidence policy, classifier, AI marks in Orbit Desk (ADR 0011)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Done    |
| 5b    | Help center: public request form (channel `web_form`) with attachments, email acknowledgement and replies (ADR 0012)                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Done    |
| 6     | Tools over MCP (Demo Store sample server), risk tiers, supervisor approvals, AI follow-ups (ADR 0013)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Done    |
| 7     | Handover with context packs, take-over/hand-back, routing (rules, skills, presence), SLA timers, notifications, copilot, AI-vs-human views (ADR 0014)                                                                                                                                                                                                                                                                                                                                                                                                                                   | Done    |
| 8     | WhatsApp on the Meta Cloud API (ported from whatsapp-crm): signed webhook, media, delivery and read reports, 24-hour window, templates (ADR 0015)                                                                                                                                                                                                                                                                                                                                                                                                                                       | Done    |
| 8b    | Channel status lights (green, amber, red, grey) with per-channel checks, a connection monitor, and one-step "Connect WhatsApp" (ADR 0016)                                                                                                                                                                                                                                                                                                                                                                                                                                               | Done    |
| 8c    | Custom tools: HTTP requests defined in Settings that the AI can use, through the same gateway as MCP tools; a `tool:create` permission admins can grant to other roles (ADR 0017)                                                                                                                                                                                                                                                                                                                                                                                                       | Done    |
| 9     | Voice calls in the browser on Sarvam speech: answered by the AI in 11 languages, barge-in, an agent can join by voice, transcripts and recordings on the ticket (ADR 0018)                                                                                                                                                                                                                                                                                                                                                                                                              | Done    |
| 10    | Reports (the AI next to the team: resolution, handover, SLA, ratings, cost; CSV export), customer ratings, the customer portal (sign-in link, my requests, reply, rate), admin pages for people, teams, categories and the workflow; the AI resolves tickets it answered (ADR 0019)                                                                                                                                                                                                                                                                                                     | Done    |
| 10b   | Learning from ratings: badly rated topics and documents make the AI ask a person first; reviewers turn rated tickets into lessons the AI follows or knowledge base drafts; ratings per agent in Reports (ADR 0020)                                                                                                                                                                                                                                                                                                                                                                      | Done    |
| 11    | Hardening: rate limits and sign-in lockout, data retention, a failed-jobs view, guards against prompt injection with red-team tests, tracing from the API through the worker to the model, a dependency audit in CI (ADR 0021)                                                                                                                                                                                                                                                                                                                                                          | Done    |
| 12    | AWS live demo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Planned |
| 13    | Integration platform: integrations with scoped API keys, a ticket API, incident intake, signed webhooks, a themable chat widget with an identity secret per integration, `@tms/sdk` and a Python client (ADR 0022 to 0026)                                                                                                                                                                                                                                                                                                                                                              | Done    |
| 14    | Proof with an outside app, and what it led to: tools act only for customers the app has named (ADR 0027, 0028); guardrails before the model and answers without one (ADR 0029, 0030); teams that own their tickets and priority rules (ADR 0031, 0032); knowledge connectors (ADR 0033); phone identity and WhatsApp picture cards (ADR 0034, 0035); an AI helper for the tool forms (ADR 0036); addressing customers by name and listening to voice messages (ADR 0037, 0038); phone calls on real numbers through Sarvam and ElevenLabs agents, inbound and outbound (ADR 0039, 0040) | Done    |
| 15    | Multi-tenancy: one installation, many companies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Planned |

WhatsApp, voice and phone calls are built but switched off until you connect a Meta app and save a Sarvam or ElevenLabs key; none of them has a simulator. One installation serves one company. The full gap list is in the [reality check](docs/IMPLEMENTATION_PLAN.md#reality-check-30-september-2026).

## Layout

```
apps/
  api/          NestJS (Fastify) codebase with two entry points:
                  dist/main.js    HTTP API + Socket.IO  → http://localhost:3000/api/v1, docs at /docs
                  dist/worker.js  background worker: outbox relay, delivery, mailbox polling
  web/          Barebones React test console           → http://localhost:5173
  orbit-desk/   Orbit Desk: the product console        → http://localhost:5175 (design: docs/DESIGN.md)
  chat-widget/  Embeddable web chat widget (one script tag)
  help-center/  Customer pages: request form, portal, rating  → http://localhost:8080/help/
  fake-providers/  Scripted LLM and a sample tool server, for demos and tests without keys
packages/
  shared/       Zod schemas, permissions, workflow defaults, channel envelope, event contracts
  db/           Drizzle schema, SQL migrations, seed
  sdk/          @tms/sdk: client for the integration API, webhook verification, chat identity tokens
docs/integration/     Guide for connecting an outside app: tickets, incidents, webhooks, chat widget
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

Override defaults with environment variables or a `.env` next to the compose file: `JWT_SECRET` and `CHAT_IDENTITY_SECRET` (set both for anything shared), `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_DATA`, `API_DOCS`, `LOG_LEVEL`, and the `EMAIL_*` settings to point at a real mailbox.

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
- **Models & roles:** register models and decide what each AI feature uses. **Add model** lists the provider's chat and embedding models with their prices (from LiteLLM's model list), **Test model** asks the provider whether your key may use one before you add it, and a name the list lacks can still be typed.
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
  - between 60% and 80%, or on email, it becomes a draft that an agent sends, edits or discards. On chat and WhatsApp the customer is told once that a member of the team will reply, so they are not left in front of a silent chat;
  - below 60%, or when the customer asks for a person, the AI hands over with an internal note.
- **Guardrails:** replies that promise refunds or dates no tool confirmed are never sent. Every customer message is screened before any model sees it: an attempt to override the AI's instructions, abuse or spam gets a warning and then ends the conversation (ADR 0029).
- **Hands over only when it must:** a request for a person gets one offer of help first; small talk, FAQ questions and repeated questions are answered without a model (ADR 0030).
- **Closing:** an answer that settles the request ends with "anything else?". A no, or a quiet period per channel, resolves the ticket.
- **Voice messages** on WhatsApp are written down before the AI answers (ADR 0038).
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
- **Approvals:** a needs-approval tool (such as a refund) doesn't run. It waits in **Approvals** (`#/approvals`) and inline in the ticket drawer, for the tool's approving team or, when it has none, the team that owns the ticket; a request with no team goes to supervisors (ADR 0031). Once someone approves, the worker runs it and the AI tells the customer the result. Rejected and expired requests are handled too.
- **Custom tools:** a tool can also be a plain HTTP request defined in Settings → Tools & MCP (address with `{placeholders}`, values the AI fills in, optional key). It gets the same checks, tiers and approvals. Admins create them; other roles can once an admin ticks them under "Who can create custom tools" (ADR 0017, [`docs/runbooks/phase-8c-demo.md`](docs/runbooks/phase-8c-demo.md)).
- **AI helper:** beside both forms, a helper fills in the form from a description, reads a system's `openapi.json`, and offers the key of a tool already saved for the same host. It never saves or switches on anything. **Check connection** tries the address without changing the other system, and **Diagnose with AI** explains a failed check and saves it as a ticket (ADR 0036).
- **Demo:** the sample data registers **Demo Store systems**, a fictional order and payment server inside `fake-providers`. Try "Where is my order DS-20517?" or "I was charged twice for order DS-20533" in the widget.

See [`docs/runbooks/phase-6-demo.md`](docs/runbooks/phase-6-demo.md).

## Handover, routing and SLA

- **Handover:** when the AI (or an agent) hands over, the ticket is routed. Ordered rules pick a team; an online agent with the skill and room under their capacity is chosen. The person gets a notification, and the drawer shows a **context pack**: a summary, what was done and the next step.
- **Taking over:** agents take a conversation over from the AI or the queue, and only one person can. They can hand it back to the AI, pass it to another team, or escalate it.
- **SLA:** first-response and resolution targets per priority and customer type, counted in business hours (time zone, holidays) and paused while waiting on the customer. At 80% the ticket is at risk; at 100% it is breached. The assignee and team leads are told, and breaches are also emailed.
- **AI vs human:** the queue filters by who is handling each ticket and shows SLA countdowns. The drawer can show the conversation as **AI | People** lanes, and history filters by who acted.
- **Teams own their tickets:** a team's members and super admins act on its tickets; everyone else can read and add notes. Approvals go to the tool's approving team, and each decision carries a reason for the customer (ADR 0031).
- **Priority rules:** an ordered list sets a ticket's priority from its channel, category, words, intent or sentiment, and only raises it afterwards (ADR 0032).
- **Where to set it up:** Settings → Routing, SLA, Teams and Priority.

See [`docs/runbooks/phase-7-demo.md`](docs/runbooks/phase-7-demo.md).

## Reports, ratings and the customer portal

- **Reports** (Orbit Desk → Reports, team leads and up): what the AI resolved alone, what it passed to a person, first reply and time to final answer, SLA, customer ratings and AI cost, for a period, a channel or a team. The ticket list behind the figures exports as CSV.
- **The AI resolves what it answered:** a ticket the AI answered and the customer then left alone is resolved by the AI: after 10 minutes of silence on web chat and WhatsApp, 30 on email, and 72 hours elsewhere. Settings → AI behaviour sets the quiet time per channel (0 means never). A later reply reopens it.
- **Ratings:** when a ticket is solved the customer is asked once to rate it from 1 to 5: in the chat window, or by email. Only customers can rate; agents see the rating on the ticket, and a 1 or 2 notifies the assignee and team leads.
- **Customer portal:** http://localhost:8080/help/#/portal ("My requests"). A customer enters their email, opens the one-time link we send, and sees their own tickets from every channel, can reply and rate. In development the link arrives in Mailpit (http://localhost:8025).
- **Admin pages:** Settings → People (users, teams), Tickets (categories, statuses, allowed moves) and Customers (portal, ratings, the time-saved estimate).
- **Learning from ratings** (Orbit Desk → Learning, supervisors and admins): ratings feed back into the AI. By itself the system only makes the AI more careful: answers on a topic or from a document customers rated badly go to a person first. What the AI says changes only through a person: a reviewer turns a low-rated answer into a short lesson the AI follows, or a well-rated human answer into a knowledge base draft. Customers' comments are never given to the AI. Reports also show ratings per agent, for coaching. See ADR 0020 and [`docs/runbooks/phase-10b-demo.md`](docs/runbooks/phase-10b-demo.md).

`HELP_CENTER_URL` is the address used in emailed links. See ADR 0019 and [`docs/runbooks/phase-10-demo.md`](docs/runbooks/phase-10-demo.md).

## Security and operations

- **Rate limits:** the public routes (sign-in, request form, portal, rating page, WhatsApp webhook, chat and voice) are limited per network address; a refused call gets 429 and `Retry-After`. Ten wrong passwords lock an account for that address for 15 minutes. `RATE_LIMITS=off` switches them off (tests do).
- **Behind a proxy:** the API believes `X-Forwarded-For` only from proxies on a private network, so run it behind nginx or Caddy, never with port 3000 open to the internet.
- **Settings → System** (admins): background jobs that failed after every retry, with Retry and Remove; and how long logs are kept (model calls 90 days, notifications 90, delivered events 30, used sign-in links 7; recordings 30, fixed). The worker cleans up daily (`RETENTION_SWEEP_HOURS`). Tickets, messages and the audit log are never deleted.
- **The AI under attack:** a reply that repeats the AI's own instructions is dropped and the ticket goes to a person. `apps/api/test/evals/redteam.yaml` holds the attacks; they run in CI and, with real keys, in `pnpm ai:eval`.
- **Tracing:** set `OTEL_EXPORTER_OTLP_ENDPOINT` and one trace follows a request from the API through the worker to the model call. To see it locally:

  ```bash
  OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker compose -f infra/docker-compose.yml --profile app --profile observability up -d
  docker compose -f infra/docker-compose.yml --profile observability logs -f otel-collector
  ```

- **Dependencies:** CI runs `pnpm audit`.

See ADR 0021 and [`docs/runbooks/phase-11-demo.md`](docs/runbooks/phase-11-demo.md).

## Connecting an outside app

TMS plugs into an existing app through four things, each usable alone. The guide is [`docs/integration/README.md`](docs/integration/README.md).

- **API keys:** Settings → Integrations. An integration is one outside app; its keys (`tms_sk_…`, shown once) carry scopes and a per-minute limit, and work only on the integration routes (ADR 0022).
- **Tickets:** `POST /api/v1/integration/tickets` raises a ticket for one of the app's users in one call, with the app's own reference and context; the app reads the answer back or is told by webhook. It never reaches a ticket it did not raise (ADR 0023).
- **Incidents:** `POST /api/v1/integration/events` reports a failure by fingerprint. Repeats share one ticket, and a recovery closes it (ADR 0024).
- **Webhooks:** signed `POST`s for ticket, message, incident, approval and rating events, retried and logged ([`docs/integration/webhooks.md`](docs/integration/webhooks.md), ADR 0025).
- **Chat widget:** themed, aware of what the visitor is looking at, and able to recognise signed-in visitors with a secret per integration ([`docs/integration/widget.md`](docs/integration/widget.md), ADR 0026).
- **Clients:** `packages/sdk` for Node and `docs/integration/examples/python/tms_support.py` for Python (standard library only). Both are tested against `docs/integration/signature-vectors.json`.
- **Branding:** Settings → Customers names the company the help center and the AI speak for.

## Knowledge base

Orbit Desk → **Knowledge base** (`#/kb`) searches approved documents with citations, the same search the AI agent uses.

- **Managers** (`kb:manage`, supervisors and admins) add documents: PDF, Word, Markdown, HTML or text files, web pages, or FAQ entries. They also approve, archive and re-index them.
- **Indexing** runs in the worker: text extraction, heading-aware chunks, and embeddings through the Settings "Knowledge base embeddings" role. Search then combines pgvector similarity and full-text rank.
- **Sources:** Knowledge base → Sources keeps documents in step with a website or sitemap, GitHub, Notion, Google Drive, S3-compatible storage, a shared folder, PostgreSQL or MySQL (ADR 0033).
- **Visibility:** public documents may be quoted to customers; internal and team documents are for agents only.
- **In a ticket:** the drawer suggests articles and inserts a cited passage into the reply.

`pnpm kb:eval` reports recall@5 on labelled questions. See ADR 0010 and [`docs/runbooks/phase-4-demo.md`](docs/runbooks/phase-4-demo.md).

## Try the channels

- **Web chat:** open http://localhost:8080/widget/demo.html, click **Chat with us** and send a message. A ticket appears in the console (channel `webchat`) without a refresh; reply from the ticket page and the visitor sees it live.
- **Email:** `pnpm demo:email -- --subject "Where is my order?"` sends a customer email to `support@tms.local`. The worker picks it up within seconds and opens a ticket. Reply from the ticket page; the reply lands in Mailpit, threaded and tagged `[TMS-n]`. To answer as the customer, copy the reply's Message-ID from Mailpit: `pnpm demo:email -- --subject "Re: ..." --in-reply-to "<id>"`.
- **WhatsApp:** it needs a Meta app, and there is no simulator. Once connected in Settings → Channels:
  - customers' messages and files open tickets, and the AI or an agent replies;
  - each reply shows whether it was delivered and read, or why it failed;
  - more than 24 hours after the customer's last message, WhatsApp only allows approved templates, and the reply box offers those;
  - a company tool can return picture cards, which the AI shows with buttons (ADR 0035);
  - your app can prove that a customer owns a number with a code sent over WhatsApp, and the AI's customer tools then work for that number (ADR 0034).

  Setup steps are in [`docs/runbooks/phase-8-demo.md`](docs/runbooks/phase-8-demo.md); the design is ADR 0015.

- **Voice:** it needs a Sarvam API key (Settings → Channels → Sarvam voice), and calls use Sarvam credits. Then http://localhost:8080/widget/voice.html calls support from the browser:
  - the AI answers aloud in the caller's language (11 Indian languages and English) and stops when interrupted;
  - when the caller asks for a person, an agent joins the call from the ticket and talks to them;
  - the transcript lands on the ticket, with a recording supervisors can play for 30 days.

  Steps are in [`docs/runbooks/phase-9-demo.md`](docs/runbooks/phase-9-demo.md); the design is ADR 0018.

- **Phone calls:** a real number is answered by a voice agent at Sarvam or ElevenLabs. The agent has no knowledge of its own: it asks this desk for every fact, through the knowledge base and your tools, and the call becomes a ticket with its transcript and recording when it ends. The desk can also ring a customer from a ticket. You need an account and a number at the provider; set-up is in [`docs/runbooks/phone-agent.md`](docs/runbooks/phone-agent.md) (Sarvam) and [`docs/runbooks/phone-agent-elevenlabs.md`](docs/runbooks/phone-agent-elevenlabs.md); the design is ADR 0039 and ADR 0040.

- **Embedding the widget on a site:**
  ```html
  <script src="https://tms.example.com/widget/tms-chat.js"></script>
  <script>
    TMSChat.init({ server: 'https://tms.example.com', title: 'Chat with us' });
  </script>
  ```
  For logged-in visitors, pass `identityToken`: an HS256 JWT with `sub` (your customer id) and/or `email`, signed with your integration's chat secret (or `CHAT_IDENTITY_SECRET`). Only vouched-for identities link a chat to an existing customer. Options, themes and callbacks are in [`docs/integration/widget.md`](docs/integration/widget.md).

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

WhatsApp is tested without a stand-in for Meta: the tests post signed webhooks to the real route, and the integration tests answer calls to `graph.facebook.com` inside the test process. Voice is tested without a stand-in for Sarvam: the Sarvam client runs against a WebSocket server inside its unit test, and the integration tests swap in a scripted speech provider and use the real sockets and routes.

End-to-end tests (`e2e/`, Playwright) drive both consoles, the chat widget and the mailbox against a running stack loaded with sample data:

```bash
pnpm docker:up && pnpm sample:load
pnpm --filter @tms/e2e exec playwright install chromium   # once
pnpm e2e                                                  # report: e2e/playwright-report
```

On Windows hosts where `@swc/core` refuses its cache folder, run the CI check job in a Linux container instead: `bash scripts/check-in-docker.sh` (all steps) or `bash scripts/check-in-docker.sh test:int`. To use a Chromium that is already installed, set `CHROMIUM_PATH` for `pnpm e2e`.

They default to the Docker ports; point them elsewhere with `API_URL`, `ORBIT_URL`, `WEB_URL`, `WIDGET_URL`, `MAILPIT_URL`, `REDIS_URL` and `SMTP_HOST`/`SMTP_PORT`. The latest run is written up in [`docs/testing/TEST_REPORT.md`](docs/testing/TEST_REPORT.md).

## Conventions

- Every state change goes through a service that writes the change, an `audit_log` row and an `outbox_events` row in **one transaction**. The worker relays the outbox to the `domain-events` queue, where handlers (delivery, realtime fan-out, later SLA/AI) react.
- Channels only produce a `MessageEnvelope` (`packages/shared/src/channels.ts`); `InboundService` does the rest. Outbound messages are stored `pending` and delivered by the worker.
- Request and response contracts live in `packages/shared` as zod schemas; the API validates with `ZodPipe`, the web app imports the same types.
- Routes are authenticated by default. Use `@Public()` to opt out and `@RequirePermission('ticket:assign')` to require permissions.
- Schema changes: edit `packages/db/src/schema`, then `pnpm db:generate`, and commit the generated SQL in `packages/db/drizzle`.
