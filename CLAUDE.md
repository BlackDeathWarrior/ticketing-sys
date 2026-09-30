# CLAUDE.md

Guidance for working in this repo. Read `docs/IMPLEMENTATION_PLAN.md` for the phase plan, its reality check (what exists and what is missing), and `docs/adr/` for decisions. Channel research is in `docs/research/`.

## Commands

- `pnpm docker:up` runs the whole stack in Docker (web :8080, Orbit Desk :8081, API :3000); `pnpm docker:down` stops it. App images come from the root `Dockerfile` targets `api`, `worker`, `migrate`, `web`, `orbit-desk`.
- `pnpm dev` runs tsc --watch plus the API (`dist/main.js`) and worker (`dist/worker.js`); both come from `apps/api`.
- `pnpm demo:email` sends a customer email to the dev support mailbox.
- `pnpm sample:load` loads the fictional sample data (`scripts/sample-data/data.ts`) through the API; `pnpm e2e` runs the Playwright suite in `e2e/` against the running stack.
- `pnpm build` builds all packages (apps depend on `packages/*/dist`, so build after changing `shared` or `db`).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int` (needs Postgres, Redis, LiteLLM and `fake-providers`; see README). On Windows, where `@swc/core` rejects its cache folder, run them with `bash scripts/check-in-docker.sh [steps]` (a Linux container on the compose network). `pnpm e2e` accepts `CHROMIUM_PATH`. `pnpm kb:eval` reports knowledge-base recall@5 and `pnpm ai:eval` runs the AI golden conversations against a running stack.
- `pnpm db:generate` after schema edits; commit the SQL in `packages/db/drizzle`. Hand-written SQL goes in `drizzle-kit generate --custom` migrations.

## Rules

- Mutations: one DB transaction containing the change + `AuditService.record` + `OutboxService.publish`. Never skip either. (`llm_calls` is a metrics log and the only exception; see ADR 0008.)
- Validate input with zod schemas from `packages/shared` via `ZodPipe`; add new contracts there.
- Routes are authenticated by default; add `@RequirePermission(...)` to every non-public route. New permissions go in `packages/shared/src/permissions.ts` and the role map there.
- A module only touches its own tables; use the owning module's service otherwise. The read-only `reports` module is the exception.
- In `apps/api` (API and worker entry points), injected classes must be value imports (Nest reads constructor metadata).
- Orbit Desk (`apps/orbit-desk`) is the product console (ADR 0005); new user-facing features go there. `apps/web` stays a barebones test console (no styling libraries). Customer-facing pages go in `apps/help-center` (served at `/help/`; the request form now, the Phase 10 portal later). Its public API is `apps/api/src/web-form` under `@Public()` routes that only ever create, never read a ticket back (ADR 0012).
- `apps/orbit-desk` follows `docs/DESIGN.md`; keep its rules:
  - Tokens from `apps/orbit-desk/src/styles/tokens.css` only; never hard-code colors, radii or shadows.
  - Font weights 400 and 500 only. Radii 5px (buttons/inputs), 16px (cards), 32px (badges), 999px (nav pill).
  - Inset rim-light glows, never drop shadows. The cosmic gradient only on text and thin strokes.
  - Lavender `#9382ff` marks only links, focus, active states and "needs attention"; iris `#5046e4` fills at most one primary button per view.
  - No red/green/yellow: status is glyph shape, label and opacity.
  - Check UI changes at ≈1440px and 390px with no horizontal scroll and no console errors.
- Add integration tests in `apps/api/test/*.int.test.ts` for new endpoints, and an E2E spec in `e2e/tests` for new user-facing flows. Sample data stays fictional (`example.*` domains). Background behaviour: start the worker in-process with `startWorker()` from `test/helpers.ts`.
- All LLM calls go through `LlmClientService` (`chat`/`embed` with a role), never a provider SDK directly. Credentials go through `SecretsService` (or LiteLLM for provider keys); no route may return a secret's value, and key fields need `settings:secrets` (ADR 0009). Channel settings come from `ChannelConfigService`, not `env` directly.
- AI actions run with `AI_CTX` (actor type `ai`) and are recorded in `ai_runs` through `AiRunsService`. AI replies go through `OutboundService.aiReply` (sent or `draft`), never straight to a channel. Change prompts only with a version bump in `apps/api/src/ai/prompts.ts`, and add a golden to `apps/api/test/evals/` for new behaviour (ADR 0011).
- Knowledge search goes through `KbSearchService`; anything shown or said to a customer uses `audience: 'customer'` (approved public documents only). Embeddings are 1024-dimensional and the `embedding` role is pinned (ADR 0010).
- Demos and tests use `apps/fake-providers` (scripted LLM; later Meta Graph and Sarvam) instead of real keys.
- Channels produce a `MessageEnvelope` and call `InboundService.handle()`; outbound messages are stored `pending` and sent by the worker's `DeliveryHandler`. Don't send to external services inside a request.
- Worker services that hold resources stop in `beforeApplicationShutdown` (the DB pool and Redis close in `onApplicationShutdown`).
