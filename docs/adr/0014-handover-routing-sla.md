# ADR 0014: Handover, routing, SLA, notifications and AI-vs-human visibility

Status: accepted (2026-09-30)

## Context

Phase 5 let the AI hand over (ADR 0011), but nothing happened next: no routing, no summary for the person picking it up, no explicit take-over, and no SLA clock (`tickets.sla_policy_id` was unused). Agents found out about work only by watching the queue.

The agreed scope covered four things:

- take-over and hand-back with the AI muted;
- context packs;
- rule-based routing with skills, presence and capacity;
- SLA with business hours and a pause while waiting on the customer.

It also included notifications and every AI-vs-human view: badges, a separate lane, filters, and audit columns.

## Decision

**Who is answering**

- `conversations.controller` (none, ai, human) already decided whether the AI answers. The ticket now also carries `handling`:
  - `none`, `ai` or `human`, matching the controller;
  - `handed_over`: the AI or an agent passed it on and nobody has picked it up.
- It is written in the same transaction as the change that causes it:
  - the AI taking a new conversation;
  - a person replying or taking over;
  - an AI or agent handover;
  - a hand-back.
- It powers the queue filter (`?handling=`) and later reports.
- `POST /conversations/:id/take-over`:
  - locks the conversation row;
  - refuses with a 409 naming whoever already has it;
  - makes the caller the controller and the assignee;
  - moves the ticket to In Progress, stepping through Human Assigned when there is no direct transition.
- **The AI is muted twice:**
  - a turn skips conversations it doesn't control;
  - the turn's final transaction re-locks the conversation and records a `skipped` run if someone took over while the model was thinking.
- `POST /conversations/:id/hand-back` returns control to the AI, only where the AI is on and has a model. It answers any customer message left waiting.
- `POST /tickets/:id/handover` passes a ticket on, to routing or a named team.
- `POST /tickets/:id/escalate` (team leads) raises priority one step and tells the leads.

**Handovers and context packs**

- Every handover (AI, customer asked for a person, or agent) writes a `handovers` row and a `handover.requested` event in the same transaction.
- The worker then:
  1. routes the ticket;
  2. notifies the people it went to;
  3. writes the context pack.
- **Context pack:** facts gathered from the ticket, the transcript, AI runs and tool calls, plus a summary, intent and next step from the `summarizer` role (prompt `handover-v1`).
  - When no model answers, a template writes it from rules and the handover reason (`writtenBy: rules`).
  - Orbit Desk shows it at the top of the drawer.

**Routing**

- Ordered `routing_rules` match on:
  - channel;
  - priority;
  - category;
  - language (the conversation's detected language, or the classifier's);
  - customer type.
- The first enabled match gives a team, a strategy and an optional required skill:
  - `least_loaded`: the fewest open tickets, ties to whoever waited longest;
  - `round_robin`: whoever was routed to longest ago;
  - `team_queue`: team only, no agent picked.
- **Eligible agents** are team members who are **online** (`agent_presence`, set by the agent in Orbit Desk or by an admin), below their **capacity** (open or pending assigned tickets), and hold the skill.
- A ticket that already has an assignee keeps them.
- **What gets routed:**
  - handovers;
  - new tickets customers open through a channel when the AI isn't answering.
  - Agent-created tickets are left to the agent.
- Every decision is audited (`ticket.routed`) with the rule and the reason.

**SLA**

- **Policies** give first-response and resolution targets in business minutes. The most specific enabled policy wins: priority and customer type, then either one, then neither.
- **Business hours:** weekly windows in a time zone, plus holidays.
  - A pure `business-time` module adds and counts business minutes. It is DST-safe, because each local window is converted to UTC through the zone's own offset.
- **Timers** (`sla_timers`, one per ticket and kind) are reconciled from the ticket's facts on every relevant event. `SlaService.reconcile` is idempotent:
  - **first response:** met by the first AI or human reply;
  - **resolution:** paused in pending statuses, resumed on reopen, met on resolve;
  - **policy change:** a new policy (e.g. a priority change) moves the deadline, keeping the business minutes already used.
- **Sweep:** a repeating BullMQ job (`SLA_SWEEP_SECONDS`, default 30) marks timers at risk at 80% and breached at 100%, then emits `sla.at_risk` and `sla.breached`.
  - This replaces one delayed job per timer. It survives restarts, moved deadlines and backdated data.
- The ticket keeps a summary (`sla_state`, `sla_due_at`) for the queue: the most urgent thing still actionable.

**Notifications**

- `notifications` rows per user, deduplicated by a key per event.
- Pushed live to the `user:<id>` socket room, and shown under the Orbit Desk bell.
- **Who gets what:**
  - handover: the routed agent, or the team;
  - assignment: the assignee;
  - SLA at risk and breached: the assignee and the team leads;
  - approval requests: approvers;
  - escalation: team leads.
- SLA breaches and approval requests are also emailed (SMTP, the email channel's settings).
- Marking your own notifications read is not audited. It is personal UI state, like a collapsed panel; creating a notification is audited.

**Copilot**

- `POST /tickets/:id/copilot` drafts a reply from the conversation and the customer-safe knowledge base (the `copilot` role, prompt `copilot-v1`).
- It stores nothing: the agent edits and sends it as their own audited reply.

**AI-vs-human visibility**

- **Queue:** a "Handled by" filter, an AI mark or "Handed over" on each row, and an SLA countdown under the status.
- **Drawer:**
  - who is answering, with Take over / Hand back / Hand over / Escalate;
  - the SLA timers and the handover context;
  - an **AI | People lane view** of the conversation, marking where the replying side switches;
  - a History list filterable by actor type.
- **API:** `GET /audit` and ticket history take `actorType`.

## Consequences

- Handover is now a pipeline (route → notify → pack) rather than a status change. A crashed worker retries it: routing keeps an existing assignee, and notices are deduplicated.
- Presence is explicit: an agent who forgets to go online gets nothing routed. Automatic presence from socket connections is left for later, because a closed laptop tab shouldn't reroute work mid-shift.
- The SLA is only as live as the sweep interval (30 seconds by default), which is plenty for minute-level targets.
- The ticket-level `handling` and SLA summary are denormalised for fast queues; they are always written with, or reconciled from, their sources.
