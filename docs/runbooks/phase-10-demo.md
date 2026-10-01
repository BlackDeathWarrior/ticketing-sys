# Phase 10 demo checklist: reports, ratings, the customer portal, admin pages

Prerequisites: `pnpm docker:up && pnpm sample:load`. Orbit Desk is at http://localhost:8081 (`admin@example.com` / `ChangeMe123!`), the help center at http://localhost:8080/help/, and outgoing mail lands in Mailpit at http://localhost:8025.

## Reports

1. Sign in to Orbit Desk and open **Reports**.
2. The four figures at the top: what the AI resolved alone, what it passed to a person, the time-saved estimate and the customer rating. The sample data has 3 chats the AI resolved and 12 ratings.
3. **Resolved per day** stacks the AI and people; hover a day, or click **View table**.
4. **Side by side** compares the AI and people on first reply, time to final answer, SLA and ratings.
5. Set **Channel** to Web chat: every figure and the ticket list follow.
6. Under **Tickets**, choose "AI" in **Handled by**, click a ticket to open it, then **Export CSV**.
7. Sign in as `jonah.reyes@tms.example` (`Sample-Passw0rd!`): agents have no Reports link.

## The AI resolves what it answered

1. **Settings → AI behaviour**: "Resolve the ticket when the customer has not replied for" is 72 hours. 0 switches it off.
2. In the sample data, TMS-44, TMS-45 and TMS-47 were answered by the AI and left alone; their history shows "AI agent" moving them to Resolved.

## The customer portal

1. Open http://localhost:8080/help/ and submit a request with any `@example.org` address.
2. Click **My requests**, enter that address, and click **Email me a link**.
3. Open Mailpit, open "Your sign-in link", and click the link. You see your request.
4. Open it and send a reply. In Orbit Desk the message is marked "From the portal".
5. Answer as the agent and resolve the ticket. Reload the portal: the answer is there, the status is "Solved".
6. Rate it. The ticket in Orbit Desk shows **Customer rating** without a refresh.
7. Open the sign-in link again: it says it was already used.

## Ratings

1. Resolving the ticket also sent "How did we do?" to Mailpit. Its link opens a page that rates that one request, without signing in.
2. On http://localhost:8080/widget/demo.html, start a chat, then resolve its ticket in Orbit Desk: the chat window asks for a rating.
3. Rate a ticket 1 or 2: its assignee and the team's leads get a notification.

## Admin pages

1. **Settings → People**: add a user, change their role, switch them off. Add a team, pick its members, delete it. Deleting "Orders" is refused: it has open tickets.
2. **Settings → Tickets**: add a category and switch it off; it disappears from the request form. Add a status, tick its moves under **Allowed moves**, and **Save workflow**.
3. **Settings → Customers**: switch the portal or the rating questions off, and set the minutes behind the time-saved estimate.
