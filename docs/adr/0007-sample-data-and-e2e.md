# ADR 0007: Fictional sample data through the public API, and E2E against the live stack

Status: accepted (2026-09-30). This records a decision already made in code (`29177d9`: `scripts/sample-data`, `e2e/`).

## Decision

- **Sample data.** `pnpm sample:load` (`scripts/sample-data/`) fills a running stack through the **public API**, the chat widget socket and the support mailbox. So audit rows, outbox events, realtime pushes and email delivery happen just as they do for real traffic.
  - The only direct database write is an optional step that backdates ticket timestamps over 14 days.
  - The loader refuses to run twice.
- **Fictional only.** Every person and company is invented. Email domains use `example.*`, and phone numbers use drama or 555-style ranges. Real customer data never goes into the repo, tests or the demo.
- **E2E.** A Playwright suite (`e2e/`) runs one worker in order against the Docker stack (`pnpm docker:up && pnpm sample:load`). It drives Orbit Desk, the basic console, the widget and Mailpit.
  - Every test fails on an unexpected browser console error.
  - URLs come from environment variables, so the same suite can run against dev servers or a deployed demo.
- **CI.** The `e2e` job builds the stack, loads the sample data and runs the suite. The `check` job runs unit and integration tests against service containers.

## Consequences

- Each new channel or feature extends `scripts/sample-data/data.ts`, and each new user-facing flow gets a spec in `e2e/tests`.
- Tests leave data behind. Reset with `docker compose ... down -v`.
- The same loader can reset a hosted demo every night.
