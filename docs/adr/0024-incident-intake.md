# ADR 0024: Incidents an app reports about itself

Status: accepted (2026-10-01)

## Context

A helpdesk that plugs into an app should hear from the app itself, not only from its users: a scheduled job failed, a data source is blocked, the catalogue is stale. Raising a ticket per failure through `POST /integration/tickets` (ADR 0023) is wrong for this. A job that fails every five minutes would open hundreds of tickets, and nothing would close them when it recovers.

## Decision

### One route, two states

`POST /integration/events` (scope `integration:event`) takes:

- `fingerprint`: chosen by the app; what makes two reports the same problem, e.g. `scraper.source_failed:myntra`.
- `status`: `firing` (default) or `resolved`.
- `title` (needed when firing), `severity` (`info`, `warning`, `error`, `critical`; default `error`), `source`, `message`, `details`.

It answers 202 with what the report did (`opened`, `updated`, `resolved`, `ignored`) and the incident, including the reference of the ticket that tracks it. `GET /integration/incidents` lists the integration's own incidents.

### Incidents

- `incidents` holds one row per episode: fingerprint, status, the worst severity seen, occurrences, first and last seen, the ticket.
- A partial unique index allows one **open** incident per integration and fingerprint. Reports are serialised per fingerprint with an advisory lock, so a burst opens one incident.

### What a report does

| Report   | No open incident               | Open incident                                                                                                    |
| -------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| firing   | Opens an incident and a ticket | Counts it; notes it on the ticket at 2, 10, 100 and 1,000 reports; a worse severity raises the ticket's priority |
| resolved | Ignored                        | Resolves the incident; notes the recovery; resolves the ticket if nobody has picked it up                        |

- **The ticket** is opened through `InboundService.handleInTx`, in the same transaction as the incident row, so routing and SLA timers apply like any ticket. Channel `api`, tag `incident`, `metadata.kind = "incident"`, `externalRef` = the fingerprint, the event's `details` in the metadata, priority from severity (critical → urgent, error → high, warning → normal, info → low). The "customer" is one system customer per integration.
- **No AI:** the ticket is opened with `ai: off`, and the classifier skips tickets with `metadata.kind = "incident"`. Severity and source are facts the app sent, not something to guess.
- **Recovery:** the ticket is resolved only when it has no assignee and no person is handling it. Once someone has taken it, the recovery is a note and they decide when it is done.
- **It comes back:** the fingerprint is the conversation's thread key, so a new firing report after a recovery returns to the same ticket (reopening it) as long as that ticket is not closed, and starts a new incident row. A closed ticket stays closed and a new one is opened.
- **Closed or solved by hand:** if an agent resolved or closed the ticket while the incident was still open, the next firing report ends that incident (`ticket_closed`) and starts again as above.
- Priority is only ever raised by reports, never lowered.

### What is recorded

- Opening, the noted repeats, a rise in severity and resolving write audit and outbox rows (`incident.opened`, `incident.updated`, `incident.resolved`), with the integration's key as the actor.
- Incrementing `occurrences` and `last_seen_at` alone is **not** audited or published: it is a counter, like `llm_calls` (ADR 0008) and `api_keys.last_used_at` (ADR 0022). A flood of identical reports would otherwise write a flood of audit rows.

### Orbit Desk

An incident ticket's drawer reads "Incident reported by <integration>" with one line per episode ("Still happening · reported 10 times · first 2h ago · last 3m ago", "Recovered 5m ago · reported 4 times"), from `GET /tickets/:id/incidents`.

## Consequences

- A retried HTTP request counts twice. Occurrences are an indication of volume, not an exact count.
- The app chooses fingerprints. Too fine (one per run id) and nothing is grouped; too coarse and unrelated failures share a ticket. The integration guide gives examples.
- The key's rate limit (ADR 0022) is the only brake on a flood: a client should not report the same fingerprint more than about once a minute.
- An incident whose ticket a person has taken stays open in the queue after a recovery until that person resolves it.
