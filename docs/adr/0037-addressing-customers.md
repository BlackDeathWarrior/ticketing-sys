# ADR 0037: How the AI addresses a customer

Status: accepted (2026-10-04).

## Context

The user asked that the AI address people as "Mr./Ms." with their first name, their full name or their last name, and that its answers sound less mechanical. A title cannot be read off a name: guessing it gets real people wrong.

## Decision

- **A title is only ever one the customer chose.** An app that knows the person passes `customer.title` (`Mr.`, `Ms.`, `Mrs.`, `Mx.` or `Dr.`, `CUSTOMER_TITLES`) with the phone-verification check call; the desk keeps it in `customers.attributes.title` (`CustomersService.setTitleInTx`, audited). The list is fixed, so the value goes into a prompt as it is. The shop asks for it at sign-up and on the account page.
- **`addressOf` decides the forms.** `apps/api/src/ai/address.ts`, pure: with a title, "Ms. Asha", "Ms. Asha Verma" and "Ms. Verma" (the model varies between them); without one, the first name alone, and the prompt forbids adding a title. A name that is not a person's (an email address, a number, "Customer 42") gives no form, and the model is told not to use a name.
- **Not in every message.** The prompt asks for the name in the first reply and now and then after it. The fixed greeting uses the short form ("Hello Ms. Verma!").
- **Tone.** One line in the agent prompt (`TONE`): everyday words, contractions, a brief acknowledgement, no stock phrases, and never at the cost of accuracy. Prompt version `agent-v13`.
- **A green light for a verified number.** Orbit Desk's ticket drawer shows the customer's phone with a `StatusLight`: green and "Number verified" when a phone identity is verified, grey and "Not verified" otherwise. This is a use of the connection light outside channel health, at the user's request; the label still says it in words.

## Consequences

- A WhatsApp sender whose number is not linked to an account has no title: the AI uses the first name of their WhatsApp profile, or no name.
- The title reaches the desk when a number is proven. A title changed later on the account page reaches the desk the next time a number is proven; the ticket and chat routes do not carry it yet.
- No golden was added for the prompt change, by the user's standing decision.
