# CLAUDE.md

Guidance for working in this repo. Read `docs/IMPLEMENTATION_PLAN.md` for the phase plan and `docs/adr/` for decisions.

## Commands

- `pnpm build` builds all packages (apps depend on `packages/*/dist`, so build after changing `shared` or `db`).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:int` (needs Postgres + Redis; see README).
- `pnpm db:generate` after schema edits; commit the SQL in `packages/db/drizzle`. Hand-written SQL goes in `drizzle-kit generate --custom` migrations.

## Rules

- Mutations: one DB transaction containing the change + `AuditService.record` + `OutboxService.publish`. Never skip either.
- Validate input with zod schemas from `packages/shared` via `ZodPipe`; add new contracts there.
- Routes are authenticated by default; add `@RequirePermission(...)` to every non-public route. New permissions go in `packages/shared/src/permissions.ts` and the role map there.
- A module only touches its own tables; use the owning module's service otherwise.
- In `apps/api` and `apps/worker`, injected classes must be value imports (Nest reads constructor metadata).
- UI stays barebones (no styling libraries) until the frontend phase.
- Add integration tests in `apps/api/test/*.int.test.ts` for new endpoints.
