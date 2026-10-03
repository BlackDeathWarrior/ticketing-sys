# ADR 0035: Message cards

Status: accepted (2026-10-03).

## Context

When a customer asks a shop's AI on WhatsApp what it has, a list of names and prices in plain text is poor. WhatsApp can show picture cards, with buttons, in a carousel. The pictures, prices and links belong to the company's app. If the model wrote them, it could invent a product, a price or an address that leads somewhere else.

## Decision

- **Cards come from tools; the model passes ids.** A company tool puts `cards` in its result. The shape is `MessageCard` in `packages/shared/src/cards.ts`. `cardsFromToolResult` reads at most 20 from a result, drops entries that are not valid and accepts only `https` addresses. In `send_reply` the model gives the ids of the cards it wants shown. The agent keeps only cards a tool returned in the same turn, so the model cannot add a picture, a price or a link of its own.
- **Only on WhatsApp, only with company tools.** The `cards` field on `send_reply` is offered only on a WhatsApp conversation that has company tools (prompt `agent-v11`). Other channels never see it. Cards ride only on an answer that is sent or drafted; a handover or a refusal carries none. A draft keeps its cards, and whoever sends the draft sends them too. At most 10 are shown, the most a carousel holds.
- **The AI is told what it showed.** A stored answer that had cards reads `[Cards shown: …]` in the transcript the model sees, so it knows what "the second one" means; when the cards went as text it reads `[Items listed as text: …]`. A customer's tap also carries `[Tapped card: <id>]`, since many cards share a title.
- **Both buttons are quick replies.** Each card has "I like this" and "View product". Meta does not allow a link button and a quick-reply button on the same card, so "View product" cannot open the address itself. A tap comes back as a message that names the card (`metadata.waCard` on the inbound message). A "View product" tap is answered with the card's stored link without a model call (route `card_link`), and the answer cites the card as its source, because a company tool showed it. "I like this" goes to the model like any message.
- **"View product" appears only when every card has a link.** Meta wants the same buttons on every card of a carousel, so one card without a link removes the button from all of them.
- **Fallbacks to text.** A reply longer than a carousel body allows (1,024 characters) goes as plain text. If Meta refuses the cards for a reason a retry cannot fix, the reply goes as plain text at once. A temporary failure (a rate limit, an outage) is retried with the cards; if the last attempt fails too, the reply is sent once more as plain text. If Meta accepts the cards and a delivery report later says they failed, the message is requeued once as plain text (`ConversationsService.requeueWithoutCards`, which the worker and the report handler both call). In every text fallback the items are listed under the reply (`cardsAsText`: title, text and link, one line each), because the model keeps its message short and does not repeat what the cards say. It is the one exception to "statuses only move forward". In each case `metadata.cardsDropped` holds the reason, and Orbit Desk shows it as "Sent as text: …". A requeued message is not told to integrations a second time: its event carries `requeued: true` and produces no second public `message.created` webhook. A message that has `cardsDropped` is never tried with cards again.
- **Orbit Desk shows the cards.** The ticket drawer lists each message's cards (picture, title, text) under its body. Titles and pictures come from an outside app, so the title is rendered as text and the picture is fetched without a referrer.

## Consequences

- A company's tool must return `cards` in the documented shape for any card to appear. The convention is in the integration guide.
- The card `type` value sent to Meta (`CAROUSEL_CARD_TYPE`, `cta_url`) is unproven. It matches Meta's own quick-reply example but no real send has tested it. If Meta refuses it, the reply goes as text with the reason in the note, and the one line to change is in `meta-api.ts`. Check the first real send.
- A shop that wants "View product" to open the page itself would need a different kind of message. That is not possible on a carousel today.
- The work shipped compile-only, with no tests and no golden, by the user's decision. Treat it as untested until it has been tried by hand against a real WhatsApp line.
