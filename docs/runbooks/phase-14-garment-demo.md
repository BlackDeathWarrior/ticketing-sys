# Phase 14 demo: TMS as the support desk of Ethnic Threads

Ethnic Threads (`garment-web-scraper`) is a real app: a storefront over a catalogue that a Python worker scrapes from Amazon, Flipkart and Myntra. This demo runs it next to TMS and shows TMS doing its support: shopper requests, chat, incidents the scraper reports about itself, approvals, SLA, webhooks and keys. Why it is built this way is in [ADR 0027](../adr/0027-garment-demo.md).

Nothing in it is simulated. Every scenario below happens through the app's real code.

## What you need

- Docker Desktop, Node 22 with pnpm (`pnpm install` done in this repository), Python 3.11 or newer.
- The app cloned next to this repository, on its integration branch:

  ```powershell
  git -C ..\garment-web-scraper checkout feat/support-desk-integration
  pip install -r ..\garment-web-scraper\scraper\requirements.txt
  ```

- For scenario 6 only (a real scrape): the scraper's browser, `python -m playwright install firefox`. Without it a scrape fails at once, which is itself an incident you can show.
- No AWS credentials on the machine. The app uploads its catalogue to a fixed production bucket whenever it finds credentials.

## Start it

Each command is `scripts\demo\garment-demo.ps1 <command>`, run from this repository.

| Step | Command                         | What it does                                                                                |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `up`                            | Builds and starts the demo stack: its own project (`tms-garment`), ports and database       |
| 2    | `load`                          | Sets TMS up for Ethnic Threads and writes the app's `.env` (keys and secrets go there only) |
| 3    | `worker` (its own terminal)     | The app's worker on :8765. It scrapes only when asked, one store, five listings             |
| 4    | `storefront` (its own terminal) | The app's site on http://localhost:5173                                                     |

Then open:

| What          | Where                      | Sign in                                                                                                       |
| ------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Orbit Desk    | http://localhost:8091      | `admin@example.com` (the seed password), or a staff account from `scripts/sample-data/garment/data.ts`        |
| Storefront    | http://localhost:5173      | Register as a shopper, or sign in as the admin with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from the app's `.env` |
| API docs      | http://localhost:3200/docs |                                                                                                               |
| Outgoing mail | http://localhost:8125      |                                                                                                               |

### The model

- **A real model (for a live demo):** after `load`, open Orbit Desk → Settings → Providers and add a provider, then under Models a chat model and an embedding model (1,024 dimensions, ADR 0010). Run `load` again: it loads the knowledge base, which needs the embedding model.
- **The scripted model (no key):** `load -Llm scripted`. It answers from the knowledge base and uses the app's tools for the phrases quoted below. The automated run uses it.

## The scenarios

Staff: Meera (team lead) and Arjun in Customer Care, Kavya in Catalogue, Dev in Site Reliability, Farah the supervisor.

### 1. The stale catalogue is noticed by itself

Nothing to do. The catalogue in the app's repository was last scraped in April 2026, and the worker checks its age when it starts.

- Orbit Desk: a ticket "Catalogue is … days old", tagged `incident`, team Site Reliability, assigned to Dev by the routing rule "Scraper incidents".
- Storefront, as the admin: the Support Desk panel lists it under open incidents.

### 2. A shopper writes in

1. Storefront: **Register**, then **Write to Us**. The form already has your name and email. Ask "Can I place an order and pay on Ethnic Threads?" and send.
2. You get a reference and **Follow this request**. The link carries a token: without it nobody else can read the request.
3. Orbit Desk: open the ticket. "Context from Ethnic Threads" says which form it came from. The AI has drafted an answer from the knowledge base ("Ethnic Threads is not a shop…"). A form request is not a live chat, so a person sends it: **Send draft**.
4. The shopper's page shows the reply within a few seconds, without a reload: TMS told the app by webhook.
5. Reply from the shopper's page; it arrives on the ticket.
6. Resolve the ticket. The shopper's page asks "How did we do?"; give five stars.
7. Storefront as the admin: the activity feed shows the message, the status changes and "Rated · 5 out of 5". The admin can read the request but cannot reply or rate as the shopper.

### 3. A listing report carries the listing

1. Storefront: open any product, **Report a problem with this listing**, choose "Wrong price", add a note, send.
2. Orbit Desk: the ticket's subject is "Wrong price: <title>", its category is Listings, and the context shows the listing's id, store, price and when it was scraped. The app's worker took those from its own catalogue; the browser sent only the id.

### 4. The chat answers from the knowledge base

