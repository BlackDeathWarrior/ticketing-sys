# Webhooks

TMS tells your server when something happens, with a signed HTTP `POST`. Use webhooks to show a user their answer the moment an agent sends it, to mirror ticket status in your app, or to react when an incident is resolved.

Back to the [integration guide](./README.md).

## Set one up

In Orbit Desk: **Settings → Integrations → your integration → Add webhook**.

- **Address**: a public `https` URL on your server.
- **Events**: the ones you want (below).
- **About**: "This integration's tickets and incidents" (the default), or "Every ticket in the workspace". The second sends tickets from every channel, including their customers' messages, so choose it only for your own back office.

You are shown a **signing secret** (`whsec_…`) once. Store it with your other secrets. **Send a test** posts a `ping` so you can check your endpoint before anything real happens.

## Events

| Event                   | When                                                                | `data`                               |
| ----------------------- | ------------------------------------------------------------------- | ------------------------------------ |
| `ticket.created`        | A ticket was created                                                | `ticket`                             |
| `ticket.updated`        | Subject, priority, category or tags changed                         | `ticket`, `changed` (field names)    |
| `ticket.status_changed` | The status changed                                                  | `ticket`, `from`, `to` (status keys) |
| `ticket.assigned`       | The assignee or team changed                                        | `ticket`                             |
| `message.created`       | A message the customer can see was added, by them or to them        | `ticket`, `message`                  |
| `incident.opened`       | An incident opened                                                  | `incident`                           |
| `incident.updated`      | It kept happening (noted at 2, 10, 100, 1,000 reports) or got worse | `incident`                           |
| `incident.resolved`     | It was resolved                                                     | `incident`                           |
| `approval.requested`    | An action the AI asked for is waiting for a supervisor              | `ticket`, `approval`                 |
| `approval.decided`      | A supervisor approved or rejected it                                | `ticket`, `approval`                 |
| `csat.submitted`        | A customer rated a ticket                                           | `ticket`, `rating`                   |
| `ping`                  | You pressed "Send a test"                                           | `message`                            |

`approval` is `id`, `status` (`pending`, `approved` or `rejected`), `action`, `tool` and `summary`. On `approval.decided` it also carries `reason`: what the person who decided wrote for the customer. Their note for colleagues is not sent.

Internal notes, AI drafts and anything else a customer cannot see are never sent.

## What arrives

```http
POST /support/webhook HTTP/1.1
Content-Type: application/json
User-Agent: TMS-Webhooks/1.0
X-TMS-Event: message.created
X-TMS-Delivery: 5b0c9a52-6d55-4f0c-9d0e-3a1f6d1c2b7e
X-TMS-Signature: t=1790000000,v1=00c77c95442d04dd586e98d6f729b5f1761b29b2af360c13679ea85340a19a89
```

```json
{
  "id": "5b0c9a52-6d55-4f0c-9d0e-3a1f6d1c2b7e",
  "type": "message.created",
  "createdAt": "2026-10-01T10:12:31.000Z",
  "integration": "ethnic-threads",
  "data": {
    "ticket": {
      "reference": "TMS-1042",
      "status": { "key": "in_progress", "name": "In Progress", "state": "open" },
      "externalRef": "MYN-48213",
      "…": "…"
    },
    "message": {
      "id": "9f1c…",
      "from": "support",
      "name": "Maya",
      "body": "Thanks, we have corrected the price.",
      "createdAt": "2026-10-01T10:12:31.000Z"
    }
  }
}
```

- `ticket`, `message` and `incident` have the same shape as in the API ([guide](./README.md)).
- `createdAt` is when the event happened. The rest of `data` is read **when the delivery is sent**, so it shows the ticket as it is now. `type`, `from` and `to` tell you what happened.
- A `message.created` for a message your own app posted through the API also arrives. Skip `data.message.from == "customer"` if you only want replies.

## Verify the signature

Anyone can post to your endpoint, so check every request before you use it.

1. Read the **raw** request body, as bytes or text, before any JSON parsing.
2. Take `t` and `v1` from `X-TMS-Signature`.
3. Compute `HMAC-SHA256(secret, t + "." + rawBody)` as lowercase hex.
4. Compare it with `v1` in constant time.
5. Refuse it if `t` is more than five minutes from your clock (a replay).

Node, with the SDK:

```ts
import { parseWebhook, SIGNATURE_HEADER, WebhookSignatureError } from '@tms/sdk';

app.post('/support/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = parseWebhook(req.body, req.header(SIGNATURE_HEADER), process.env.TMS_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return res.sendStatus(401);
    throw err;
  }
  res.sendStatus(204); // Answer first, then do the work.
  if (alreadyHandled(event.id)) return;
  if (event.type === 'message.created' && event.data.message.from !== 'customer') {
    notifyUser(event.data.ticket.externalRef, event.data.message.body);
  }
});
```

Python, with `tms_support.py`:

```python
from tms_support import verify_webhook_signature, SIGNATURE_HEADER

def handle(raw_body: bytes, headers) -> int:
    if not verify_webhook_signature(raw_body, headers.get(SIGNATURE_HEADER), WEBHOOK_SECRET):
        return 401
    event = json.loads(raw_body)
    if event["id"] in handled:
        return 204
    handled.add(event["id"])
    ...
    return 204
```

Without a client, in any language:

```text
expected = hex(hmac_sha256(key = secret, message = t + "." + raw_body))
ok       = constant_time_equal(expected, v1) and abs(now - t) <= 300
```

`signature-vectors.json` in this folder has fixed secrets, bodies and the headers they must produce. Use it to test your own implementation.

## Answering, retries and failures

- Answer any `2xx` within **five seconds**. Do slow work after answering.
- Anything else (a `4xx`, a `5xx`, a redirect, no answer) is a failure. TMS tries again up to 8 times, waiting 5 s, 10 s, 20 s and so on: about ten minutes in all.
- The same delivery can arrive more than once. `id` (also in `X-TMS-Delivery`) stays the same across retries: keep the ids you have handled and skip repeats.
- Deliveries are not ordered. Use `createdAt`, or read the ticket, if order matters.
- After 15 deliveries in a row fail for good, the webhook is switched off and the administrators are notified. Fix the endpoint, then switch it on again in Settings.
- **Deliveries** in Settings shows each one's outcome. **Send again** repeats a delivery as a new one with a new `id`.
- Missed a lot while you were down? Read the tickets through the API instead of replaying the log.

## Rotating the secret

**Rotate secret** in Settings gives a new secret, shown once. Deliveries are signed with it from the next send, so update your server straight away; until you do, your endpoint will refuse them and they will be retried.
