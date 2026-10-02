# Phase 14b demo: TMS as the support desk of a shop

Ethnic Threads (`garment-web-scraper`, branch `feat/shop`) is a small online shop: accounts, a cart, checkout, orders you can track, cancellations, returns and refunds. This demo runs it next to TMS and shows TMS doing its customer support: help with an order, a chat that knows the shopper and their orders, refunds that need a supervisor, incidents the shop reports about itself, SLA, webhooks and keys. Why it is built this way is in [ADR 0028](../adr/0028-shop-demo.md) (and [ADR 0027](../adr/0027-garment-demo.md) for how the app is connected).

**What is simulated and what is not.** The shop simulates its own business: no money is taken, nothing is shipped, orders move on a clock, and the admin has switches that make payments fail or the carrier run late. Everything between the shop and TMS is real: every ticket, incident, webhook, tool call and approval goes through the public integration API, as it would for a production app.

## What you need

- Docker Desktop, Node 22 with pnpm (`pnpm install` done in this repository), Python 3.10 or newer.
- The shop cloned next to this repository, on its shop branch:

  ```powershell
  git -C ..\garment-web-scraper checkout feat/shop
  pip install python-dotenv
  ```

  The shop's server uses only Python's standard library. No browser for scraping, no AWS credentials and no outside website are needed.

## Start it

Each command is `scripts\demo\garment-demo.ps1 <command>`, run from this repository.

| Step | Command                         | What it does                                                                                 |
| ---- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | `up`                            | Builds and starts the demo stack: its own project (`tms-garment`), ports and database        |
| 2    | `load`                          | Sets TMS up for Ethnic Threads and writes the shop's `.env` (keys and secrets go there only) |
| 3    | `shop` (its own terminal)       | The shop's server on :8765. `-StepSeconds 5` makes orders move every five seconds            |
| 4    | `storefront` (its own terminal) | The shop's site on http://localhost:5173                                                     |

`status` shows what is up. Then open:

| What          | Where                      | Sign in                                                                                                 |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
| Storefront    | http://localhost:5173      | Create an account as a shopper. The admin signs in with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` |
| Orbit Desk    | http://localhost:8091      | `admin@example.com` (the seed password), or a staff account from `scripts/sample-data/garment/data.ts`  |
| API docs      | http://localhost:3200/docs |                                                                                                         |
| Outgoing mail | http://localhost:8125      |                                                                                                         |

### The model

- **A real model (for a live demo):** after `load`, open Orbit Desk → Settings → Providers and add a provider, then under Models a chat model and an embedding model (1,024 dimensions, ADR 0010). Run `load` again: it loads the knowledge base, which needs the embedding model.
- **The scripted model (no key):** `load -Llm scripted`. It answers from the knowledge base and uses the shop's tools for the phrases quoted below. The automated run uses it.

## The scenarios

Staff: Meera (team lead) and Arjun in Customer Care, Kavya in Orders and Delivery, Nikhil in Payments, Dev in Operations, Farah the supervisor.

### 1. Shop like a customer

1. Storefront: open a product, pick a size, **Add to cart**, then the cart and **Proceed to checkout**. Checkout asks you to sign in: **Create an account**, and you are brought back.
2. Fill in the address, choose a delivery option and a way to pay, **Place order**. No card number is asked for: paying is simulated.
3. The order page shows five steps. Leave it open: the order is packed, shipped (a carrier and tracking number appear), out for delivery and delivered, one step every few seconds.
4. **Your orders** lists it. Place a second order and **Cancel order** before it ships: what was paid is refunded at once.

### 2. Help with an order

1. On a shipped order: **Get help with this order**, choose "Where is my order?", write a line, send. You get a reference.
2. Orbit Desk: the ticket's subject names the order, its category is Orders and delivery, and "Context from Ethnic Threads" shows the order's status, carrier, tracking number, items and total. The shop's server took those from its own records; the browser sent only the order number.
3. The AI has looked the order up with the shop's **Order status** tool and drafted "Order ET-… is shipped with SwiftShip; the tracking number is …". A form request is not a live chat, so a person sends it: **Send draft**.
4. Storefront: **Help** lists the request (no link or token needed, the shopper is signed in). It shows the answer within a few seconds, without a reload: TMS told the shop by webhook.
5. Reply from that page; it arrives on the ticket. Resolve the ticket; the page asks "How did we do?"; give five stars.
6. Storefront as the admin (**Operations**): the activity feed shows the message, the status changes and "Rated · 5 out of 5". The admin can read the request and cannot reply or rate as the shopper.

### 3. The chat knows who is asking

1. Signed in as the shopper, open an order and **Chat with us**. There is no name form: the shop vouched for you with a signed token.
2. Ask "Where is my order ET-…?" The AI answers from the shop's records.
3. Place another order and ask "Please cancel my order ET-…, I ordered it by mistake." The AI cancels it, the shop refunds it, and the order page shows Cancelled.
4. Orbit Desk: the chat ticket's **Company actions** lists both calls. The customer's email is not among the arguments: TMS filled it in, the model never chose it.

### 4. A visitor cannot read someone else's order

