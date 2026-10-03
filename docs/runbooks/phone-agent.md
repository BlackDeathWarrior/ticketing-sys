# Phone calls: setting up the phone agent at Sarvam

Phone calls on a number rented from Sarvam are answered by a Sarvam Voice Agent (ADR 0039). The agent thinks and speaks by itself; it gets its facts from this desk through four tools, and the call becomes a "Voice call" ticket when it ends.

Do part 1 in Orbit Desk, part 2 in Sarvam's dashboard, then try it (part 3).

## Part 1: Orbit Desk

1. **Settings → Channels → Phone calls.** Fill in the rented number (with `+` and the country code) and the ids from Sarvam: org, workspace, agent (app) id and version, connection id. They are in the dashboard's address bar and under its Settings. Switch **Phone calls on** to Yes and **Save settings**.
2. Under **Voice Agents API key**, save the key from Sarvam's **Settings → API Key**.
3. Next to **Hook token** click **Generate**, copy the value, then **Save**. It is shown only now; if you lose it, generate a new one and change it at Sarvam too.
4. **Test connection.** Expected: "Sarvam lists N deployment(s)".
5. Keep the three addresses shown under the keys at hand for part 2.

Leave **Outbound calls only 09:00–21:00 IST** on No for the demo. It applies to outbound calls, which arrive with the next stage; switch it on after the demo.

## Part 2: Sarvam's dashboard

### The agent's instruction

Paste this as the agent's instruction. Change it here first, then at Sarvam, so the two stay the same.

```
You are the phone assistant of {{company}}. You speak with customers who call.

Start: greet the caller, by name if {{customer_name}} is not empty, and say once that the call is transcribed so the team can help.

You know nothing about {{company}} by yourself. Never answer from memory.
- For policies, delivery, returns, sizes and anything "how does it work": call search_knowledge with the caller's question, and answer only from what it returns.
- For products, orders, the cart, payments and anything about this caller's account: call desk_tool.

desk_tool runs one of the company's tools. Give it "name" (the tool's name) and "arguments" (a JSON object as text, for example {"query":"red kurta"}). The tools you may use, with what each needs:
{{desk_tools}}
If that list is empty, call list_tools first.

Rules:
- If a tool answers that the caller's number is not linked, tell them they can add and confirm this number under their account on the shop's website, and that until then you can help with products and general questions.
- If a tool's answer starts with an error, do what it says: fix the arguments and try once more, or tell the caller you could not do it.
- Never read out a web address, an id made of random letters, or a JSON. Say where on the shop's website to find the thing.
- Prices, dates and order numbers: say exactly what the tool returned. Never guess one.
- If you cannot help, or the caller asks for a person a second time, call request_person with a one-sentence reason, tell the caller a colleague will get back to them, and end the call politely.
- Answer in the caller's language, in one or two short sentences. Ask one question at a time.
```

### Variables

Create four agent variables: `customer_name`, `known`, `company`, `desk_tools`.

### On-start hook

- Method `POST`, address: the **On-start hook** address from Orbit Desk (`…/api/v1/phone/sarvam/start`).
- Auth: Bearer token, the hook token.
- Body (JSON): `{"interactionId": <Interaction ID>, "phone": <User Identifier>}`. Pick both from the `@` menu.
- Map the reply's `customer_name`, `known`, `company` and `desk_tools` to the variables of the same name.

### The four tools

Each is an **API tool**: method `POST`, Bearer token (the hook token), timeout 30 seconds, address `…/api/v1/phone/sarvam/tools/<name>`. In every body, `interactionId` is the Interaction ID and `phone` is the User Identifier (from the `@` menu). The reply has `ok` and `result`: give the agent `result`.

| Tool name          | Body fields the agent fills       | Description to give the agent                                                                     |
| ------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `desk_tool`        | `name` (text), `arguments` (text) | Runs one of the company's tools. `name` is the tool's name; `arguments` is a JSON object as text. |
| `list_tools`       | none                              | Lists the company's tools with what each needs.                                                   |
| `search_knowledge` | `query` (text)                    | Looks up the company's policies and help articles.                                                |
| `request_person`   | `reason` (text)                   | Asks for a colleague to get back to the caller.                                                   |

A tool added later in Orbit Desk (**Settings → Tools and MCP**) needs nothing here: it appears in `{{desk_tools}}` on the next call.

### Number and webhook

1. **Deploy → Inbounds:** create an Inbound deployment that links the rented number to this agent.
2. Set the deployment's webhook to the **Webhook (call ended)** address (`…/api/v1/phone/sarvam/ended`).

## Part 3: try it

Dial the number from a phone whose number is confirmed on a shop account.

1. **A policy question** ("what is your returns policy?"): the answer matches the knowledge base.
2. **A product question** ("show me red kurtas under two thousand"): names and prices are real ones from the shop.
3. **Your orders** ("where is my last order?"): your own order is read out.
4. **From a number that is not linked:** order questions get the "add and confirm this number" answer; product and policy questions still work.
5. **Ask for a person twice:** you are told a colleague will get back to you.
6. Hang up. Within a minute or two a ticket appears in Orbit Desk on the "Voice call" channel with the transcript; after case 5 it is routed to a person, otherwise it is resolved ("Closed by the AI: the phone call ended with nothing left to do").

Not on a phone call yet: actions that need an approval (a refund). The agent offers a call back instead. They arrive with outbound calls.

### If something is wrong

- **The agent says it cannot reach its tools:** the Voice light's "Phone: calls from the phone agent" check. "Hook token not saved" or a 401 in the API log means the token at Sarvam is not the one saved here.
- **No ticket after the call:** Settings → System → failed jobs, queue "Phone calls". "Unexpected transcript shape: …" lists the fields Sarvam's transcript had: send that line to the developer, the reader needs that shape added. "Sarvam has no transcript" after every retry means the ids in the Phone calls card are not this agent's.
- **The agent answers from memory or invents a price:** tighten the instruction above, here and at Sarvam.

### Still to find out on the first real call

1. Whether Sarvam's webhook can send a header (then the "ended" address gets the token too).
2. Whether the on-start hook can send the Bearer token. If not, the agent still works: its first tool call opens the call, and `{{desk_tools}}` is filled by `list_tools`.
3. Whether the Voice Agents API key is the same as the speech key of the "Sarvam voice" card.
4. The price per minute (Sarvam's dashboard, not its public pricing page).
5. Whether `{{desk_tools}}` fits in an agent variable, and whether the agent writes `arguments` as valid JSON.
6. The address Sarvam calls from. If it is `4.213.167.70`, set `PHONE_SARVAM_IPS` to it so nothing else is let in.
