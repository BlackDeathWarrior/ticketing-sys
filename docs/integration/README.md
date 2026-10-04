# Connecting your app to TMS

This guide is for a developer adding support to an existing app. When you finish, your app can:

- raise a ticket for one of its users and show them the answer;
- report its own failures as incidents that open, update and close one ticket;
- prove that a user owns a WhatsApp number, with a code sent over WhatsApp;
- be told about ticket changes by signed webhooks;
- show a chat on its pages that knows who the visitor is and what they are looking at.

Each part works without the others. Most apps start with tickets and add the rest as they need it.

- [Webhooks](./webhooks.md): events, payloads, verifying signatures, retries.
- [Chat widget](./widget.md): the snippet, options, signed-in visitors.
- Clients: [`@tms/sdk`](../../packages/sdk) for Node, [`tms_support.py`](./examples/python/tms_support.py) for Python (one file, standard library only).
- The live API reference is at `/docs` on your TMS address (tag "integration API").

## 1. Set up the integration

An administrator does this once, in Orbit Desk under **Settings → Integrations**.

1. **Add integration.** Give it a name and an identifier (for example `acme-store`). The identifier cannot be changed later.
2. **Create key.** Choose what the key may do:

   | Scope                  | Allows                                                     |
   | ---------------------- | ---------------------------------------------------------- |
   | `integration:ticket`   | Create and read the integration's own tickets and messages |
   | `integration:event`    | Report incidents and recoveries                            |
   | `integration:customer` | Prove a customer's phone number                            |

   The key (`tms_sk_…`) is shown once. Store it where your server keeps its secrets. Give each part of your app its own key with only the scopes it needs: a storefront backend needs `integration:ticket` (and `integration:customer` if it proves phone numbers), a background worker needs `integration:event`.

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
  "integration": { "slug": "acme-store", "name": "Acme Store" },
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
  "replying": false,
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

**Who is answering.** `handling` is `ai` while the assistant answers the ticket, `handed_over` when it has passed it to the team and nobody has picked it up yet, `human` once a person answers, and `none` when nobody has started. `replying` is `true` while the assistant is writing an answer it will send by itself (the customer wrote last and the workspace lets the AI answer this channel without review): that is the moment to show a "typing" indicator, and it turns `false` when the answer arrives. When the workspace has the AI write drafts for a person to check, `replying` stays `false` and the customer is sent a message saying a person will reply. Stop showing the indicator after about a minute anyway, in case no answer comes. When the assistant hands over, the customer gets a message saying a person will reply, with the colleague's first name when the ticket went straight to someone.

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

## 5. Proving a phone number

Use this when your app needs to know that a user owns a WhatsApp number. Once the number is proven, the AI acts for that user when they write to your WhatsApp line from it (it looks up their orders, for example). From a number that is not proven, the AI's tools that read or change a customer's data do not run.

The customer also needs an email on file, because the AI's customer tools are bound to it. A customer made from `externalId` alone has none: pass `email` in the check call and TMS stores it as verified.

TMS sends a 6-digit code to the number over WhatsApp. Your user types it into your app, and you hand it back to TMS to check. The key needs the `integration:customer` scope, and WhatsApp must be connected in TMS.

```bash
# Send the code
curl -X POST https://support.example.com/api/v1/integration/customers/phone-verifications \
  -H "Authorization: Bearer $TMS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "customer": { "externalId": "user-42", "name": "Asha Verma" }, "phone": "+91 98300 12345" }'

# Check what the user typed
curl -X POST https://support.example.com/api/v1/integration/customers/phone-verifications/check \
  -H "Authorization: Bearer $TMS_API_KEY" -H "Content-Type: application/json" \
  -d '{ "customer": { "externalId": "user-42" }, "phone": "+91 98300 12345", "code": "482913" }'
```

Both answer `200`. The first returns when the code expires and how it was sent, the second the number as TMS keeps it:

```json
{ "expiresAt": "2026-10-03T10:40:00.000Z", "sentVia": "template" }
```

```json
{ "verified": true, "phone": "919830012345" }
```

- `customer.externalId` is your own id for the person, the same one your ticket calls use. `email` and `name` are optional. Only the check call uses them: the send call accepts them and does nothing with them. In the check call, an `email` is stored as a verified email for the customer, as it is when you raise a ticket, and a `title` (`Mr.`, `Ms.`, `Mrs.`, `Mx.` or `Dr.`: how the person chose to be addressed) is kept so the AI can address them by it. Send a title only when the person chose it; the AI never works one out from a name.
- `phone` is the full international number, 8 to 15 digits. Spaces, dashes and a leading `+` are ignored. Use the same number in both calls.
- `sentVia` is `template` when TMS used an approved WhatsApp authentication template (it works at any time) and `text` when it sent plain text, which WhatsApp allows only to a number that wrote in the last 24 hours.
- The code is sent inside the request. If Meta refuses it, the call fails with the reason, so your app can tell the user at once. Nothing is stored when the send fails.
- You never see the code. It reaches the user's phone only.

A code lasts 10 minutes, works once, and is spent after 5 wrong tries. A new code for the same user and number retires the earlier one.

**Errors.** A wrong check answers `400` with a `reason` you can show in your own words:

| `reason`            | Meaning                                         | What to do                            |
| ------------------- | ----------------------------------------------- | ------------------------------------- |
| `wrong-code`        | The digits do not match.                        | Let the user try again.               |
| `expired`           | The 10 minutes are over.                        | Send a new code.                      |
| `too-many-attempts` | The code has had 5 wrong tries.                 | Send a new code.                      |
| `no-code`           | There is no open code for this user and number. | Send a code first, or send a new one. |

