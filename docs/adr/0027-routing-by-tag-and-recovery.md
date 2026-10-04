# ADR 0027: Three fixes from connecting the first outside app

Status: accepted (2026-10-02).

## Context

Phases 13a to 13f gave TMS what an outside app needs to use it as its support desk: API keys, a ticket API, incident intake, signed webhooks, a themable chat widget, an SDK and a guide. That had only been exercised by our own tests.

It was then followed end to end by a second codebase in a second language: a demonstration app, kept outside this repository, written against the public guide in `docs/integration/` and the Python client. TMS gained no code for that app. Three gaps in TMS showed up, and were fixed for every integration.

## Decision

- **Routing by tag.** A routing rule can match a ticket tag (`conditions.tag`). Incident tickets carry the tag `incident`, so "incidents go to the team that runs the app" is one rule. Before, they could only be told apart from the same app's customer tickets by priority.
- **"Picked up by a person."** A recovery resolves an incident ticket only when no person has started on it (ADR 0024). That was read from the assignee, which a routing rule sets by itself, so with routing switched on no incident ever resolved itself. It is now read from the audit log: a person assigned it, moved it or wrote a note (`AuditService.hasActor`), or is handling it.
- **A handover notice is not a first response.** The AI's "I'm passing this to a member of our team" met the first-response target, so a handed-over chat could never breach it however long the customer waited. It is now sent as a notice (`notice: true`), like the holding message (ADR 0014).

## How an app is expected to connect

These are the patterns the guide recommends, and what the fixes above assume:

- **The browser never holds a key.** The app's pages call the app's own server; the server calls TMS with the key. One key per job, each with only the scopes it needs.
- **Incidents are reported where the failure is detected**, each with a fingerprint. Reporting should never raise and should time out quickly: a support desk that is down must not stop the app.
- **AI tools** are custom HTTP tools (ADR 0017) pointing at the app's server, protected by a token. Reading is free; anything that changes the app's data gets a risk tier that waits for a supervisor.
- **Webhooks** are verified by signature and stored once per delivery id.

## Consequences

- The first-response change alters reports for existing installations: handed-over conversations count as waiting until a person answers.
- When connecting an app shows a gap in TMS, the fix is made for every integration. TMS holds no code for a particular app.

## Not done

- Multi-tenancy (Phase 15). One installation still serves one company.
- Attachments through the integration API, a logo in the branding setting, a custom ticket prefix.
