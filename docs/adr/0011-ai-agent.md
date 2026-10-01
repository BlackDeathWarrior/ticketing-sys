# ADR 0011: The first-line AI agent, its confidence policy and drafts

Status: accepted (2026-09-30)

## Context

The AI agent answers customers first and hands over to people when it should. The decisions it was built to:

- Live channels (web chat, WhatsApp, voice) reply on their own; email is drafts only.
- Send at confidence 0.8 or higher; draft between 0.6 and 0.8; hand over below 0.6.
- Hand over after 3 unsure replies.
- Everything the AI does must be visible and auditable, and the AI must never be able to promise money or dates on its own.

## Decision

**Ownership**

- `AiPolicyService` gives a **new** conversation to the AI (`controller = ai`, ticket → `ai_handling`) when two things hold: the channel's mode in the `ai.behaviour` setting is not `off`, and some model can serve `chat_agent`.
- With no model configured, nothing changes: the helpdesk works exactly as before.
- A person replying on the conversation takes it over (`controller = human`), and any waiting AI draft there is discarded as superseded.
- A customer replying on a `pending_customer` ticket that the AI owns sends it back to `ai_handling`, not `in_progress`.

**Dispatch**

- A `message.received` event on an AI-owned conversation enqueues a job on the `ai-turns` BullMQ queue, keyed by message id so each message is answered at most once.
- A Redis lock serialises turns per conversation. A turn answers everything the customer has written since the last reply, so a burst of messages gets one answer.
- New customer tickets also get a `classify` job.

**A turn** (`AiAgentService`)

1. An explicit request for a person (English or Hindi) hands over straight away.
2. Otherwise the agent sees a versioned system prompt (`agent-v1`) with:
   - the customer, the ticket, a rolling summary for long conversations, and categories;
   - the top 3 **public** knowledge-base passages for the latest message;
   - the conversation, with customer text wrapped in `<customer_message>` tags (data, not instructions).
3. It can call `search_knowledge`, `update_ticket` (category, or raising the priority) and `request_human`, and ends with `send_reply(message, confidence, sources, language, intent, resolves_issue)`.
4. Every tool argument is validated with zod, the turn is capped at `maxSteps`, and the model is chosen by the router (ADR 0008).

**Policy** (`policy.ts`, pure and unit-tested)

- Start from the model's own confidence (0.5 if it gave none).
- A factual reply (numbers, durations, amounts) with **no cited source** is capped just below the send threshold, so it is drafted.
- A reply that **promises** money, credits, cancellations or dates when no tool confirmed it is capped below the handover threshold, so it is handed over.
- Below `handoverBelow` → hand over. Enough unsure turns since the last handover → hand over. At or above `sendAt` on an `auto` channel → send. Otherwise → draft.
- Budget exhausted, no model, a model error, or no final answer → hand over.

**Actions**

- **Sent:** an `ai`-authored message goes through the normal delivery path (`pending` → worker → channel). A confident answer that settles the question moves the ticket to `pending_customer`.
- **Drafted:** stored as `draft` and never delivered. Agents with `message:approve_draft` send it as is, edit then send, or discard it. Visitors never see drafts in chat history.
  - Added 2026-10-01: on web chat and WhatsApp (channels in `auto` mode) the customer is told once that a member of the team will reply (`OutboundService.holdingReply`, `waitingMessage` in `ai/policy.ts`). It is an automatic message (author `system`): not the AI's answer, not a first response, and not sent again until someone has actually answered. Before this a visitor whose question the AI was unsure about saw nothing at all.
- **Handed over:** the conversation goes back to the queue (`controller = none`) and the ticket to `human_assigned`. An AI-authored internal note gives the reasons, the last customer message, the knowledge consulted and any unsent answer. On live channels the customer is told a colleague will reply.

**Records**

- Every turn and classification writes an `ai_runs` row: model, prompt version, tools, sources, confidence, rules, decision, cost, latency, error.
- It also writes an audit entry and an `ai.turn_completed` event with actor type `ai` (`AI_CTX`). Handovers additionally write `ai.handover`.

**Classifier**

- Returns JSON: category, subcategory, priority, language, intent, sentiment, confidence.
- It only fills gaps: it never overrides a category a person chose, and only ever raises priority (at confidence 0.6 or more).
- It sets the customer's language when unknown. The suggestion is stored on the ticket as `ai_classification`.

**Language**

- Detected from the writing system, or by Sarvam `text-lid` when a Sarvam key is set and the text is Latin script.
- Stored on the conversation. The agent replies in it; the handover message has English and Hindi versions.

**Visibility in Orbit Desk**

- Rules from DESIGN.md: shape, label and opacity, never colour.
- AI messages and notes carry a sparkle "AI" mark, an "AI" avatar and 0.72 opacity, with confidence and sources underneath.
- Drafts are not dimmed and carry the attention accent.
- The drawer shows "AI is replying", the classification, and an "AI activity" list of runs.
- The activity feed marks AI actions the same way.

**Evals**

- Golden conversations live in `apps/api/test/evals/*.yaml`.
- CI runs them through `POST /ai/simulate` against the scripted model, which checks the pipeline, routing, rules and decisions.
- `pnpm ai:eval` runs them against the configured models, which checks answer quality.
- The same endpoint powers "Try the agent" in Settings → AI behaviour.

## Consequences

- No AI reply bypasses the delivery, audit and outbox rules; drafts and handovers are just other outcomes of the same turn.
- The fake model is deterministic but naive: its confidence comes from word overlap. Tests assert decisions and wiring; answer quality needs real models (`pnpm ai:eval`).
- A turn can take several model calls. They run in the worker, never in a request, and a turn that can't reach a model hands over rather than leaving the customer waiting.
- Phase 7 builds on this: explicit take-over and hand-back, routing of handed-over tickets, context packs, SLA.
