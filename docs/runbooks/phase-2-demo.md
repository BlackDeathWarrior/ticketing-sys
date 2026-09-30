# Phase 2 demo checklist

Prerequisites: `pnpm docker:up` (or local dev with `pnpm infra:up` + `pnpm dev`). URLs below are for Docker; for local dev use :5173 for the console and :5174 for the widget page.

## Web chat

1. Open the console at http://localhost:8080 and sign in. Stay on **Tickets**.
2. In another browser (or a private window), open http://localhost:8080/widget/demo.html and click **Chat with us**. Enter a name and email, then **Start chat**.
3. Send "My order 48213 says delivered but I have not received it."
4. The console's ticket list shows a new `webchat` ticket without refreshing. Open it.
5. Reply in **Reply by chat**. The visitor sees the reply within a second; the console shows it as "delivered". The ticket moves from `new` to `in_progress`.
6. Send a follow-up as the visitor; it appears on the ticket page live.
7. Reload the demo page and open the widget again: the history is still there (the session token is kept in the browser).

## Email

1. `pnpm demo:email -- --from arjun@example.com --name "Arjun Mehta" --subject "Refund for duplicate charge" --text "I was charged twice for order 48213."`
2. Within a few seconds a new `email` ticket appears. Open it: the conversation shows the customer's email.
3. Reply in **Reply by email**. After "delivered", open Mailpit at http://localhost:8025: the reply is from `support@tms.local` with subject `Re: Refund for duplicate charge [TMS-n]`.
4. Move the ticket to **Pending Customer**.
5. Answer as the customer. In Mailpit, open the reply's **Headers** tab and copy its Message-ID, then:
   `pnpm demo:email -- --from arjun@example.com --subject "Re: Refund for duplicate charge [TMS-n]" --in-reply-to "<message-id>" --text "Thanks, when will it show?"`
6. The answer joins the same conversation and the ticket returns to **In Progress**.
7. On a ticket created by an agent for a customer with an email, use **Email the customer** to start a new email thread.

## What to check in History

Each step is recorded with its actor: `ticket.created` and `message.received` by the customer, `message.sent` and `conversation.controller_changed` by the agent, and `message.delivered` by the system.
