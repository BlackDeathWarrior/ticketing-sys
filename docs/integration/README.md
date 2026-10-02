# Connecting your app to TMS

This guide is for a developer adding support to an existing app. When you finish, your app can:

- raise a ticket for one of its users and show them the answer;
- report its own failures as incidents that open, update and close one ticket;
- be told about ticket changes by signed webhooks;
- show a chat on its pages that knows who the visitor is and what they are looking at.

Each part works without the others. Most apps start with tickets and add the rest as they need it.

- [Webhooks](./webhooks.md): events, payloads, verifying signatures, retries.
- [Chat widget](./widget.md): the snippet, options, signed-in visitors.
- Clients: [`@tms/sdk`](../../packages/sdk) for Node, [`tms_support.py`](./examples/python/tms_support.py) for Python (one file, standard library only).
- The live API reference is at `/docs` on your TMS address (tag "integration API").

## 1. Set up the integration

An administrator does this once, in Orbit Desk under **Settings → Integrations**.

1. **Add integration.** Give it a name and an identifier (for example `ethnic-threads`). The identifier cannot be changed later.
2. **Create key.** Choose what the key may do:

   | Scope                | Allows                                                     |
   | -------------------- | ---------------------------------------------------------- |
   | `integration:ticket` | Create and read the integration's own tickets and messages |
   | `integration:event`  | Report incidents and recoveries                            |

   The key (`tms_sk_…`) is shown once. Store it where your server keeps its secrets. Give each part of your app its own key with only the scopes it needs: a storefront backend needs `integration:ticket`, a background worker needs `integration:event`.

3. Optional: **Add webhook** and **Generate secret** for the chat widget. Both are covered in their own pages.

A key can be revoked at any time and stops working on the next request. Switching the integration off stops all its keys.

## 2. Call the API

- Base address: `https://<your TMS address>/api/v1`
- Authentication: `Authorization: Bearer tms_sk_…` on every request.
- Bodies and answers are JSON.

Check the key first:

```bash
curl https://support.example.com/api/v1/integration \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```json
{
  "integration": { "slug": "ethnic-threads", "name": "Ethnic Threads" },
  "key": {
    "name": "Storefront backend",
    "prefix": "tms_sk_Q4Eg4PB9",
    "scopes": ["integration:ticket"],
    "rateLimitPerMinute": 120
  }
}
```

Keep the key on your server. A browser never calls TMS with it: your page calls your server, and your server calls TMS.

## 3. Tickets

### Raise a ticket

```bash
curl -X POST https://support.example.com/api/v1/integration/tickets \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: report-7f3a9c21" \
  -d '{
    "customer": { "externalId": "user-42", "name": "Asha Verma", "email": "asha@example.com" },
    "subject": "The price on this listing looks wrong",
    "body": "The site shows 1,499 but the store charges 1,799.",
    "category": "Listings",
    "priority": "normal",
    "tags": ["wrong-price"],
    "externalRef": "MYN-48213",
    "metadata": { "source": "Myntra", "price_current": 1499 }
  }'
