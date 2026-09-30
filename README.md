# ticketing-sys

Ticket Management System for companies: an omnichannel helpdesk (email, WhatsApp, web chat, later voice) where an AI agent handles first-level support, calls company systems through governed MCP/API tools, and hands off to human agents in one workspace.

- Architecture map (open in a browser): [`docs/architecture.html`](docs/architecture.html)
- Phased build plan: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
- Decisions: [`docs/adr/`](docs/adr)

## Status

| Phase | Scope                                                                                                                 | State   |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker Compose infra, API/worker skeletons, CI                                                              | Done    |
| 1     | Auth + RBAC, customers, tickets + workflow, audit log, outbox events, barebones UI                                    | Done    |
| 2     | Channel gateway, orchestrator, web chat, email                                                                        | Next    |
| 3–11  | LiteLLM platform, knowledge base, AI agent, tools/MCP, handover/routing/SLA, WhatsApp, reporting, hardening, frontend | Planned |

## Layout

```
apps/
  api/        NestJS (Fastify) HTTP API          → http://localhost:3000/api/v1, docs at /docs
  worker/     Background worker: outbox relay, queues, timers (BullMQ)
  web/        Barebones React agent console      → http://localhost:5173
packages/
  shared/     Zod schemas, permissions, workflow defaults, event contracts
  db/         Drizzle schema, SQL migrations, seed
infra/
  docker-compose.yml   Postgres (pgvector), Redis, MinIO, Mailpit, LiteLLM, OTel collector
```

## Getting started

Requirements: Node 22 (see `.nvmrc`), pnpm 9 (`corepack enable`), Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up            # Postgres, Redis, MinIO, Mailpit, LiteLLM
pnpm build               # builds shared packages the apps depend on
pnpm db:migrate
pnpm db:seed             # roles, default workflow, admin from SEED_ADMIN_*, demo data
pnpm dev                 # api + worker + web in watch mode
```

Sign in at http://localhost:5173 with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env`.
Check `GET http://localhost:3000/api/v1/health/ready`: database and Redis must be `up`; LiteLLM and the worker are reported but not required yet.

## Tests

```bash
pnpm lint && pnpm typecheck
pnpm test                # unit tests
pnpm test:int            # integration tests against a real Postgres + Redis
```

Integration tests wipe and migrate the database at `TEST_DATABASE_URL` (default `postgres://tms:tms@localhost:5432/tms_test`) and use Redis db 15 (`TEST_REDIS_URL`). Create the database once with `createdb -h localhost -U tms tms_test` or `docker compose -f infra/docker-compose.yml exec postgres createdb -U tms tms_test`.

## Conventions

- Every state change goes through a service that writes the change, an `audit_log` row and an `outbox_events` row in **one transaction**. The worker relays the outbox to the `domain-events` queue.
- Request and response contracts live in `packages/shared` as zod schemas; the API validates with `ZodPipe`, the web app imports the same types.
- Routes are authenticated by default. Use `@Public()` to opt out and `@RequirePermission('ticket:assign')` to require permissions.
- Schema changes: edit `packages/db/src/schema`, then `pnpm db:generate`, and commit the generated SQL in `packages/db/drizzle`.
