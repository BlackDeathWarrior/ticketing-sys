# Phase 7 demo checklist: handover, routing, SLA and notifications

Prerequisites: `pnpm docker:up && pnpm sample:load`. The loader sets up:

- **SLA:** support hours Monday to Saturday, 08:00–20:00 India time, with two holidays, and four policies:
  - Urgent: 30 min first response, 4 h resolution, around the clock;
  - High: 1 h / 8 h, around the clock;
  - VIP: 2 h / 24 h, support hours;
  - Standard: 4 h / 48 h, support hours.
- **Routing:** five rules, including Hindi conversations to Orders (needs the "hindi" skill) and web chat to Orders by turns.
- **Skills and presence:** Jonah speaks Hindi. Jonah, Maya, Aiko and Sam are online; Nora is away; Leo is offline.

Sample tickets are backdated with their SLA timers, so about a dozen old open tickets are breached. The sweep marks them within 30 seconds.

## The queue

1. Sign in to Orbit Desk (http://localhost:8081) as `admin@example.com`.
2. **SLA at risk** in the sidebar lists late tickets. Each row shows its countdown under the status, e.g. "1h 35m over".
3. **Handled by** filters the queue:
   - AI handling (rows carry the AI mark);
   - Human handling;
   - Handed over;
   - In the queue.

## A handover

1. In the widget demo page (http://localhost:8080/widget/demo.html), write "Can I talk to a real person please?".
2. The AI hands over. Routing sends the ticket to an online Orders agent, taking turns. That agent's bell shows "TMS-… was handed to you".
3. Open the ticket. The drawer shows:
   - **Waiting for a person**, with Take over / Hand back to AI / Hand over / Escalate;
   - **SLA · Standard:** first response met (the AI's reply), resolution running;
   - **Handover context:** from the customer, why, where it was routed, a summary, the **next step**, and what was already done.
4. **Take over:** the bar says "You are replying", and the ticket is yours and In Progress.
   - A colleague trying to take over is told "<your name> is already answering this conversation".
   - The customer's next message gets no AI reply.
5. Reply. Switch the conversation to **AI | People**: the AI's messages sit on the left, yours on the right, with "A person took over" between them.
6. **Hand back to AI:** the AI answers anything the customer asked meanwhile.

The sample ticket from Nina Petrova (a damaged cargo bike) is already handed over, with its context pack.

## Other ways work moves

- **Hand over…:** pass a ticket to another team (or let routing decide) with a reason. It waits in that team's queue if nobody there is online.
- **Escalate…** (team leads): priority goes up one step and the team leads are notified.
- **Suggest a reply** in the composer: the copilot fills in a reply from the knowledge base to edit.
- **History** at the bottom of the drawer: filter by People, AI, System or Customer.

## Settings

- **Routing:** rules in order (Up/Down), each with conditions, team, strategy and skill. Agents are listed with status, capacity and skills; edit them in place.
- **SLA:** policies (who they apply to, targets, which hours they count in) and business hours (time zone, days, opening times, holidays).
- **Your status:** the Online/Away/Offline switch next to the bell. Only online agents get routed tickets.

## Notifications

- The bell shows unread notices: handovers, assignments, SLA at risk and breached, approval requests and escalations.
- Clicking one opens its ticket.
- SLA breaches and approval requests are also emailed. See Mailpit (http://localhost:8025), e.g. mail to `maya.lindqvist@tms.example`.