Storefront: **Chat with us** (it has the site's colours, and no name form for a registered shopper). Ask "Is browsing Ethnic Threads free?". The AI answers by itself.

### 5. The chat checks the app's own systems

1. Open a product, then the chat. Ask "Is this one in stock, and what is the price?". The widget told TMS which listing is open, and the AI looks it up in the app's catalogue: title, price, stock and when it was last checked.
2. Ask "Why are the prices on the site so old?". The AI asks the app how fresh the catalogue is, then what the scraper is doing, and says so.
3. Orbit Desk: the ticket's "Company actions" lists the calls (Look up a listing, Catalogue freshness, Scraper status), and the context shows the listing.

### 6. A scrape fails, is counted on one ticket, and recovers

1. Stop the worker and start it so that every run fails: `worker -Sources notasource`.
2. Storefront as the admin: **Refresh All Inventory**, two or three times. Each run really exits with code 1.
3. Orbit Desk: one ticket "Scraper run failed (exit code 1)", "reported N times", with the scraper's last output. Not N tickets.
4. Recovery: stop the worker, start it normally (`worker`), and start a scrape. A run that finishes resolves the incident, and the ticket too if no person has touched it (being assigned by the routing rule does not count). Refreshing the catalogue also resolves "Catalogue is … days old".
   - This needs the scraper's browser and the store to answer. Without the browser the run fails with "Myntra scrape failed", a second real incident.
   - With boto3 installed and no AWS credentials, the upload after a scrape fails: "Catalogue upload to S3 failed" is a third.

### 7. The AI may ask for a scrape; a supervisor decides

1. Chat: "Please refresh the prices, they look out of date." The AI says it has asked the team.
2. Orbit Desk as Farah (or the admin): **Approvals** shows "Start a scrape" with the shopper's words. Agents cannot approve. **Approve**.
3. The app's worker starts a scrape (its status shows the reason `support-desk: …`), and the shopper is told in the chat.

### 8. A person is asked for, and nobody answers in time

1. Chat: "This is urgent: I want to talk to a real person about a wrong price, please."
2. The AI hands over and says a person will reply. The ticket is urgent, routed to a team, "Waiting for a person".
3. Wait two minutes without answering. The urgent policy's first-response target is two minutes, and the AI's "a person will reply" does not count as a response. The ticket shows as breached in **SLA at risk**, and its drawer shows the timer.

### 9. Webhooks: delivered, refused, retried

Orbit Desk → Settings → Integrations → Ethnic Threads → **Keys and webhooks**.

- **Send a test**: "The test was delivered"; the storefront admin's feed shows "Test delivery". **Deliveries** lists every delivery.
- **Receiver down:** stop the worker. Change a ticket of the app (move it to In Progress). The delivery shows as retrying, "Could not connect". Start the worker: the next attempt is delivered.
- **Wrong secret:** **Rotate secret**. The app still has the old one, so it refuses the next delivery with 401 and TMS retries. Give the app new settings with `load -Rekey`, restart the worker: the retry is delivered.

### 10. Keys: one job each, a rate, and off at once

```powershell
$settings = Get-Content ..\garment-web-scraper\.env
function Key($name) { ($settings | Where-Object { $_ -like "$name=*" }) -replace '^[^=]+=', '' }
function Try-Tickets($key) {
  try { (Invoke-WebRequest 'http://localhost:3200/api/v1/integration/tickets?limit=1' -Headers @{ Authorization = "Bearer $key" } -UseBasicParsing).StatusCode }
  catch { $_.Exception.Response.StatusCode.value__ }
}
Try-Tickets (Key 'SUPPORT_API_KEY_EVENTS')          # 403: the worker's key reports incidents, it cannot read tickets
1..7 | ForEach-Object { Try-Tickets (Key 'SUPPORT_DEMO_KEY_LIMITED') }   # 200 five times, then 429
```

Then revoke "Demo: five calls a minute" in Settings and run the last line again: 401, at once.

### 11. Who did what

Open any of these tickets in Orbit Desk: **History** in the drawer lists each change and who made it (the shopper, the AI, the routing rule, a person). Key and webhook changes are in the audit log too (`GET /api/v1/audit`, in the API docs).

## Start again

`reset` stops the stack, deletes its database, and puts the app's catalogue back as committed, so the stale catalogue is there to be noticed again. Then `up` and `load`.

`load -Rekey` alone gives the app new keys and secrets without losing tickets.

## The automated run

With the stack up, `load -Llm scripted` done, the storefront running and the worker started with `-Sources notasource`:

```powershell
$env:API_URL = 'http://localhost:3200'
$env:ORBIT_URL = 'http://localhost:8091'
$env:GARMENT_URL = 'http://localhost:5173'
$env:GARMENT_ENV = (Resolve-Path ..\garment-web-scraper\.env).Path
pnpm e2e:garment
```

It drives the real storefront and Orbit Desk through scenarios 1 to 5, the failing runs of 6, 7, 8 (it waits the two minutes), the test delivery and forged signature of 9, and 10. `SCREENSHOTS=1` also rewrites the images in `docs/testing/screenshots/garment-*.png`.

The app's own tests: `python -m pytest tests/support` and `npx vitest run src/__tests__/support.test.jsx` in its `frontend` folder.