```

| Field             | Notes                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `customer`        | `externalId` (your own id for the person), `email`, or both; `name` is optional. The same `externalId` always finds the same customer. |
| `subject`, `body` | Required.                                                                                                                              |
| `category`        | A top-level category by name, as set up in Settings → Tickets. An unknown name is refused with 400.                                    |
| `priority`        | `urgent`, `high`, `normal` (default) or `low`.                                                                                         |
| `tags`            | Up to 20.                                                                                                                              |
| `externalRef`     | Your id for what the ticket is about: an order, a listing, a job. You can list tickets by it.                                          |
| `metadata`        | A JSON object of context, at most 8 KB. Agents see it next to the ticket, and the AI reads it as data.                                 |
| `ai`              | `"off"` keeps the AI out of this ticket. Default: the workspace's setting for API tickets.                                             |

The answer is `201` with the ticket:

```json
{
  "reference": "TMS-1042",
  "subject": "The price on this listing looks wrong",
  "status": { "key": "new", "name": "New", "state": "open" },
  "priority": "normal",
  "category": "Listings",
  "tags": ["wrong-price"],
  "externalRef": "MYN-48213",
  "metadata": { "source": "Myntra", "price_current": 1499 },
  "customer": { "name": "Asha Verma", "email": "asha@example.com", "externalId": "user-42" },
  "handling": "none",
  "createdAt": "2026-10-01T10:00:00.000Z",
  "updatedAt": "2026-10-01T10:00:00.000Z",
  "resolvedAt": null,
  "closedAt": null
}
```

Keep `reference`: it is how you address the ticket from now on, and what you show the user.

**Idempotency.** Send an `Idempotency-Key` header (any unique string of 8 to 200 characters) whenever a call might be retried. A repeat with the same key creates nothing and answers `200` with the original ticket.

**Whose ticket.** `customer.externalId` is the id you gave for the person, or `null` when the customer is known only by email. Before you show a ticket to a signed-in user, check that it is theirs.

**Status and state.** A workspace can rename and add statuses. `status.state` is always one of `open`, `pending`, `resolved`, `closed`: build your logic on it, and show `status.name` to people.

### Read the conversation

```bash
curl "https://support.example.com/api/v1/integration/tickets/TMS-1042/messages?after=2026-10-01T10:00:00.000Z" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```json
[
  {
    "id": "9f1c…",
    "from": "support",
    "name": "Maya",
    "body": "Thanks, we have corrected the price.",
    "createdAt": "2026-10-01T10:12:31.000Z"
  }
]
```

- `from` is `customer`, `support` (a person; `name` is their first name), `assistant` (the AI) or `system` (an automatic message).
- You only ever get what the customer may see. Drafts and internal notes are never returned.
- To poll, pass the newest `createdAt` you have as `after`. With a webhook for `message.created` you do not need to poll at all.

### Other calls

| Call                                                                             | Does                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /integration/tickets/{reference}/messages` `{ "body": "…" }`               | Adds the customer's follow-up. Reopens a solved ticket. A closed ticket answers `409`: create a new one.                                                      |
| `GET /integration/tickets/{reference}`                                           | The ticket as above.                                                                                                                                          |
| `GET /integration/tickets?externalRef=…&state=open&limit=25&offset=0`            | Your tickets, newest first: `{ "items": […], "total": 3 }`.                                                                                                   |
| `GET /integration/tickets?customer=user-42`                                      | One user's tickets, by your own id for them: what a "Your requests" page in your app shows. Chats they had with a signed identity are among them.             |
| `POST /integration/tickets/{reference}/rating` `{ "rating": 5, "comment": "…" }` | The customer's rating (1 to 5) of a solved ticket. TMS sends no survey for API tickets: ask in your own interface when the ticket's state becomes `resolved`. |

An integration only reaches tickets it raised (through its API or its chat widget). Any other reference answers `404`.

## 4. Incidents

Use this when your app, not a person, notices a problem: a job failed, a data source is blocked, data is stale. Reports with the same **fingerprint** are one incident with one ticket, however often you report.

```bash
# It is failing
curl -X POST https://support.example.com/api/v1/integration/events \
  -H "Authorization: Bearer $TMS_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "fingerprint": "scraper.source_failed:myntra",
    "title": "Myntra scrape failed",
    "severity": "error",
    "source": "scraper/myntra",
    "message": "Page timed out after 150s",
    "details": { "run": "manual-scrape-0412" }
  }'

# It has recovered
curl -X POST https://support.example.com/api/v1/integration/events \
  -H "Authorization: Bearer $TMS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "fingerprint": "scraper.source_failed:myntra", "status": "resolved" }'
