# ADR 0028: Tools act only for customers the app has named

Status: accepted (2026-10-02).

## Context

An app with accounts can say who a customer is, and its tools read and change that customer's data (orders, payments, bookings). Tools are bound to the ticket's customer (ADR 0013: `customerArg` is filled by TMS, never by the model), but on chat the ticket's customer could be whatever a visitor typed into the widget's name form. Typing someone else's email would have made the AI read that person's orders out, or cancel one.

A signed-in customer also expects to see "my requests" without keeping a link, and the integration API could only find tickets by reference or by `externalRef`.

## Decision

### Tools act only for a customer the app has named

On a ticket that belongs to an integration, a tool that takes the customer (`customerArg`) runs only when the ticket's customer has an identity that integration vouched for: an `external_id` identity `<slug>:…`, which exists only when the app sent `customer.externalId` with its API key, or signed a chat identity token (ADR 0026). `AiAgentService.boundEmail` decides it; without such an identity the gateway refuses the call ("The customer is not identified"), it is recorded as a refused tool call, and the AI hands over to a person.

- A visitor who types an email into the chat gets answers from the knowledge base and tools that take no customer (a status check, a product lookup). Anything about their own account goes to a person.
- Tickets that belong to no integration (email, WhatsApp, the help center form) behave as before: those channels establish the sender themselves.
- An app that never sends `externalId` and never signs chat identities cannot use customer-bound tools on its integration's tickets, which is the safe default.

The app's tools should check again on their side: each takes the customer's email and answers about that customer's data only, and a record that is not theirs should look exactly like one that does not exist.

### An email the app vouches for is verified, and wins

When an app sends `customer.externalId` together with an email, the app is saying it knows this person, so the email identity is stored as verified. If an unverified customer already holds that email (someone typed it into a chat), the email moves to the customer the app named (`CustomersService.attachIdentity`, audited). Without this, whoever typed an address first would keep it, and the real account holder's tickets would have no email to bind tools to. A verified email is never taken from its holder this way.

### Listing a customer's tickets

`GET /integration/tickets?customer=<externalId>` lists the tickets of the customer the app knows by that id, and every ticket the integration API returns carries `customer.externalId`. It is scoped to the calling key's integration like every integration route. The SDK, the Python client and the guide changed with it.

### No stand-ins for third parties in TMS

Decided 2026-10-01 and unchanged: TMS holds no simulator of a provider it integrates with. An app connected for a demonstration may simulate its own business, as long as everything between it and TMS travels the public integration API.

## Consequences

- An anonymous chat cannot reach customer-bound tools on an integration's tickets. Integrations that want them must send `externalId` or sign chat identities.
- The takeover of an unverified email is a deliberate trust decision: a key with the ticket scope can attach any unverified email to a customer it names. The key already lets that app raise tickets for any email, so this adds no new reach.

## Not done

- Multi-tenancy (Phase 15).
