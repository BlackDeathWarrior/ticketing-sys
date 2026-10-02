# ADR 0030: Answers without a model, and fewer tokens for the rest

Status: accepted (2026-10-03). Amends ADR 0008 (model routing) and ADR 0011 (the agent).

## Context

Every customer message cost at least one embedding and one chat call, and usually more: the classifier once per ticket, up to four agent steps, each carrying the full prompt, the full category list and every company tool's description. Much of that was spent on messages that need no thought: "hi", "thanks", a question the FAQ answers word for word, the same opening question asked by many customers. Nothing was cached.

The AI turns already run on a Redis queue (`ai-turns`, BullMQ). "Add a Redis queue" therefore became better use of that queue rather than a second one.

## Decision

### Answers that need no chat model (`aiBehaviour.fastPaths`)

Checked in `AiAgentService.think` before the model, on every channel except email (an email wants an email):

- **Small talk** (`smallTalk` in `packages/shared/src/ai.ts`): a whole message that is a greeting, a thank-you, "are you there?" or "I need help" gets fixed wording (`smallTalkReply`). "Hi, where is my order?" is a question and goes to the model.
- **FAQ direct answer** (`AiFastPathsService.faq`): the customer's question is compared by embedding with the questions (titles) of the approved public FAQ entries. When the best is at least `faqMinSimilarity` (0.85) and clearly ahead of the next (0.03), its stored answer is the reply. A message that names an order or an amount is never answered this way.
- **Answer cache** (`AiFastPathsService.cached`): the opening question of a conversation with nothing attached (no app context), asked again in the same words, gets the answer the AI gave before, for `answerCacheHours` (24). The key includes the prompt version, the integration, the channel, the language and a revision of the approved knowledge base, so any change to the knowledge base makes earlier answers unusable. Only sourced, sent, settling answers that used no company tool are kept.
- Already in ADR 0019's addendum: "anything else?" answered with a no, and (ADR 0029) every guardrail action.

Each still passes `assess()`: a draft-mode channel still drafts. Each is recorded as a turn with no model and a `no_model` tool line saying which path answered; `GET /ai/savings` counts them per day in Redis and Settings → AI behaviour shows the last 30 days.

### Fewer tokens on the model path

- The category list is sent only while the ticket has none, and `update_ticket` is offered only then.
- Tools that act for a customer are not offered when nobody vouched for the customer: the gateway would refuse them anyway.
- The prompt says the knowledge results are already for the latest message, so `search_knowledge` is called again only with other words.
- The classifier is not called for a ticket that opened with small talk.

### Caches

- **Query embeddings** (`LlmClientService.embed`): texts up to 600 characters are cached in Redis for 7 days, by embedding model and text. A repeated question, and every FAQ title after the first time, costs no embedding call. Documents being indexed are not cached.
- **Routing snapshot** (`LlmSettingsService.recentSnapshot`): every model call read the providers, models, roles and spend twice; calls now use a copy at most three seconds old. Settings pages still read it fresh.
- **LiteLLM's own response cache is not switched on.** It would need the LiteLLM container recreated on the owner's demo, and a cache in front of the scripted model would serve stale answers to the integration tests after a scripted change. The application caches above cover the calls that actually repeat.

### The queue

- Every job has a BullMQ priority: urgent tickets 1, high and approval follow-ups 2, normal 3, low 4, classification 5. When the queue is long, urgent customers are answered first.
- A message on a typed channel (web chat, WhatsApp, in-app) waits 1.2 seconds before its turn starts, so a burst of short messages is answered once.
- A busy conversation is retried for up to 45 seconds (30 attempts), so a message that arrives during a long turn is answered after it.

## Consequences

- A greeting, an FAQ question or a repeated opening question costs nothing. Everything else costs a little less.
- A cached or FAQ answer can be slightly off for a question that looks the same but means something else. The thresholds are conservative, specific messages are excluded, and each path can be switched off.
- Not done: ranking tools by similarity to the question, folding the classifier into the agent's turn (the priority rules of ADR 0032 use its intent and sentiment), and a semantic (near-duplicate) answer cache.
- A message that arrives while a turn is already running can still, rarely, be answered together with the earlier one rather than on its own.
