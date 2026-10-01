# ADR 0019: AI-versus-team reports, ratings, the customer portal, and admin pages

Status: accepted (2026-10-01)

## Context

Phase 10 of the plan: show what the AI does next to what people do, collect customer ratings, give customers a place to see their own tickets, and put the admin endpoints behind screens.

## Decision

**Who handled a ticket**

One definition, used by reports, the ticket list, the CSV and ratings:

- `ai`: the AI is (or was, when it was resolved) the one answering;
- `ai_then_human`: the AI took at least one turn, and a person has the ticket now;
- `human`: the AI never took a turn. Classifying a ticket doesn't count as a turn.

**The AI resolves what it answered** (added in this phase)

- Until now the AI answered and left the ticket "pending customer" for ever, so "resolved by the AI" was always zero.
- A ticket the AI answered, still owns, and the customer has not replied to for `autoResolveHours` (default 72, Settings → AI behaviour, 0 = never) is resolved with the AI as the actor. The worker checks every 10 minutes (`AI_AUTO_RESOLVE_SWEEP_SECONDS`); `POST /ai/auto-resolve` runs it now.
- A later reply reopens the ticket, as for any resolved ticket. Once a person has taken over, the AI never closes it.

**Reports** (`GET /reports/performance`, `/reports/tickets`, `/reports/tickets.csv`)

- Computed on request from live tables (ADR 0006). Filters: a period in UTC days, channel, team.
- AI resolution rate = resolved tickets with `ai` / all resolved. Deflection and handover rates are shares of the tickets the AI worked on.
- First reply: the ticket's first-response time, split by who wrote the first reply.
- "Time to final answer": from opened to the last reply before the ticket was resolved. Waiting for the customer to confirm doesn't count, which is what makes the AI and people comparable.
- Time saved is an estimate and says so: tickets the AI resolved alone × a number of minutes an admin sets (default 10). We don't measure how long agents work on a ticket.
- AI cost is the sum of `llm_calls` for the period.
- The CSV needs `report:export` (team leads and up), is audited (`report.exported`), and defuses cells a spreadsheet would run as a formula.

**Ratings (CSAT)**

- One rating per ticket, 1 to 5, with an optional comment; 4 and 5 count as happy. A rating can be given or changed for 30 days after the ticket is resolved.
- Only the customer can rate: in the chat window, through the link in a survey email, or in the portal. There is no staff route to set a rating, and the survey link is never stored on the ticket, so an agent can't open it.
- The worker asks once per ticket when it is resolved: in the chat for chat tickets, by email for email and request-form tickets. WhatsApp and voice tickets are not asked (rating is still possible in the portal).
- The rating records who handled the ticket at that moment, so last month's report doesn't change when a ticket is reassigned.
- A rating of 1 or 2 notifies the assignee and the team's leads.

**Customer portal** (help center → My requests)

- Sign-in: the customer enters their email; if we know it, we email a link that works once for 15 minutes. The answer is the same for unknown addresses. Five links per address per 15 minutes.
- The link's secret is an HMAC of the login row's id (`common/signed-token.ts`); nothing secret is stored. Survey links are made the same way, for a different purpose, so one can't be used as the other.
- The session is a 60-minute token with its own audience, kept in the browser tab's session storage. Staff tokens are refused by the portal and portal tokens by the staff API.
- Every portal route takes the customer from the session and checks ownership; someone else's ticket answers 404, the same as a ticket that doesn't exist. Internal notes, drafts and agents' surnames never leave.
- A reply goes through `InboundService` as a customer message on the ticket's email thread (one is started if the ticket has none). So the answer reaches the customer by email and shows in the portal, on every channel. Closed tickets can't be answered.
- System mail (sign-in links, surveys, staff notifications) goes through one `SystemMailer`, from the worker.

**Admin pages** (Settings → People, Tickets, Customers)

- Users and teams; categories; statuses and the allowed moves between them; portal and rating switches.
- New endpoints: `PATCH`/`DELETE /teams/:id`, `PATCH /categories/:id`. A team with open tickets or routing rules can't be deleted. A switched-off category stays on old tickets and is no longer offered to customers, agents or the AI.

## Consequences

- Reports are live queries; a very large period reads many rows. Fact tables remain the next step if that gets slow (ADR 0006).
- Tickets the AI resolved by silence count as resolved on the day the waiting time ran out, not the day of the answer.
- An agent who resolves a ticket the AI was still answering leaves it counted as resolved by the AI.
- Sign-in links are limited per address, not per network address; the general rate limiting comes in Phase 11.
- The retention settings page from the plan moves to Phase 11, with the retention jobs it controls.
