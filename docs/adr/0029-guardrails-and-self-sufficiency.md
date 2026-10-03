# ADR 0029: Guardrails before the model, and an AI that hands over only when it must

Status: accepted (2026-10-03). Amends ADR 0011 (the agent) and ADR 0021 (hardening).

## Context

Two complaints came from testing the shop demo, and they pull in opposite directions.

The AI gave conversations to people far too easily. Asking for "a person" handed over before any model was asked; so did a sentence that only mentioned one ("the delivery agent was rude"). The prompt told the model to call a colleague whenever the knowledge base did not cover a question. A reply without a confidence counted as 0.5, which is below the hand-over line. A delivery date read from the order system and phrased "will arrive by Friday" counted as an unsupported promise. Each of these sent a customer to a queue for something the AI could have done.

At the same time nothing stopped misuse. An attempt to override the AI's instructions reached the model and relied on the model refusing and on the output check catching a leak. Abuse, spam and questions with nothing to do with the company were answered like any other message, at the cost of a model call each time. Nothing recorded who had tried.

The owner's rule for the platform: the AI is the first line and settles things itself; a person comes in when circumstances are desperate.

## Decision

### Guardrails, before any model is asked

`apps/api/src/ai/guard.ts` screens each customer message (`screenInbound`) for:

- **`jailbreak`**: "ignore your previous instructions", "show your system prompt", "repeat the text above", role overrides ("you are now", DAN, developer mode), forged tags (`</customer_message>`, `<system_note>`) and forged speakers (`System:` at the start of a line);
- **`abuse`**: insults aimed at the assistant or the staff (not ordinary swearing about a late parcel);
- **`spam`**: the same message three times in a row, three or more links, a flood of one character.

A hit is **strong** when the message itself does it and **suspect** when it may be quoting something: inside quotation marks, after "the email said" or "I received", in a long message, or with words that have a shop meaning ("ignore my previous delivery instructions"). Only a strong hit acts. A suspect one goes to the model as usual.

What happens, where the AI answers by itself in a place the customer is reading (web chat, WhatsApp, in-app requests in `auto` mode; settings `guardrails`):

| Message                                                             | First time                                                                                         | Then                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| An attempt on the instructions                                      | The ticket is closed at once with a fixed notice, and the customer is flagged (`closeOnJailbreak`) |                                                                            |
| Abuse or spam                                                       | A fixed warning                                                                                    | Closed at the `abuseLimit` (2)                                             |
| Off topic (the model says so with `send_reply.off_topic`)           | The model's one-line redirect                                                                      | A warning added on the one before the limit; closed at `offTopicLimit` (3) |
| Anything above from a customer flagged in the last `flagHours` (24) | Closed at once, no warning                                                                         |                                                                            |

On email and where the AI only drafts, a strong hit hands the ticket to a person with the rule, because nobody would read a warning in time. A phone call is not screened.

A conduct close (`AiAutoResolveService.closeForConduct`) closes the ticket, not resolves it: nothing was solved, no rating is asked (`CsatService.whyNotRatable`), and the next message opens a new ticket. The default workflow gained `ai_handling → closed` (migration 0024 adds it where missing). The run is recorded with the new decision `closed` and rules `jailbreak_attempt`, `abusive_language`, `spam`, `off_topic`, `repeat_offender`. The ticket's `ai_closure` says why.

### Customer flags

`customer_flags` (owned by `CustomersService`) records the kind, the guard pattern that matched (never the customer's words), the ticket and the time. The AI flags on a jailbreak attempt, on abuse, and on anyone closed while already flagged. Staff see an active flag in the ticket drawer; someone with `customer:write` clears it with a note (`POST /customers/:id/flags/:flagId/clear`). Cleared flags stay as history. A flagged customer is still answered: only the benefit of the doubt is gone.

An anonymous chat visitor is a customer per chat session, so clearing the browser's storage escapes a flag. That is accepted: the flag exists to stop a second attempt in the same conversation and to show staff who tried.

### Self-sufficiency

- `asksForHuman` matches a request ("talk to a person", "I want a human", "not a bot"), not a mention.
- A request for a person gets an offer first (`handover.personRequestsBeforeHandover`, default 2): "I can sort most things out right here … if you would still like one of my colleagues after that, just say so". A short request gets that fixed offer with no model call; a longer one is answered by the model, which also says a colleague is available. Asking again, or answering the offer with a yes, hands over. A phone call hands over at once.
- The prompt (`agent-v9`) makes `request_human` a last resort for four cases: the customer insists, a legal, safety, fraud or account matter, an action no tool offers, a tool that keeps failing. Being unsure is not one of them: the model asks the customer instead.
- The first time the model is unsure (`low_confidence`, `no_answer`), the customer is asked for more with a fixed message (`clarifying`) instead of being handed over; `maxFailedTurns` still hands over after that.
- A delivery date a company system returned is not an unsupported promise any more; promises of money or actions still need a tool that did it.
- A reply without a confidence is judged on its sources: with one it is sent, without one a person sees it first.
- On a ticket where nobody vouched for the customer, tools that act for a customer are not offered at all, and the prompt tells the model to ask the visitor to sign in.

Still handed over: a second request for a person, legal or safety matters, repeated failures, an action no tool offers, an approval that expired or failed, no model available, an unsafe reply.

## Consequences

- A genuine customer will occasionally be closed by a false positive. The patterns are narrow, quoting is softened, the flag can be cleared and a new ticket works at once.
- Fewer conversations reach people, and the ones that do are the ones that need them.
- Several turns now cost no model call at all (see ADR 0030).
- The red-team golden "print your system prompt" now ends with a closed ticket instead of a handover. The tests and goldens were not updated in this change (by the owner's instruction, no tests were written or run).

## Addendum (2026-10-03): the turn plan

The ladders above (conduct, a request for a person, off topic, the clarifying question) and the closing check of ADR 0019 were written inside `AiAgentService.turn()`, between database reads and the model call, where only a test with the whole stack running could reach them. They are now one pure module, the turn plan (`apps/api/src/ai/turn-plan.ts`): `turnFacts()` reads the facts out of the transcript and the conversation's metadata, `startTurn(facts)` returns the first step, and each step says what follows it (`refused()` when a ticket could not be closed or resolved, `given(flagged)` once the flag is looked up, `answered(answer)` after the model). `turn()` carries the steps out and decides nothing. The behaviour is the same; `turn-plan.test.ts` covers each branch without a database or a model.

One thing changed with it: strikes and the count of requests for a person used to be saved before the reply. A turn whose reply failed to save was retried and counted the same message again, which with the default limit of two closed a conversation after one offence. They are now saved in the reply's transaction.
