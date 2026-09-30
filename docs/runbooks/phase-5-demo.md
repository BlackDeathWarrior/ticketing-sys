# Phase 5 demo checklist: the AI agent

Prerequisites: `pnpm docker:up && pnpm sample:load`.

- The loader registers the scripted **Demo model**, indexes the knowledge base, and sends six web chats and three emails.
- The AI answers them as they arrive. Some are sent, some drafted, and one hands over because the visitor asks for a person.
- To use a real model, add a provider and model in Settings (Phase 3). The router then prefers the cheapest capable model.

## Web chat answered by the AI

1. Open the widget demo page (http://localhost:8080/widget/demo.html), start a chat and ask "When will my refund reach my card?".
   - Within a few seconds a reply arrives, labelled **AI assistant**.
2. In Orbit Desk (http://localhost:8081, `admin@example.com`), open the new ticket:
   - the header shows **AI is replying**, and the status is Pending Customer (the answer settled the question);
   - the AI message has the **AI** mark, is slightly dimmed, and shows its confidence and knowledge source;
   - a **Classified** line shows the suggested category, intent and language;
   - **AI activity** lists each step: search, sources, model, prompt version.
3. Reply again as the visitor. The ticket goes back to AI Handling and the AI answers.

## Drafts

1. Ask the widget something the knowledge base barely covers, such as "What do penguins eat in winter?".
   - The visitor gets nothing yet.
2. In the drawer, the AI's answer shows as **Draft, not sent yet** with **Send draft**, **Edit** and **Discard**.
3. Edit it and **Send edited reply**: the visitor receives your text. The audit shows `message.draft_approved` with `edited: true`.
4. Every email gets a draft instead of an automatic reply. Open "Invoice address for company purchase" from the sample data and send its draft; the reply appears in Mailpit.

## Handover

1. In the widget, write "Can I talk to a real person please?".
2. The visitor is told a member of the team will reply.
3. The ticket moves to Human Assigned, **AI is replying** disappears, and an AI note explains why ("The customer asked for a person"), quoting the last message.
4. Reply as an agent: the conversation is yours and the AI stays quiet.

## Settings → AI behaviour

- Each channel's mode can be "answers on its own", "drafts only" or "off". Set web chat to off and new chats go straight to the queue.
- The thresholds (send at 80%, hand over below 60%) and "hand over after 3 unsure replies" can be changed here.
- **Try the agent** runs a dry run on any message and shows the decision, confidence, rules and sources. Nothing is sent.

## Quality checks

- `pnpm ai:eval` runs the golden conversations in `apps/api/test/evals/agent.yaml` against the configured models.
- With the demo model all six pass. With a real model it shows how answers hold up, including the prompt-injection case.
