# ADR 0026: The chat widget on an integration's site, and branding

Status: accepted (2026-10-01)

## Context

Two things still tied TMS to its own sample shop.

- The chat widget had fixed colours and wording, could not say which site it was on or what the visitor was looking at, and told the page nothing. A logged-in visitor was vouched for with one secret for the whole installation (`CHAT_IDENTITY_SECRET`), so every site sharing a helpdesk shared a signing secret.
- "Demo Store" was written into the help center, the request form asked for an "Order number", and the AI's prompt talked about orders, payments and a tool named `demo_store__order_status`.

## Decision

### The widget

`TMSChat.init` takes more options. All are optional, and a page that passes none looks and behaves as before.

- `integration`: the integration's identifier. Chats started with it are that integration's tickets (`tickets.integration_id`): its `own` webhooks hear about them, and its API key can read them (ADR 0023, 0025). A session keeps the integration it started with.
- `theme`: `primary`, `onPrimary`, `radius`, `position` (left or right). Applied as CSS variables on the widget's shadow host; values that are not plain colours or small numbers are ignored.
- `strings`: launcher, title, intro, placeholder, send and the name form's wording.
- `visitor`: a name and email the site already has. Unverified: it only saves the visitor typing them, and skips the name form.
- `context`: a small JSON object (at most 2 KB) saying what the visitor is looking at. It becomes the metadata of the ticket their next message opens, shown to agents and given to the AI as bounded data (ADR 0023). `setContext()` replaces it as the page changes. It comes from a browser, so it is never trusted, and it cannot set `kind`.
- `on`: `open`, `close`, `message` (a reply arrived), `ticket` (the visitor's message opened a ticket; the reference is passed). A callback that throws does not break the chat, and callbacks never receive the session token.
- The handle returns `open`, `close`, `setContext`, `identify(token)` (the visitor signed in: a new conversation as them) and `destroy`.
- Send stays disabled until the connection is up, so a message typed early is not silently dropped.
- A handshake naming an unknown or switched-off integration is refused with a message, so a misconfigured site sees it at once.

### Identity per integration

- Each integration can have its own chat identity secret (`integration.<slug>.chat_identity`), generated in Settings and shown once, like an API key.
- With `integration` set, an identity token is verified with that secret; without one for the integration, with `CHAT_IDENTITY_SECRET` as before. A token that does not verify is ignored and the visitor stays anonymous.
- A verified `sub` becomes the identity `<slug>:<sub>`: the same customer the integration names as `customer.externalId` through its API. A visitor's chat and the tickets the site's backend raised for them are one customer's history.

### Branding

One setting (`branding`, edited in Settings → Customers, permission `settings:channels`):

| Field            | Used for                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `companyName`    | The help center's name, mark and page title; "You are the first-line support assistant for …" |
| `supportName`    | "Kind regards, …" on email replies the AI writes                                              |
| `helpCenterNote` | The line at the bottom of the help center; empty removes it                                   |
| `referenceLabel` | The request form's optional reference field ("Order number", "Listing"); empty hides it       |

- The defaults are the sample shop's, so an installation that sets nothing is unchanged.
- The public request-form config (`GET /public/request-form`) carries the branding; no new public route.
- The form's field keeps its wire name `orderNumber`; only its label changes.
- Prompt `agent-v5` (and `copilot-v2`): the company's name, the support team's sign-off, and tool guidance that no longer assumes a shop. Branding is entered by staff, so it is trusted like the rest of the prompt; it is still collapsed to one line.

### Orbit Desk

- Settings → Customers: a Branding card.
- Settings → Integrations → an integration: a Chat widget card with the snippet to paste and the identity secret (generate or replace, shown once).
- `apps/chat-widget/public/site.html` stands in for an integration's site, for trying the options and for the end-to-end test.

## Consequences

- Not done: a logo, a custom domain, the `TMS-` ticket prefix (it is part of email threading), per-integration allowed origins (`CHAT_ORIGINS` stays global), and translations of the widget's fixed strings (status lines, the rating question).
- The theme lives in the page's `init` call, not in TMS. A site changes its look by changing its own page.
- An integration's API key can read the transcripts of chats started on its site. That is the site's own customer conversation; an admin who does not want it gives the site no ticket-scoped key.
- Replacing an identity secret signs out nobody, but tokens signed with the old one stop being accepted at once.
