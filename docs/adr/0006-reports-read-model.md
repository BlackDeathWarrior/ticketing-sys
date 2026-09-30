# ADR 0006: The reports module reads across modules

Status: accepted (2026-09-30). This records a decision already made in code (`4616037`, `apps/api/src/reports`).

## Context

ADR 0002 says a module reads and writes only its own tables. The dashboard needs aggregates that span tickets, workflow statuses, users and the audit log. The plan's Phase 9 answer is event-fed reporting tables (`fact_*`), which don't exist yet.

## Decision

- `ReportsModule` is a **read-only** exception. It may query any module's tables directly with SQL aggregates, and it never writes. So it records no audit rows or outbox events.
- `GET /reports/overview` (permission `report:read`) is computed live on each request. Contracts live in `packages/shared/src/reports.ts`.
- Day boundaries are UTC.

## Consequences

- The dashboard has live figures with no extra infrastructure.
- If a module changes its schema, it can break a report query. `apps/api/test/reports.int.test.ts` guards this with exact deltas.
- When live queries get slow, or reports need history that live tables don't keep (handover counts, AI-versus-human resolution, SLA compliance, CSAT), Phase 9 adds event consumers that write reporting tables. The endpoint contracts stay the same.
