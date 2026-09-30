# Phase 6 demo checklist: company tools and approvals

Prerequisites: `pnpm docker:up && pnpm sample:load`. The loader:

- registers **Demo Store systems**, the sample MCP server in `fake-providers` with fictional orders and payments;
- stores its placeholder token, syncs its four tools and switches them on (`issue_refund` needs approval);
- sends two chats that use them.

## Settings → Tools & MCP (admin@example.com)

1. The server card shows **On**, when it was synced, **4 tools**, and the token as `••••oken`. The token is write-only, like every key.
2. Each tool has three settings:
   - **AI may use it**;
   - **Risk**: read only, changes data, or needs approval;
   - **Customer email goes in**: the argument TMS fills from the ticket, which the model never sees.
3. **Test** runs a read tool once. For example Order status, with customer email `maria.lopez@example.com` and arguments `{"order_id": "DS-20517"}`. Needs-approval tools can't be tested here.
4. **Add an MCP server:** an internal address such as `http://169.254.169.254/` is refused.

## The AI looks something up

1. In the widget demo page (http://localhost:8080/widget/demo.html), start a chat with:
   - any name;
   - an email at `shopper.example` (a sandbox shopper), e.g. `ines.demo@shopper.example`.
2. Ask "Where is my order DS-91234?".
   - The AI answers that it is delivered, with its tracking number.
   - Any `DS-9xxxx` number works for a sandbox shopper.
3. In Orbit Desk, open the ticket. The drawer shows:
   - the reply "from Demo Store systems · Order status";
   - **Company actions** with Order status → Done, and the order id but not the email.
4. Sample ticket "Chat: Hi, where is my order DS-20517?" shows the same for María López.

## A refund waits for approval

1. In a new chat as a sandbox shopper, write "I was charged twice for order DS-91234. Can you refund the extra charge?".
   - The visitor is told the request is with the team.
   - Nothing is refunded yet.
2. Sign in as `priya.natarajan@tms.example` (supervisor, password `Sample-Passw0rd!`). **Approvals** in the sidebar shows a count.
3. The card shows:
   - the customer, order and reason;
   - the customer's own words;
   - the expiry (24 hours by default).
4. Add a note if you like and **Approve**.
   - The worker issues the refund in Demo Store systems.
   - The visitor gets "Good news: your refund of 49.00 EUR … has been issued (reference RF-…)".
5. **Decided** lists it with who approved it and the result.
6. The sample ticket from Kenji Watanabe (DS-20533) is already waiting in the inbox. Agents can approve it from the ticket drawer too, if they have `approval:approve`.

## Other outcomes

- **Reject:** the customer is told it wasn't approved. The internal note is never quoted.
- **Expiry:** after `APPROVAL_TTL_MINUTES`, the request expires and the AI hands the conversation to a person.
- **Person in charge:** if a person has taken the conversation over, the AI adds an internal note ("please let the customer know") instead of messaging the customer.
- **Other customers' orders:** asking about someone else's order (e.g. DS-10421 from another address) gets "not found". The AI hands over.

## Quality checks

- `pnpm ai:eval` includes `apps/api/test/evals/tools.yaml`: order status, another customer's order, and a refund that must not be promised.
- To start the sample store's refunds over: `curl -X POST http://localhost:4010/demo-store/reset`.
