# ADR 0012: The help-center request form is a channel answered by email

Status: accepted (2026-09-30)

## Context

Customers could reach support by web chat and email, and later WhatsApp and voice. They had no page for filing a request: a form with a subject, a description and files that gives them a reference. We agreed to add the form now and a customer portal (sign in, see my tickets, reply, rate) in Phase 10.

The form is public, so anyone can submit it with any email address.

## Decision

**A channel, not a shortcut to `POST /tickets`**

- The form is a channel adapter, `web_form`, like email and chat.
- `WebFormService` turns a submission into a `MessageEnvelope`, and `InboundService.handle()` does the rest in one transaction:
  - customer resolution by email;
  - ticket and conversation;
  - the message with its attachments;
  - audit and outbox.
- So the form gets the same AI dispatch, classification, reports and live updates as every other channel.
- The envelope gained an optional `ticket.categoryId` hint. It is applied only when the message opens a new ticket, and validated like any other category.

**Public, but write-only**

- `GET /public/request-form` returns the topics (top-level category ids and names) and the upload limits.
- `POST /public/requests` accepts either:
  - multipart: fields plus up to 3 `files` of 10 MB each, stored in S3 like email attachments;
  - JSON, with no files.
- Both routes are `@Public()`, and the POST only creates.
  - It returns the new ticket's reference and nothing about any existing ticket or customer.
  - The thread key is the submission id, so a submission never joins an existing conversation.
  - This means someone who types another person's email address learns nothing and changes nothing they didn't already have.
- The page generates a `submissionId` (UUID) per form. It is the channel message id, so a double click or a retry returns the same reference instead of a second ticket.
- **Spam:** a honeypot field, which bots fill and people never see, is rejected. Rate limiting comes with the other public endpoints in Phase 11.

**Answered by email**

- The form's conversation stores the address and subject, like an email conversation.
- `OutboundService` sends replies on `web_form` conversations by email, and `EmailSender` delivers for both channels.
- **Acknowledgement:** on `message.received` for a new `web_form` ticket, the worker's `WebFormAckHandler` sends the reference and how to add details.
  - The message is authored by `system`. It is not a first response, and it doesn't take the conversation over.
  - Its Message-ID is derived from the submission, so a retried event never sends it twice.
  - With email off, the ticket still exists and only the acknowledgement is skipped.
- **Customer replies** to any of these emails thread back onto the form's conversation. Matching is by Message-ID across `email` and `web_form`, then by the `[TMS-n]` subject tag.
- **AI:** the AI treats `web_form` like email, as drafts only by default (Settings → AI behaviour), because nobody is waiting live on the page.

**Where the page lives**

- `apps/help-center` is a small React app served by the `web` container at `/help/`, next to the chat widget (`/widget/`).
- It loads the widget, so customers can choose between chatting and filing a request.
- It uses the shared zod schema for client-side checks, so the page and the API give the same messages.
- It is the customer-facing surface. DESIGN.md governs Orbit Desk, not this page, which follows the Demo Store brand of the widget.
- The Phase 10 portal goes in the same app.

**Orbit Desk**

- The drawer now shows message attachments as download chips (fetched with the agent's token), the ticket's category, and message paragraphs.
- The queue has a channel filter.
- These gaps also affected email tickets.

## Consequences

- One more public write endpoint. It is narrow and idempotent, but it can be abused to create tickets and send one acknowledgement email to an arbitrary address. The honeypot stops naive bots, and Phase 11 adds rate limits per IP and per address.
- Follow-ups need email. Customers who lose the email can submit again or use chat until the Phase 10 portal lets them see their tickets.
- A `web_form` conversation can hold inbound messages whose own channel is `email` (the customer's replies). Delivery, dedupe and reports key on the conversation's channel and the ticket's channel respectively, so this is consistent.