1. In a private window (not signed in), open the chat. It asks for a name and an email: type the shopper's email from scenario 3.
2. Ask "Where is my order ET-…?" with that shopper's order number.
3. The AI does not answer about the order. The lookup was refused ("The customer is not identified") because the shop has not said who this visitor is, and the chat is handed to a person. Orbit Desk shows the refused call on the ticket.

### 5. A refund needs a supervisor

1. On a delivered order, in the chat: "I want a refund for order ET-…, it arrived torn." The AI says it has sent the request for approval. Nothing is refunded yet.
2. Orbit Desk as Farah (or the admin): **Approvals** shows "Refund an order" with the shopper's words. Agents cannot approve. **Approve**.
3. The shop refunds the order (its page shows Refunded with a reference), and the shopper is told in the chat.

### 6. Payments fail

1. Storefront as the admin: **Operations**, switch on **Payments are failing**.
2. As a shopper, check out with UPI or card, two or three times: "you have not been charged". Cash on delivery still works.
3. Orbit Desk: one ticket "Payments are failing at checkout", urgent, tagged `incident`, team Operations, assigned to Dev by the routing rule "Shop incidents", "reported N times". Not N tickets.
4. With a real model, ask the chat "I can't pay, is something wrong?": the AI has a **Shop status** tool and can say that payments are failing and cash on delivery works. (The scripted model has no phrase for this one.)
5. Switch it off. The shop reports the recovery, and the ticket resolves itself if no person has touched it (being assigned by the routing rule does not count).

### 7. The carrier runs late

1. **Operations**: switch on **The carrier is delayed**, then place an order as a shopper.
2. The order is packed and shipped, then stops; its page says it is delayed with the carrier.
3. Orbit Desk: a ticket "Orders are delayed with the carrier". Asked in the chat, the AI says the order is delayed at the moment.
4. Switch it off: the order goes on to be delivered and the incident resolves.

### 8. A person is asked for, and nobody answers in time

1. Chat: "This is urgent: I want to talk to a real person about my payment, please."
2. The AI hands over and says a person will reply. The ticket is urgent, routed to a team, "Waiting for a person".
3. Wait two minutes without answering. The urgent policy's first-response target is two minutes, and the AI's "a person will reply" does not count as a response. The ticket shows as breached in **SLA at risk**, and its drawer shows the timer.

### 9. Webhooks: delivered, refused, retried

Orbit Desk → Settings → Integrations → Ethnic Threads → **Keys and webhooks**.

- **Send a test**: "The test was delivered"; the shop admin's feed shows "Test delivery". **Deliveries** lists every delivery.
- **Receiver down:** stop the shop's server. Change one of the shop's tickets (move it to In Progress). The delivery shows as retrying, "Could not connect". Start the server: the next attempt is delivered.
- **Wrong secret:** **Rotate secret**. The shop still has the old one, so it refuses the next delivery with 401 and TMS retries. Give the shop new settings with `load -Rekey`, restart its server: the retry is delivered.

### 10. Keys: one job each, a rate, and off at once

```powershell
$settings = Get-Content ..\garment-web-scraper\.env
function Key($name) { ($settings | Where-Object { $_ -like "$name=*" }) -replace '^[^=]+=', '' }
function Try-Tickets($key) {
  try { (Invoke-WebRequest 'http://localhost:3200/api/v1/integration/tickets?limit=1' -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing).StatusCode }
  catch { $_.Exception.Response.StatusCode.value__ }
}
Try-Tickets (Key 'SUPPORT_API_KEY_EVENTS')          # 403: this key reports incidents, it cannot read tickets
1..7 | ForEach-Object { Try-Tickets (Key 'SUPPORT_DEMO_KEY_LIMITED') }   # 200 five times, then 429
```

Then revoke "Demo: five calls a minute" in Settings and run the last line again: 401, at once.

### 11. Who did what

Open any of these tickets in Orbit Desk: **History** in the drawer lists each change and who made it (the shopper, the AI, the routing rule, a person). Key and webhook changes are in the audit log too (`GET /api/v1/audit`, in the API docs).

## Start again

`reset` stops the stack and deletes its database, the shop's database (accounts and orders) and the shop's record of webhook events. Stop the shop's server first, then `up`, `load`, and start it again.

`load -Rekey` alone gives the shop new keys and secrets without losing tickets.

## The automated run

With the stack up, `load -Llm scripted` done, the storefront running and the shop started with `-StepSeconds 5`:

```powershell
$env:API_URL = 'http://localhost:3200'
$env:ORBIT_URL = 'http://localhost:8091'
$env:GARMENT_URL = 'http://localhost:5173'
$env:GARMENT_ENV = (Resolve-Path ..\garment-web-scraper\.env).Path
pnpm e2e:garment
```

The shop allows 20 new accounts an hour from one address, and one run registers about that many shoppers: restart the shop's server before running it a second time within the hour (the limit is kept in memory).

It drives the real storefront and Orbit Desk through scenarios 1 to 8 (it waits the two minutes), the test delivery and a forged signature from 9, and 10. `SCREENSHOTS=1` also rewrites the images in `docs/testing/screenshots/shop-*.png`.

The shop's own tests: `python -m pytest tests/shop tests/support`, and `npx vitest run` in its `frontend` folder.