Other answers:

| Status | Meaning                                                                                                                                                                                    | What to do                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `409`  | WhatsApp is not connected; or there is no approved authentication template and the number has not written in the last 24 hours; or the number was linked to another customer a moment ago. | Tell the user it cannot be done now. For the last case, try again. |
| `429`  | Too many codes (see Limits). `Retry-After` says how many seconds to wait.                                                                                                                  | Wait, then offer to send again.                                    |
| `502`  | Meta refused the message. `message` carries Meta's reason.                                                                                                                                 | Tell the user the code could not be sent.                          |

**Limits.** One code a minute and five an hour for a number; ten an hour for one of your users. These are always on, even where other limits are switched off, because every code is a paid WhatsApp message to someone's phone.

**What a proof does.** A customer has one proven number, and the latest proof wins. If another customer is known only by that number, the two are merged into the customer who proved it. Any other customer who held the number just loses it.

### Telling a customer something in writing

When your app does something for a customer after the conversation is over (a return approved, a refund issued), it can have TMS tell them. You give the sentence; TMS sends it, as it is, to the number that customer has proven, over WhatsApp. The same key scope applies (`integration:customer`).

```bash
curl -X POST https://support.example.com/api/v1/integration/customers/notices   -H "Authorization: Bearer $TMS_API_KEY" -H "Content-Type: application/json"   -d '{ "customer": { "externalId": "user-42" }, "text": "Your return for order ET-100123 is approved. Your refund is on its way.", "about": "Return approved" }'
```

It answers `200` either way, and says whether the message went out:

```json
{ "sent": true, "via": "whatsapp" }
```

```json
{ "sent": false, "via": null, "reason": "their last WhatsApp message is more than 24 hours old" }
```

- Only a customer you have named before (`externalId`) can be reached, and only on the number they proved: you never pass a number. An unknown customer is a `404`.
- WhatsApp lets a business write freely only to someone who wrote to it in the last 24 hours. Outside that window nothing is sent and `reason` says so; treat a notice as a courtesy, not as delivery you can rely on.
- `text` is up to 600 characters. At most 20 notices per customer per hour.

## 6. Showing items as cards on WhatsApp

Use this when the AI should show items from your app, such as products, as picture cards on WhatsApp. The AI never writes a picture, a price or a link itself: it can only pick items that one of your tools returned in the same turn.

A tool (see ADR 0017 for how a tool is defined) adds `cards` to its result, next to whatever else it returns:

```json
{
  "orders": [],
  "cards": [
    {
      "id": "sku-1042",
      "title": "Block-print cotton kurta",
      "text": "Indigo, sizes S to XL. Rs 1,499",
      "imageUrl": "https://shop.example.com/img/1042.jpg",
      "url": "https://shop.example.com/p/1042"
    }
  ]
}
```

| Field      | Required | Limit                                                      |
| ---------- | -------- | ---------------------------------------------------------- |
| `id`       | yes      | 1 to 100 characters. Your own id for the item.             |
| `title`    | yes      | 1 to 80 characters.                                        |
| `text`     | no       | Up to 200 characters.                                      |
| `imageUrl` | yes      | An `https` address, up to 1,000 characters.                |
| `url`      | no       | An `https` address, up to 1,000 characters. The item page. |

- TMS reads at most 20 cards from one result. A card that is not valid is dropped, and so is a second card with an id already seen. Addresses that are not `https` are not accepted.
- The AI shows at most 10 cards in one reply, because a WhatsApp carousel holds 10. One card goes as a single picture message.
- Each card carries two buttons, "I like this" and "View product". "View product" is there only when every card in the reply has a `url`. A customer who taps it gets the `url` back at once. The AI is not asked.
- Cards are shown only on WhatsApp. Other channels get the reply text alone.
- If WhatsApp cannot show the cards, the reply goes as plain text and the ticket in Orbit Desk says why. The reply is too long, or Meta refuses the cards for a reason a retry cannot fix: it goes as text at once. A temporary failure is retried with the cards, and if the last attempt fails too, the reply is sent once more as text. In every text fallback the items are listed under the reply, one line each: the title, then the text and the `url` when the card has them.

## 7. Errors and limits

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

## 8. With the SDKs

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

await tms.customers.startPhoneVerification({
  customer: { externalId: user.id },
  phone: form.phone,
});
try {
  await tms.customers.checkPhoneVerification({
    customer: { externalId: user.id },
    phone: form.phone,
    code: form.code,
  });
} catch (err) {
  // A 400 TmsApiError: err.body.reason is 'wrong-code', 'expired', 'too-many-attempts' or 'no-code'.
}
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
    tms.start_phone_verification(user.id, form.phone)
    tms.check_phone_verification(user.id, form.phone, form.code)
except TmsError as err:
    log.warning("support desk: %s (%s)", err.message, err.status)
```

Both clients are tested against the same fixed signatures (`signature-vectors.json`), and the Node SDK is tested against the real API.

## 9. A checklist before going live

- [ ] The API key and both secrets are only on your server, and not in your repository.
- [ ] Calls that create something send an `Idempotency-Key`.
- [ ] Your webhook endpoint verifies the signature on the raw body and answers within five seconds.
- [ ] Your webhook handler does each delivery's work once (`id`).
- [ ] A support call that fails does not fail the user's request.
- [ ] Fingerprints are per kind of failure, not per occurrence.
- [ ] A worker's key has only `integration:event`; a storefront's only the scopes it uses (`integration:ticket`, and `integration:customer` if it proves phone numbers).
