# ADR 0028: The demo app becomes a shop, and tools act only for customers the app has named

Status: accepted (2026-10-02). Supersedes the parts of ADR 0027 that describe the demo app and its scenarios; the three product fixes and the way the app is connected stand.

## Context

ADR 0027 showed TMS as the support desk of Ethnic Threads when that app was a storefront over a scraped catalogue. It proved the integration API, but the stories it could tell were about a scraper: stale prices, failed runs, a re-scrape that needs approval. Most apps that would buy a support desk are not scrapers. They have customers with accounts, orders and money, and their support questions are "where is my order", "cancel it", "I want my money back".

Ethnic Threads was therefore remade (in its own repository, branch `feat/shop`) into a small shop with accounts, a cart, checkout, orders that move through a warehouse and a carrier, cancellations, returns and refunds. The scraper's code stays in that repository and is no longer part of the site; the catalogue it collected is what the shop sells.

Two things followed for TMS.

First, a shop with accounts can say who a customer is, and its tools read and change that customer's orders. Tools are bound to the ticket's customer (ADR 0013: `customerArg` is filled by TMS, never by the model), but on chat the ticket's customer could be whatever a visitor typed into the widget's name form. Typing someone else's email would have made the AI read that person's orders out, or cancel one.

Second, a signed-in customer expects to see "my requests" without keeping a link, and the integration API could only find tickets by reference or by `externalRef`.

## Decision

### Tools act only for a customer the app has named

On a ticket that belongs to an integration, a tool that takes the customer (`customerArg`) runs only when the ticket's customer has an identity that integration vouched for: an `external_id` identity `<slug>:…`, which exists only when the app sent `customer.externalId` with its API key, or signed a chat identity token (ADR 0026). `AiAgentService.boundEmail` decides it; without such an identity the gateway refuses the call ("The customer is not identified"), it is recorded as a refused tool call, and the AI hands over to a person.

- A visitor who types an email into the chat gets answers from the knowledge base and tools that take no customer (shop status, product lookup). Anything about an order goes to a person.
- Tickets that belong to no integration (email, WhatsApp, the help center form) behave as before: those channels establish the sender themselves.
- This is a rule of TMS, not of the demo. An app that never sends `externalId` and never signs chat identities cannot use customer-bound tools on its integration's tickets, which is the safe default.

The shop's tools check again on their side: each takes the customer's email and answers about that customer's orders only, and an order that is not theirs looks exactly like one that does not exist.

### An email the app vouches for is verified, and wins

When an app sends `customer.externalId` together with an email, the app is saying it knows this person, so the email identity is stored as verified. If an unverified customer already holds that email (someone typed it into a chat), the email moves to the customer the app named (`CustomersService.attachIdentity`, audited). Without this, whoever typed an address first would keep it, and the real account holder's tickets would have no email to bind tools to. A verified email is never taken from its holder this way.

### Listing a customer's tickets

`GET /integration/tickets?customer=<externalId>` lists the tickets of the customer the app knows by that id, and every ticket the integration API returns now carries `customer.externalId`. It is scoped to the calling key's integration like every integration route. The SDK, the Python client and the guide changed with it.

The shop uses it for its Help page: a signed-in shopper sees their own requests with no token. A guest who wrote in from the contact form still reads the one request through the tracking token in its link (ADR 0027).

### The demo may simulate the shop, not the world around TMS

ADR 0027 said no "fail now" switch. That rule protected the claim that TMS reacts to real failures of a real app. It is reworded rather than dropped:

- **The shop simulates its own business**, openly. No money is taken and nothing is shipped; paying is one click; orders advance on a clock; the admin's Operations page has switches for "payments are failing" and "the carrier is delayed". Every page that matters says it is a demonstration, and the checkout asks for no card number or UPI id, ever.
- **Everything between the shop and TMS is real.** When the switch makes a payment fail, the shop's checkout code refuses the order and reports an incident through the same call a production app would make. Tickets, incidents, webhooks, signatures, identity tokens, tool calls and approvals all travel the public integration API. Nothing is posted to TMS by hand, no timestamp is edited, and TMS still holds no code for the app.
- **No stand-ins for third parties in TMS** (decided 2026-10-01) is unchanged. The simulated carrier and payment step live in the demo app, where they stand for the shop's own back office, not for a provider TMS integrates with.

### What the demo now shows

| Scenario                         | What triggers it                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Help with an order               | The shopper's request arrives with the order number and the order's facts from the shop's records; the AI looks the order up and drafts the answer |
| Chat that knows the shopper      | A signed identity token; the AI reads that shopper's orders, and cancels one that has not shipped                                                  |
| A visitor posing as someone else | The lookup is refused and the chat is handed to a person                                                                                           |
| Refund with approval             | `issue_refund` is `transactional`: a supervisor approves, the shop refunds, the shopper is told                                                    |
| Payments failing                 | The admin's switch; each failed checkout is one report on one urgent ticket for Operations, which resolves itself when payments work again         |
| Carrier delay                    | The admin's switch; shipped orders stop, the order page and the AI both say so, the incident resolves when the carrier moves                       |
| SLA breach, webhooks, keys       | As in ADR 0027                                                                                                                                     |

The loader's data (`scripts/sample-data/garment/`) was rewritten for a shop: teams (Customer Care, Orders and Delivery, Payments, Operations), categories, routing, a knowledge base that states the shop's real delivery charges and return rules, and seven tools. The scripted model in `apps/fake-providers` recognises `ET-…` order numbers and gained the cancel and list-orders flows; it reuses the sample store's order and refund flows because the shop's tools are named and shaped the same.

## Consequences

- An anonymous chat can no longer reach customer-bound tools on an integration's tickets. Integrations that relied on a typed email being enough must sign chat identities; none existed outside our tests.
- The takeover of an unverified email is a deliberate trust decision: a key with the ticket scope can attach any unverified email to a customer it names. The key already lets that app raise tickets for any email, so this adds no new reach.
- The demo app is more useful as a sales story and less of a proof that TMS copes with a system nobody designed for it. The Phase 14 branch (`feat/phase-14-garment-demo`, with the app's `feat/support-desk-integration`) keeps that proof.
- The demo needs no browser for scraping, no AWS credentials and no outside website.

## Not done

- Multi-tenancy (Phase 15).
- Partial refunds and item-level returns in the shop; a refund is always the whole order.
- Real payment or carrier integrations. They would belong to the app, not to TMS.
