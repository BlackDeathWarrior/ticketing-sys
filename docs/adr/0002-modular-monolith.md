# ADR 0002: Modular monolith with a separate worker

Status: accepted (2026-09-30)

## Decision

One deployable API (`apps/api`) with internal NestJS modules per domain (auth, users, customers, tickets, workflow, audit, and later channels, ai, tools, routing), plus one worker process (`apps/worker`) for queue consumers, the outbox relay and timers.

## Rules that keep a later split possible

- A module reads and writes only its own tables. Other modules call its service.
- Every state change writes an audit row and an outbox event in the same transaction as the change. Cross-module reactions (notifications, SLA, AI, reporting) subscribe to events instead of being called inline.
- Contracts (schemas, event types, permission names) live in `packages/shared`.

## Consequences

- Simple to run and debug: one API process, one worker, one database.
- Transactions across modules are still possible where needed (e.g. creating a ticket and its first message), because they share one Postgres.
- If a module needs independent scaling (likely candidates: channel ingestion, AI agent runs), it can move behind the event stream without changing its callers.

## Deferred

Multi-tenancy. The schema is single-tenant for the MVP. Adding an `organization_id` to tenant-owned tables is a planned migration if the product becomes multi-tenant SaaS.
