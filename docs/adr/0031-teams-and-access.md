# ADR 0031: Teams own their tickets; team admins; approvals by the deciding team

Status: accepted (2026-10-03). Amends ADR 0013 (approvals) and ADR 0014 (routing).

## Context

Every agent could open, answer, change and take over every ticket, whatever its team. A payment problem could be worked by any team, and refunds were approved by anyone holding the global `approval:approve` (supervisors and admins), whatever team the request concerned. Teams had members but no admins, roles could not be changed beyond one permission, and tickets the AI answered never got a team at all (routing only ran on tickets that needed a person).

The owner wanted team management with several admins per team and a super admin, refunds decided by the Payments team, and payment issues kept away from unrelated teams. Asked how strict, they chose: other teams may **read** a ticket, but only its team acts on it.

## Decision

### Who may act on a ticket

- A ticket that belongs to a team is acted on by that team's members and by anyone with `ticket:any_team` (super admins). A ticket with no team is shared triage that anyone may work. Everyone with `ticket:read` still sees every ticket and may add internal notes.
- One check, `canActOnTeam` (`packages/shared/src/auth.ts`), applied by `@ActsOnTicket()` (`apps/api/src/tickets/ticket-access.ts`) on every route that changes a ticket or speaks for the team: update, transition, assign, start a conversation, reply, send a template, approve or discard a draft, take over, hand back, hand over. A refusal is a 403 with `code: 'other_team'` and the team's name. Escalating stays open to all: it only raises an alarm.
- `CurrentUser.teams` (id and role per team) comes with the auth context, so the check costs no query.
- Orbit Desk shows a banner on another team's ticket and offers only the note composer there.

### Tickets the AI answers get a team

`RoutingService.assignTeam` gives a ticket the team of the first routing rule it matches, without an assignee or a status change. `RoutingHandler` calls it for AI-handled tickets on `ticket.created`, `ticket.classified` and `ticket.updated`, so a ticket gets its team as soon as it has a category. A catch-all rule (no conditions) only applies once the ticket has a category.

### Teams and roles

- `team_members.role` is `member` or `admin`; a team can have several admins. A team's admins change who is on it and who else is its admin (`PATCH /teams/:id` with `memberIds` and `adminIds`); renaming, adding and deleting teams needs `team:manage`. Member changes keep the roles of those who stay.
- The `admin` role is shown as **Super admin**: every permission, every team.
- `DELEGABLE_PERMISSIONS` grew from `tool:create` to sixteen (approve on any team, assign, escalate, act on other teams, manage the knowledge base, reports, lessons, merge customers, audit trail, recordings, priority, routing, SLA and category settings). Settings → People shows a roles table: a role's built-in permissions are ticked and fixed (they are re-synced from code on every deploy), the rest can be granted and taken back. Keys, people, teams, integrations, models and the system stay with super admins.
- The last active super admin cannot be demoted or switched off, and nobody can remove their own super admin role.
- Settings → Teams, visible to everyone, lists each team with its members and admins; Settings → People keeps users and roles. `GET /users/directory` gives team admins the names to choose from.

### Approvals by the deciding team

- `tools.approver_team_id` names the team that decides a tool's requests (in the demo: refunds → Payments). Without one, the ticket's team decides; with neither, holders of `approval:approve`.
- The team is stored on the request (`approvals.team_id`) when it is made. Any member of that team, or a super admin, decides it (`canDecideApproval`), always with a reason (ADR 0013). The inbox lists only the requests the person may decide, and the `approval.requested` notification goes to that team's members.
- The AI is told to use the tool that requests money back, not to send the customer to a person for it.

### Payment problems in the demo shop

A failed payment creates no order, so there was nothing to refund and nothing for support to look up. The shop now records a failed checkout (method and amount only, never a payment detail), offers "Get help with this payment" from the failed checkout (a Payments request marked `payment = failed`), and gives the AI a `payment_status` read tool. The AI can then say truthfully that nothing was charged, cancel an unshipped order (which refunds at once), or request a refund of a delivered paid order for Payments to decide.

## Consequences

- A team with nobody online can hold tickets that nobody else may answer. Super admins, `ticket:any_team` and the triage of team-less tickets are the way round it.
- Custom roles (created, renamed, deleted) are not built; built-in roles keep their built-in permissions.
- The sidebar's team list is still a list, not a set of queue filters.
- Team admins and an approving team are set by hand in Settings → Teams and Settings → Tools; the sample data loader does not set them.
