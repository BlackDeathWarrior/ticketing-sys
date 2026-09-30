# Phase 1 demo checklist

Prerequisites: the stack from the README is running and seeded.

1. Open http://localhost:5173 and sign in as the seeded admin.
2. **Customers** → add "Arjun Mehta" with an email. Open him and add a WhatsApp identity such as `+91 98300 55555`.
3. Try adding the same WhatsApp number to the demo customer "Priya Sharma (demo)". You should see an error saying it belongs to another customer.
4. **New ticket** → pick Arjun, subject "Parcel not delivered", priority high, category Orders › Delivery issue, team Orders.
5. On the ticket, assign it to yourself. Status changes from `new` to `human_assigned` automatically.
6. Change status to In Progress, then Resolved with a resolution note. Then reopen it to In Progress. The resolved time is cleared.
7. Add an internal note.
8. Check **History** on the ticket: created, assigned, status changes, note, each with the actor.
9. API docs at http://localhost:3000/docs → `GET /api/v1/audit` returns the same entries.
10. `GET /api/v1/health/ready` shows the worker heartbeat. Check the worker log for `domain event` lines for each change.

RBAC check: create a user with role `agent` (`POST /api/v1/users`), sign in as them, and confirm the Assign section is hidden and `POST /tickets/:id/assign` returns 403.
