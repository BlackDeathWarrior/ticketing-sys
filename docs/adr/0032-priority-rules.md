# ADR 0032: Priority rules set by the people who run support

Status: accepted (2026-10-03).

## Context

A ticket's priority came from the channel (always Normal), the app that raised it, an incident's severity, the classifier (raise-only, when confident), the AI's `update_ticket` tool and people. Nothing let a support team say what matters to it: a customer whose payment failed waited behind someone asking a price, until the classifier happened to agree. The SLA follows priority, so this decided response times too.

## Decision

- **Rules.** An ordered list (`tickets.priority_rules` in the settings store; `packages/shared/src/priority.ts`). Each rule has conditions, all of which must hold: channel, category, customer type, tag, keywords or phrases in the subject or message (whole words), part of the classified intent, the classified sentiment, a value the app sent with the ticket (`payment = failed`). It gives a priority. The first enabled rule that matches wins; a rule with no conditions never matches.
- **When.** At creation, the ticket is born with the rule's priority (`InboundService`), above what the app asked for only if the rule says more. Once classified, the rules run again with the intent and sentiment known (`AiClassifierService`). When the customer writes again, their new words can raise it (`TicketsService.raisePriorityInTx`). After creation a rule only ever raises a priority, so a priority a person lowered is not pushed back up by the same text, and SLA timers follow through the usual `ticket.updated` event.
- **Who.** `settings:priority`: super admins, and any role they grant it to (it is delegable, ADR 0031). Settings → Priority edits the list (order, conditions, priority, on or off), adds example rules that use words rather than ids (payment failed or charged twice → High; the app reports a failed payment → High; an upset customer → High; a price or stock question → Low), and tries a message against the saved rules.
- **The AI queue** orders turns by the ticket's priority (ADR 0030), so the rules also decide who is answered first when the queue is long.

## Consequences

- The classifier still runs; its own priority suggestion stays raise-only and the rules come after it.
- A badly written keyword rule can raise many tickets. The test box shows what a message would get before anyone is affected.
- Not built: a separate record of where a priority came from (rule, AI, app, person); the audit trail names the rule that raised it.
