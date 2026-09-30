# ADR 0004: Channel pipeline and delivery

Status: accepted (2026-09-30)

## Decision

**Inbound.** Every channel adapter converts its native payload into a `MessageEnvelope` (`packages/shared/src/channels.ts`) and calls `InboundService.handle()`. In one transaction, holding an advisory lock per sender and channel, it:

1. drops duplicates by `(channel, channelMessageId)` (webhook retries, resent chat messages, re-fetched mail);
2. resolves the customer from the sender identity. Only verified identities link to an existing customer; unverified extras (an email typed into the chat widget) attach only if nobody owns them;
3. finds the conversation: email by Message-ID references, then by a `[TMS-n]` subject tag _only if the sender is that ticket's customer_; other channels by thread key;
4. opens a ticket (closed tickets are never reopened) or moves a resolved/pending ticket back to In Progress;
5. stores the message, audit entry and `message.received` event.

**Outbound.** An agent reply is stored as `pending` with a `message.outbound` event in the same transaction. The worker's `DeliveryHandler` sends it through the channel's sender (Socket.IO emitter for chat, SMTP for email), records `sent` or, after the last retry, `failed` with the error. Email replies get their Message-ID, In-Reply-To and References when the reply is stored, so retries reuse the same Message-ID.

**Realtime.** API instances run Socket.IO with the Redis adapter (`/agent` for consoles, `/chat` for visitors). The worker publishes through `@socket.io/redis-emitter`: a fan-out handler turns ticket/message events into `event` pushes to agents, and chat delivery emits to the visitor's room.

**Worker placement.** The worker is a second entry point (`dist/worker.js`) of the API codebase, a Nest application context importing the same domain modules. This replaces the separate `apps/worker` package from ADR 0002, so background jobs use the same services and rules as HTTP requests.

**Latency.** The outbox relay LISTENs on a Postgres NOTIFY fired by an insert trigger on `outbox_events`, so events move within milliseconds; polling remains as a fallback.

## Consequences

- A new channel (WhatsApp in Phase 8, voice later) is an adapter plus a sender; ticket logic doesn't change.
- Delivery status is visible per message, and failures are auditable.
- The mailbox is read by one worker at a time (Redis lock), so scaling workers doesn't duplicate intake.
- Dev mail uses GreenMail as the support mailbox (IMAP) and Mailpit to view outgoing replies. Production points `EMAIL_*` at the real mailbox; Microsoft Graph / Gmail API adapters can replace IMAP later without touching the pipeline.
