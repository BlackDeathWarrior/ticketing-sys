# CLAUDE.md

Guidance for working in this repo. Read `docs/IMPLEMENTATION_PLAN.md` for the phase plan and `docs/adr/` for decisions.

## Commands

- `pnpm docker:up` runs the whole stack in Docker (web :8080, API :3000); `pnpm docker:down` stops it. App images come from the root `Dockerfile` targets `api`, `worker`, `migrate`, `web`.
- `pnpm dev` runs tsc --watch plus the API (`dist/main.js`) and worker (`dist/worker.js`); both come from `apps/api`.
- `pnpm demo:email` sends a customer email to the dev support mailbox.
- `pnpm build` builds all packages (apps depend on `packages/*/dist`, so build after changing `shared` or `db`).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int` (needs Postgres + Redis; see README).
- `pnpm db:generate` after schema edits; commit the SQL in `packages/db/drizzle`. Hand-written SQL goes in `drizzle-kit generate --custom` migrations.

## Rules

- Mutations: one DB transaction containing the change + `AuditService.record` + `OutboxService.publish`. Never skip either.
- Validate input with zod schemas from `packages/shared` via `ZodPipe`; add new contracts there.
- Routes are authenticated by default; add `@RequirePermission(...)` to every non-public route. New permissions go in `packages/shared/src/permissions.ts` and the role map there.
- A module only touches its own tables; use the owning module's service otherwise.
- In `apps/api` and `apps/worker`, injected classes must be value imports (Nest reads constructor metadata).
- `apps/web` stays barebones (no styling libraries) until the frontend phase.
- `apps/orbit-desk` follows `docs/DESIGN.md`; keep its rules:
  - Tokens from `apps/orbit-desk/src/styles/tokens.css` only; never hard-code colors, radii or shadows.
  - Font weights 400 and 500 only. Radii 5px (buttons/inputs), 16px (cards), 32px (badges), 999px (nav pill).
  - Inset rim-light glows, never drop shadows. The cosmic gradient only on text and thin strokes.
  - Lavender `#9382ff` marks only links, focus, active states and "needs attention"; iris `#5046e4` fills at most one primary button per view.
  - No red/green/yellow: status is glyph shape, label and opacity.
  - Check UI changes at ≈1440px and 390px with no horizontal scroll and no console errors.
- Add integration tests in `apps/api/test/*.int.test.ts` for new endpoints. Background behaviour: start the worker in-process with `startWorker()` from `test/helpers.ts`.
- Channels produce a `MessageEnvelope` and call `InboundService.handle()`; outbound messages are stored `pending` and sent by the worker's `DeliveryHandler`. Don't send to external services inside a request.
- Worker services that hold resources stop in `beforeApplicationShutdown` (the DB pool and Redis close in `onApplicationShutdown`).
