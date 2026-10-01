# ADR 0015: WhatsApp on the Meta Cloud API

Status: accepted (2026-10-01)

## Context

WhatsApp is one of the four channels in the brief. Research on our own `whatsapp-crm` fork (`docs/research/whatsapp-crm.md`) recommended porting its Cloud API adapter instead of running it as a second system.

Two things were decided when this phase started:

- **Port, don't run a sidecar.** One database, one audit trail, one AI agent.
- **No simulator and no fake Graph API.** The original plan had a `pnpm demo:whatsapp` script and a stand-in for Meta in `apps/fake-providers`. The product owner dropped both on 2026-10-01: build the real integration and leave it ready for real credentials.

There is no Meta app yet, so the channel ships switched off.

## Decision

**What was ported** (`apps/api/src/channels/whatsapp/`, MIT, see `THIRD_PARTY_NOTICES.md`)

| File                               | From whatsapp-crm                      | Changes                                                                                                                                                                                                                    |
| ---------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `meta-api.ts`                      | `meta-api.ts`, the template sync route | Graph URL and version come from settings (the original pinned v21.0). Timeouts on every call. Only the calls a helpdesk needs: text, template, media lookup and download, phone check, template list, account subscription |
| `webhook-signature.ts`             | same                                   | The app secret comes from the secrets store, not an environment variable                                                                                                                                                   |
| `wa-identity.ts`, `phone-utils.ts` | same                                   | Trimmed to what is used                                                                                                                                                                                                    |
| `template-send-builder.ts`         | same                                   | Reads the TMS template row; a media header needs a link at send time                                                                                                                                                       |
| `meta-errors.ts`                   | `meta-error-explain.ts`                | Explains failed sends as well as connection errors, and says whether a retry can help                                                                                                                                      |
| `webhook-payload.ts`               | the webhook route                      | Payload types and pure parsing only                                                                                                                                                                                        |

Not ported: broadcasts, flows, the template editor, interactive messages, reactions, multi-account pairing.

**Receiving**

- `GET /channels/whatsapp/webhook` answers Meta's handshake when `hub.verify_token` matches the saved token.
- `POST /channels/whatsapp/webhook` checks `X-Hub-Signature-256` over the raw body with the saved app secret, in constant time.
  - With no secret saved, every request is refused.
  - A valid request is queued (BullMQ `whatsapp-webhooks`) and answered at once, so a slow media download never makes Meta retry.
- The worker handles one webhook at a time, which keeps a customer's messages in order.
- Each message becomes a `MessageEnvelope` for `InboundService.handle()`:
  - text, captions, locations and button taps become text;
  - one image, video, document, voice note or sticker is copied into object storage (25 MB limit), because Meta deletes media after about 30 days;
  - if the file can't be fetched, the message is still stored, with the reason;
  - reactions and system notices are ignored;
  - messages for another phone number on the same Meta app are ignored.
- Meta's message id is the idempotency key, so redelivered webhooks store nothing twice.

**Who the customer is**

- The phone number is the `whatsapp` identity. A customer already known by that number as a `phone` identity is the same person, and the two are linked.
- Since 2026 Meta may send only a business-scoped user id. That is a new identity type, `whatsapp_bsuid`.
  - A user id we already know wins, so one person keeps one record when Meta later reveals the number.
  - Replies to such a customer use Meta's `recipient` field instead of `to`.
- A customer has one WhatsApp thread. Inbound messages are matched by customer, not by a thread key.

**Sending**

- Replies are stored `pending` and sent by the worker's `WhatsAppSender`, like every channel.
- The sender returns Meta's message id. It is saved on the message so later status reports can find it.
- **Failures:** Meta's error code decides.
  - Rate limits, outages and network errors are retried.
  - Everything else (closed window, bad token, number not on WhatsApp, channel not connected) fails at once with a reason an agent can act on. This needed a new `PermanentDeliveryError` in the delivery handler.
- **Status reports** move a message to `sent`, `delivered`, `read` or `failed`.
  - They can arrive out of order, so a status only moves forward.
  - A report that overtakes our own record of the send is retried shortly.

**The 24-hour window and templates**

- The conversation stores when the customer last wrote (`lastInboundAt`, Meta's timestamp).
- An agent's free-text reply is refused with a 409 once 24 hours have passed. The reply box then offers approved templates.
- AI replies are not pre-checked: they answer a message that just arrived. If one is late, Meta refuses it and the reason is shown.
- Templates belong to Meta. TMS syncs the list (`wa_templates`), follows status changes from the webhook, and sends approved ones with their variables filled in.
- A ticket with no conversation can be opened on WhatsApp with a template, when the customer has a phone number.

**Settings**

- The phone number ID, business account ID and Graph version are settings. The access token, app secret and verify token are secrets (ADR 0009).
- WhatsApp settings are read fresh on every use. A cached "off" would silently drop a message that arrives right after the channel is switched on.
- Settings → Channels shows the webhook address, what is still missing, and the templates.

## Testing without Meta

- **Unit tests** cover the ported code with `fetch` stubbed at the call site.
- **Integration tests** post signed webhooks to the real route and run the real queue, worker and sender. Calls to `graph.facebook.com` are answered inside the test process.
- **Browser tests** post signed webhooks to the running stack. Sending has no token there, so they check that failures are explained.
- Nothing in the repository pretends to be Meta at run time.

## Consequences

- WhatsApp is off until an admin enters real credentials. Sample WhatsApp tickets stay as they were: tickets with the WhatsApp channel label and no conversation.
- Meta must reach the webhook over public HTTPS, so real testing needs a tunnel or the AWS demo.
- The port is a snapshot. Meta API changes and upstream fixes must be applied by hand.
- Agents can send text and templates. They can't send files, and the AI doesn't read customers' files.
- One WhatsApp number is supported.
- Inbound messages are not marked as read, so customers don't see blue ticks.
