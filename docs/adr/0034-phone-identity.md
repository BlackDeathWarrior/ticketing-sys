# ADR 0034: Phone identity

Status: accepted (2026-10-03).

## Context

Someone who writes to a company's WhatsApp line is known only by the number Meta shows. A number says nothing about which account in an outside app it belongs to, so the AI could not safely look up that person's orders: anyone can write from any number and claim to be a customer. An app that has a signed-in user needs a way to prove, once, that this user owns this number.

## Decision

- **The desk runs the verification.** `POST /integration/customers/phone-verifications` makes a 6-digit code and sends it to the number over WhatsApp; `.../check` takes what the customer typed (`PhoneVerificationService`, scope `integration:customer`). The app never sees the code. Only a keyed hash is stored (HMAC with the server secret, bound to the row); the code is not logged, audited, returned or put in a conversation. A code lasts 10 minutes, works once, and is spent after 5 wrong tries; a new code retires the earlier one.
- **Rejected: the app makes the code and the desk only relays a message.** It would give every key a general "send a WhatsApp message to this number" route, and the desk would have to take the app's word that the code is real and that the typed answer matched. With the desk holding the code, the proof is the desk's own.
- **The code is sent inside the request.** This is a stated exception to "don't send to external services inside a request": the app can show Meta's refusal (no approved template, a number WhatsApp will not reach) at once, and nothing is stored when the send fails. Sending later from the worker would turn that into a silent failure and leave the user waiting for a code that never comes. The code goes out as an approved authentication template when one exists (it works at any time), otherwise as plain text, which WhatsApp allows only inside the customer's 24-hour window. Without a template and outside the window the call answers 409.
- **One proven number per customer; the latest proof wins.** `CustomersService.provePhone` links the number as a verified phone and drops the customer's earlier proven number. Whoever else held the number loses it. Another customer known only by that number (no email, no other number) is merged into the customer, since they were the same person on another channel; a customer with anything else is not merged, and only the number moves. WhatsApp user ids follow the number when it was that customer's only WhatsApp number, because WhatsApp finds a sender by user id before the number.
- **Limits are always on.** One code a minute and five an hour for a number, ten an hour for one of the key's customers, even with `RATE_LIMITS` off (ADR 0021): every code is a paid message to someone's phone. The hourly bound for a number is also checked in the table, so it holds when Redis is down. Code rows are purged after one day.
- **The AI on WhatsApp.** On a WhatsApp conversation, tools bound to a customer run only when the conversation's number is a proven number of that customer, on any kind of ticket (`boundEmail`, prompt `agent-v10`). A message from a sender whose number Meta withholds clears the conversation's stored number, so a number seen earlier cannot carry over.
- **Staff can still mark a phone identity verified by hand.** Anyone with `customer:write` can add a phone to a customer as verified. That is a person's judgement, recorded in the audit log, and it counts as proof for the AI like any other.
- **The AI also needs an email.** Customer tools are bound to the customer's email, so a customer made from `externalId` alone needs one: the check call stores the `email` it is given as verified.

## Consequences

- The shop's key needs `integration:customer`; the demo loader gives it to the web key. SDK, Python client and the integration guide have the two calls.
- Orbit Desk's WhatsApp settings say whether codes will go out as a template or only reach numbers that wrote in the last 24 hours.
- A customer who proves a second number loses the first as proven. Keeping several would need a different rule for which one the AI trusts.
- A holder that has two WhatsApp numbers keeps its WhatsApp user ids when it loses one of them, so messages from that WhatsApp account keep resolving to the old holder and get no tools. This needs a number change inside one WhatsApp account and is left as it is.
- The work shipped compile-only, with no tests and no golden, by the user's decision. Treat it as untested until it has been tried by hand against a real WhatsApp line.
