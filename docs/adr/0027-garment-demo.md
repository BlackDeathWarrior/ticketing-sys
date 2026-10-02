# ADR 0027: The Ethnic Threads demo

Status: accepted (2026-10-02)

## Context

Phases 13a to 13f gave TMS what an outside app needs to use it as its support desk: API keys, a ticket API, incident intake, signed webhooks, a themable chat widget, an SDK and a guide. That had only been exercised by our own tests.

To sell TMS as something that fits any app, it has to be shown fitting one we did not design for it. Ethnic Threads (`garment-web-scraper`) is such an app: a React storefront over a catalogue that a Python worker scrapes from Amazon, Flipkart and Myntra. It has shoppers with questions, listings that go wrong, and a scraper that fails in several ways. It had a Formspree contact form and no support tooling.

## Decision

### The app integrates; TMS is not bent around it

Everything Ethnic Threads needed is in its own repository (branch `feat/support-desk-integration`, `SUPPORT_DESK.md` there), written against the public guide in `docs/integration/` and the vendored Python client. TMS gained no Ethnic Threads code: the only things in this repository that name it are data (the loader's `scripts/sample-data/garment/`), a compose override, a demo script, and specs.

Three gaps in TMS showed up while integrating and rehearsing, and were fixed for everyone:

- **Routing by tag.** A routing rule can now match a ticket tag (`conditions.tag`). Incident tickets carry the tag `incident`, so "incidents go to the team that runs the app" is one rule. Before, they could only be told apart from the same app's shopper tickets by priority.
- **"Picked up by a person."** A recovery resolves an incident ticket only when no person has started on it (ADR 0024). That was read from the assignee, which a routing rule sets by itself, so with routing switched on no incident ever resolved itself. It is now read from the audit log: a person assigned it, moved it or wrote a note (`AuditService.hasActor`), or is handling it.
- **A handover notice is not a first response.** The AI's "I'm passing this to a member of our team" met the first-response target, so a handed-over chat could never breach it however long the customer waited. It is now sent as a notice (`notice: true`), like the holding message (ADR 0014).

### How the app is connected

- **The browser never holds a key.** The storefront calls the app's own worker (`/api/support/*`); the worker calls TMS with the key. Two keys, one job each: `integration:ticket` for shoppers' requests, `integration:event` for the scraper's incidents.
- **Reading a request back** needs a tracking token: an HMAC of the ticket reference, made by the worker and carried in the link's fragment. The app has no server-side shopper accounts, so this is what stands between one shopper and another's request. Without the token the worker answers 404, and it never asks TMS.
- **Listing reports** send the listing's id from the browser; the worker looks the listing up in its own catalogue and sends those facts as `metadata`. A browser cannot put a made-up price on a ticket.
- **Webhooks** are verified by signature, stored once per delivery id, and kept as short summaries. They drive the admin's activity feed, and they tell an open request page that there is news without the page polling TMS.
- **Incidents** are reported where the failure is detected (the worker's process watcher, the scrape loop, the S3 upload, the Amazon parser, a catalogue freshness check), each with a fingerprint. Reporting never raises and times out after three seconds: a support desk that is down must not stop a scrape.
- **AI tools** are custom HTTP tools (ADR 0017) pointing at the worker, protected by a token. Reading is free; starting a scrape is `transactional` and waits for a supervisor.
- **Identity:** the admin is vouched for with a signed chat identity (`sub: admin`, the same id the worker sends as `customer.externalId`). Shoppers are named but unverified.

### The demo stack

`infra/docker-compose.garment.yml` over the base file: its own project (`tms-garment`), volumes and ports (API 3200, Orbit Desk 8091, widget 8090), so it runs next to the default stack and never touches its database. It starts without demo data, allows `host.docker.internal` for tools and webhooks, and shortens the SLA sweep and the webhook backoff so a breach and a retry can be watched.

`scripts/sample-data/garment/load-garment.ts` sets TMS up through the API, as an administrator would: branding, teams, staff, categories, SLA, routing, AI modes, the knowledge base, the integration with its keys, webhook and chat identity secret, and the tools. It can be run again. Keys and secrets are created once and written to the app's `.env`, never printed.

The knowledge base says only what the app really does (it links to stores and sells nothing; prices are a snapshot). The staff are invented.

### Showing failures without faking them

Every scenario is triggered through the real code path of the real app:

| Scenario                   | How it really happens                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| Stale catalogue            | The catalogue in the repository was last scraped in April 2026            |
| Scrape run fails, repeated | The worker is started with a source that does not exist: each run exits 1 |
| S3 upload fails            | There are no AWS credentials on the demo machine                          |
| Recovery                   | One real, small scrape (`--sources myntra --max-products 5`)              |
| Webhook receiver down      | The worker is stopped; deliveries are retried and arrive when it is back  |
| Bad signature              | The secret is rotated in Settings; the app still has the old one          |
| SLA breach                 | The urgent policy gives two minutes; nobody answers                       |
| Rate limit, revoked key    | A key limited to five calls a minute is called seven times, then revoked  |

Not built: a stand-in retailer site, a "fail now" flag or endpoint in the app, edited timestamps, hand-posted incident events. A CAPTCHA and a full disk cannot be produced on demand; those hooks are covered by the app's unit tests only.

### Tests

- The app: `pytest tests/support` (the client against the shared signature vectors, the routes, the incident hooks, a real failing run) and `vitest` for the storefront.
- TMS: unit and integration tests for the three changes above, and scripted-model branches for the app's tools (`apps/fake-providers`, for tests and for a demo without a key).
- Both together: `e2e/tests/garment/` drives the real storefront and Orbit Desk. They are skipped unless `GARMENT_URL` is set, because they need the app running.

The live demo uses a real model, added in Settings. The scripted model is for the automated run.

## Consequences

- The integration guide has been followed end to end by a second codebase in a second language. What it needed that the guide did not offer became product changes, not special cases.
- The demo depends on a second repository and on processes outside Docker (the app's worker and its Vite server). The runbook and `scripts/demo/garment-demo.ps1` carry that.
- A real scrape visits real stores. It is used once per demo, for the recovery, and kept small.
- The first-response change alters reports for existing installations: handed-over conversations now count as waiting until a person answers.

## Not done

- Multi-tenancy (Phase 15). One installation still serves one company.
- Shopper accounts on the app's server, so chat and form requests of one shopper would share a verified identity.
- Attachments through the integration API, a logo in the branding setting, a custom ticket prefix.
