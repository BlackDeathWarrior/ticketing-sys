# Phase 5b demo checklist: the help-center request form

Prerequisites: `pnpm docker:up && pnpm sample:load`. The loader submits two fictional requests through the form: Lena Fischer (Returns) and Tomás Ribeiro (Account).

## A customer files a request

1. Open the help center at http://localhost:8080/help/.
   - It offers **Chat with us** (the same widget as the demo page) and **Submit a request**.
2. Submit with an empty subject or a bad email.
   - A message at the top says what to fix; each field shows its own message.
3. Fill in name, email (any `@example.org` address), topic, order number, subject and description, and attach a photo or a text file.
   - Up to 3 files, 10 MB each.
4. **Send request.** The page shows **Request received** with a reference such as `TMS-52`.
5. In Mailpit (http://localhost:8025) the acknowledgement arrives: `Re: <subject> [TMS-52]`, with the reference and "reply to this email".
6. At 390px wide (a phone) the page fits without sideways scrolling. The chat and tips cards come first.

## An agent answers it

1. In Orbit Desk (http://localhost:8081, `admin@example.com`), set the queue's **Channel** filter to **Web form**.
2. Open the ticket. The drawer shows:
   - channel **Web form** and the customer's chosen **Category**;
   - the request with its paragraphs, the order number, and the file as a chip. Click it to download;
   - the **System** acknowledgement;
   - an **AI draft** waiting for review, when a model is configured. Web-form tickets are drafts-only, like email.
3. Reply (or send the draft). The customer gets it by email with the ticket tag.

## The customer follows up

- Reply to the acknowledgement or the agent's email from the customer's mailbox. For example, send to `support@tms.local` through GreenMail on `localhost:3025` with the same subject.
- The reply lands on the same ticket and conversation, not a new ticket.

## Settings

- Settings → AI behaviour has a **Web form (replies by email)** mode: drafts by default, "answers on its own", or off.
