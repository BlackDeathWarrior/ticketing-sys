# ticketing-sys

Ticket Management System for companies: an omnichannel helpdesk (email, WhatsApp, web chat, later voice) where an AI agent handles first-level support, calls company systems through governed MCP/API tools, and hands off to human agents in one workspace.

- Architecture map (open in a browser): [`docs/architecture.html`](docs/architecture.html)
- Phased build plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Decisions: [`docs/adr/`](docs/adr)

## Status

| Phase | Scope                                                                                               | State   |
| ----- | --------------------------------------------------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker Compose infra, API/worker skeletons, CI                                            | Done    |
| 1     | Auth + RBAC, customers, tickets + workflow, audit log, outbox events, barebones UI                  | Done    |
| 2     | Channel gateway + orchestrator, web chat widget, email (IMAP/SMTP), agent replies, live updates     | Done    |
| 3     | LiteLLM platform and provider/model settings                                                        | Next    |
| 4–11  | Knowledge base, AI agent, tools/MCP, handover/routing/SLA, WhatsApp, reporting, hardening, frontend | Planned |

## Layout

```
apps/
  api/          NestJS (Fastify) codebase with two entry points:
                  dist/main.js    HTTP API + Socket.IO  → http://localhost:3000/api/v1, docs at /docs
                  dist/worker.js  background worker: outbox relay, delivery, mailbox polling
  web/          Barebones React agent console         → http://localhost:5173
  chat-widget/  Embeddable web chat widget (one script tag)
packages/
  shared/       Zod schemas, permissions, workflow defaults, channel envelope, event contracts
  db/           Drizzle schema, SQL migrations, seed
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
| Chat widget demo page       | http://localhost:8080/widget/demo.html                                                          |
| API                         | http://localhost:3000/api/v1 (health: `/api/v1/health/ready`)                                   |
| API docs                    | http://localhost:3000/docs                                                                      |
| Outgoing mail (Mailpit)     | http://localhost:8025: replies TMS sends to customers                                           |
| Support mailbox (GreenMail) | SMTP `localhost:3025`, IMAP `localhost:3143`, address `support@tms.local`                       |
| S3 object storage           | http://localhost:9000 (SeaweedFS; key `tms` / `tms-dev-secret`), filer UI http://localhost:8888 |
| LiteLLM proxy               | http://localhost:4000                                                                           |

Override defaults with environment variables or a `.env` next to the compose file: `JWT_SECRET` (set this for anything shared), `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_DEMO_DATA`, `API_DOCS`, `LOG_LEVEL`, and the `EMAIL_*` settings to point at a real mailbox.

`pnpm docker:logs` follows the app logs; `pnpm docker:down` stops everything (add `-v` to the compose command to also delete the data volumes). Behind a TLS-intercepting corporate proxy, build with its CA: `docker build --secret id=extra_ca,src=/path/to/ca.pem ...`.

## Try the channels

- **Web chat:** open http://localhost:8080/widget/demo.html, click **Chat with us** and send a message. A ticket appears in the console (channel `webchat`) without a refresh; reply from the ticket page and the visitor sees it live.
- **Email:** `pnpm demo:email -- --subject "Where is my order?"` sends a customer email to `support@tms.local`. The worker picks it up within seconds and opens a ticket. Reply from the ticket page; the reply lands in Mailpit, threaded and tagged `[TMS-n]`. To answer as the customer, copy the reply's Message-ID from Mailpit: `pnpm demo:email -- --subject "Re: ..." --in-reply-to "<id>"`.
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

Integration tests need `pnpm infra:up` (or at least `postgres redis objectstore greenmail`). They wipe and migrate the database at `TEST_DATABASE_URL` (default `postgres://tms:tms@localhost:5432/tms_test`) and use Redis db 15. Create the database once with `docker compose -f infra/docker-compose.yml exec postgres createdb -U tms tms_test`.

## Conventions

- Every state change goes through a service that writes the change, an `audit_log` row and an `outbox_events` row in **one transaction**. The worker relays the outbox to the `domain-events` queue, where handlers (delivery, realtime fan-out, later SLA/AI) react.
- Channels only produce a `MessageEnvelope` (`packages/shared/src/channels.ts`); `InboundService` does the rest. Outbound messages are stored `pending` and delivered by the worker.
- Request and response contracts live in `packages/shared` as zod schemas; the API validates with `ZodPipe`, the web app imports the same types.
- Routes are authenticated by default. Use `@Public()` to opt out and `@RequirePermission('ticket:assign')` to require permissions.
- Schema changes: edit `packages/db/src/schema`, then `pnpm db:generate`, and commit the generated SQL in `packages/db/drizzle`.