```

The answer is `202` with what the report did and the ticket that tracks it:

```json
{
  "action": "opened",
  "incident": {
    "fingerprint": "scraper.source_failed:myntra",
    "status": "open",
    "severity": "error",
    "occurrences": 1,
    "ticket": "TMS-1043",
    "…": "…"
  }
}
```

| What you send                     | What happens                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| First `firing` report             | An incident and a ticket open (`action: "opened"`). Priority follows severity: `critical` → urgent, `error` → high, `warning` → normal, `info` → low.        |
| The same fingerprint again        | Counted on the incident (`"updated"`). The ticket gets a note at 2, 10, 100 and 1,000 reports. A worse severity raises the priority; reports never lower it. |
| `status: "resolved"`              | The incident closes (`"resolved"`). The ticket is resolved too, unless a person has already taken it: then they get a note and decide.                       |
| `firing` again later              | The same ticket reopens, unless it was closed: then a new one opens.                                                                                         |
| `resolved` for something not open | Nothing (`"ignored"`).                                                                                                                                       |

**Choosing fingerprints.** One per kind of failure and thing it happened to: `scraper.source_failed:myntra`, `catalog.stale`, `payment.webhook_failed`. Not per occurrence (no run ids or timestamps), or nothing will be grouped.

**How often.** Report when it happens, but not more than about once a minute per fingerprint. Incident tickets are for people: the AI does not answer or classify them.

`GET /integration/incidents?status=open` lists your incidents, for a status banner in your admin pages.

## 5. Errors and limits

| Status | Meaning                                                                       | What to do                                    |
| ------ | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `400`  | The request is not valid. `message` and `issues` say what is wrong.           | Fix the request.                              |
| `401`  | The key is missing, wrong, revoked or expired.                                | Check the key.                                |
| `403`  | The key lacks the scope, or the integration is switched off.                  | Use a key with the scope.                     |
| `404`  | Not found, or not yours.                                                      | —                                             |
| `409`  | The ticket is closed, or the idempotency key was used for something else.     | Create a new ticket.                          |
| `429`  | The key's allowance for this minute is used up (120 by default; set per key). | Wait `Retry-After` seconds.                   |
| `5xx`  | TMS is unavailable.                                                           | Retry later, with the same `Idempotency-Key`. |

Never let a support call break your app: use a short timeout, catch the error, and carry on.

## 6. With the SDKs

Node (18 or later):

```ts
import { TmsClient, parseWebhook, signChatIdentity } from '@tms/sdk';

const tms = new TmsClient({
  baseUrl: 'https://support.example.com',
  apiKey: process.env.TMS_API_KEY!,
});

const ticket = await tms.tickets.create(
  {
    customer: { externalId: user.id, name: user.name },
    subject: 'The price on this listing looks wrong',
    body: form.message,
    externalRef: product.id,
    metadata: { source: product.source, price_current: product.price },
  },
  { idempotencyKey: form.submissionId },
);

const replies = await tms.tickets.messages(ticket.reference, { after: lastSeen });

await tms.incidents.report({
  fingerprint: 'scraper.run_failed',
  title: 'Scraper exited with code 1',
});
await tms.incidents.resolve('scraper.run_failed');
```

Python (3.8 or later, no dependencies: copy `tms_support.py` into your project):

```python
from tms_support import TmsClient, TmsError, verify_webhook_signature, sign_chat_identity

tms = TmsClient("https://support.example.com", os.environ["TMS_API_KEY"])

try:
    ticket = tms.create_ticket(
        {"externalId": user.id, "name": user.name},
        "The price on this listing looks wrong",
        form.message,
        external_ref=product.id,
        metadata={"source": product.source, "price_current": product.price},
        idempotency_key=form.submission_id,
    )
    tms.report_event("scraper.run_failed", "Scraper exited with code 1", severity="error")
    tms.resolve_event("scraper.run_failed")
except TmsError as err:
    log.warning("support desk: %s (%s)", err.message, err.status)
```

Both clients are tested against the same fixed signatures (`signature-vectors.json`), and the Node SDK is tested against the real API.

## 7. A checklist before going live

- [ ] The API key and both secrets are only on your server, and not in your repository.
- [ ] Calls that create something send an `Idempotency-Key`.
- [ ] Your webhook endpoint verifies the signature on the raw body and answers within five seconds.
- [ ] Your webhook handler does each delivery's work once (`id`).
- [ ] A support call that fails does not fail the user's request.
- [ ] Fingerprints are per kind of failure, not per occurrence.
- [ ] A worker's key has only `integration:event`; a storefront's only `integration:ticket`.
