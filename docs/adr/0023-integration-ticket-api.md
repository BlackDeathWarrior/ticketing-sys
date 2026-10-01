# ADR 0023: Tickets through the integration API

Status: accepted (2026-10-01)

## Context

With API keys in place (ADR 0022), an outside app still could not do the one thing it connects for: raise a ticket for one of its users and show that user the answer. The staff route `POST /tickets` needs an existing customer id, opens no conversation, and so leaves a ticket that can only be answered by email or WhatsApp. An app would have needed three staff calls and a mailbox.

## Decision

### A channel, not a special case

- New channel `api`. The integration API is one more adapter: it builds a `MessageEnvelope` and calls `InboundService.handle()`, like chat, email and the request form (ADR 0004). Customer resolution, the AI, classification, routing, SLA timers, audit and events therefore all apply unchanged.
- Tickets gain three columns: `integration_id` (who raised it), `external_ref` (the app's id for what the ticket is about: an order, a listing, a job) and `metadata` (a JSON object of context, at most 8 KB). The envelope carries them, with priority and tags, for the message that opens a ticket.
- `InboundService.handleInTx` exposes the pipeline inside a caller's transaction. Incident intake (ADR 0024) needs it.

### Routes

All under `@ApiKeyAuth()`, scope `integration:ticket`.

| Route                                           | What it does                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `POST /integration/tickets`                     | Customer, subject, body, and optionally category (by name), priority, tags, `externalRef`, `metadata`, `ai`. 201 with the ticket. |
| `GET /integration/tickets`                      | The integration's tickets, filtered by `externalRef` and `state` (open, pending, resolved, closed).                               |
| `GET /integration/tickets/:reference`           | One ticket.                                                                                                                       |
| `GET /integration/tickets/:reference/messages`  | What the customer wrote and was sent. `after=<time>` for polling.                                                                 |
| `POST /integration/tickets/:reference/messages` | The customer's follow-up.                                                                                                         |
| `POST /integration/tickets/:reference/rating`   | The customer's rating, given in the app.                                                                                          |

- **Isolation:** every route checks `ticket.integration_id` against the calling key's integration and answers 404 otherwise. A ticket raised by another integration, by email or by an agent looks exactly like one that does not exist.
- **Idempotency:** an `Idempotency-Key` header becomes the message's `channel_message_id` (`api:<integration>:<key>`), so the existing unique index does the work. A repeat answers 200 with the original ticket or message. Keys are per integration.
- **What the app can read:** messages that are not drafts or discarded drafts. Internal notes are in another table and never appear. Agents are shown by first name, as in the portal.
- **State, not status:** the workflow is configurable, so the API filters and reports `state` (the status category) next to the status key and name.

### Customers

- `customer.externalId` is the app's own id for the person. It becomes an `external_id` identity `<slug>:<externalId>`, so the same id always finds the same customer and two integrations with a user "42" get two customers.
- An email next to an `externalId` is attached as **unverified**: TMS cannot know whether the app checked it. It never links the ticket to another customer who already owns that address.
- With only an email, the email is the identity, as on the public request form.
- A customer who has no contact email yet gets the first email attached to them (`CustomersService.attachIdentity`). This also fills in the email for chat visitors identified by their site.

### Replies

- An agent or AI reply on an `api` conversation is stored `pending` like any reply. `ApiSender` has nowhere to push it, so it returns at once and the message becomes `sent`, meaning "available to the app". Apps poll `…/messages?after=`; webhooks (ADR 0025) tell them when to look.
- A follow-up names its ticket, like a portal reply. It joins the ticket's `api` conversation and reopens a solved ticket. A closed ticket answers 409: create a new one.

### The AI

- `api` is an AI channel, default mode `draft`: the AI answers, a person approves, then the app sees it. Admins can set it to `auto` or `off` in Settings → AI behaviour.
- `ai: "off"` on a ticket keeps the AI out of that conversation whatever the mode (the envelope's new `ai` field). The classifier still files the ticket.
- No "a person will reply" holding message: that is for live chats.
- Prompt `agent-v4`: an in-app reply style, and the ticket's `externalRef` and `metadata` in a `<ticket_context>` block. That text comes from an outside system, so it is data like customer text: one line per value, 200 characters per value, 1,500 in all, and it cannot close its own tag. A golden covers the channel.

### Ratings

- No survey is sent for `api` tickets: the app knows when the ticket is solved and asks in its own interface, then passes the rating on. Source `api`. This is the customer's rating relayed by the app they gave it in, not a staff route.

### Orbit Desk

The ticket drawer shows "Context from <integration>": the reference and the metadata as plain text (values are never rendered as links or markup). The channel reads "Integration".

## Consequences

- Attachments are not accepted through the API yet.
- A key with `integration:ticket` can raise tickets for any customer id or email it names. That is the point of the key; what it cannot do is read anything it did not raise.
- An app that never polls and has no webhook simply does not show replies. The ticket still works for agents, who can start an email conversation from it.
- Staff can also set `externalRef` and `metadata` when creating a ticket; only the integration API sets `integration_id`.
