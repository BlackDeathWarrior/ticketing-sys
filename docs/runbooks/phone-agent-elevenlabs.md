# Phone calls: the phone agent at ElevenLabs

Phone calls can be answered by an ElevenLabs agent as well as by Sarvam's (ADR 0040). Unlike Sarvam's, this agent is set up by the desk: you give it a key and a voice, and the desk creates the agent, its instruction, its tools and its webhooks at ElevenLabs.

## Part 1: what you need at ElevenLabs

1. An ElevenLabs account, and an **API key** that may use Agents.
2. A **voice**: open Voices, pick one, copy its Voice ID.
3. Later, a **phone number** connected under Agents → Phone numbers (Twilio, Exotel or a SIP trunk). The number rented from Sarvam cannot be used here. Until a number exists, the agent can be tried with a test call from ElevenLabs' dashboard.

## Part 2: Orbit Desk

1. **Settings → Channels → Phone calls: ElevenLabs.** Fill in the voice ID, keep or change the language model, set the first language (`en`, `hi`, …) and any others the agent may switch to. Leave the number empty for now. **Save settings.**
2. Under **API key**, save the key.
3. **Test connection.** Expected: "ElevenLabs lists N agent(s)".
4. **Set up.** After a few seconds press **Refresh**. Expected: "In step with this desk: N tools". The agent now exists at ElevenLabs, named "… phone assistant (Orbit Desk, …)".
5. When a number is connected at ElevenLabs: **Load numbers**, copy the id of the number into **Number**, save, and **Sync now**. The desk assigns the agent to that number.

A tool added, changed or switched off under **Settings → Tools and MCP** reaches the agent by itself within about a minute. So does a change to this card or to the company name.

Do not edit the agent's instruction or tools in ElevenLabs' dashboard: the next sync writes the desk's version over them. The instruction is in `apps/api/src/channels/phone/phone-agent-instruction.ts`.

## Part 3: try it

From ElevenLabs' dashboard, start a test call with the agent (it has no caller number), or dial the connected number from a phone whose number is confirmed on a shop account.

1. **A policy question:** the answer matches the knowledge base.
2. **A product question:** names and prices are real ones from the shop.
3. **Your orders:** from a confirmed number, your own order is read out. On a test call, or from a number that is not linked, you get the "add and confirm this number" answer.
4. **Ask for the details on WhatsApp** (confirmed number only, after writing to the shop's WhatsApp in the last 24 hours): the message arrives.
5. **Ask for a person twice:** you are told a colleague will get back to you.
6. End the call. Within a minute or two a ticket appears on the "Voice call" channel with the transcript and the recording; after case 5 it is routed to a person, otherwise it is resolved.

Actions that need an approval: the agent passes the request on and says a colleague must approve it. When a colleague decides, the phone agent rings the caller back with the outcome. That needs a number: a test call cannot be rung back.

### Calls the desk places

With a number connected (through Twilio or a SIP trunk) and ElevenLabs chosen on the card **Phone calls: general**, **Call customer** in a ticket's Voice call panel has this agent ring the customer. A number that reaches ElevenLabs through Exotel cannot place calls yet.

## If something is wrong

- **"The last run failed: …"** on the card: the text after the colon is ElevenLabs' own message. A wrong voice ID or model name is the usual cause; correct it, save, and the sync runs again.
- **"Not offered to the agent: …"**: ElevenLabs refused that one tool (its message follows). The other tools are in step.
- **The agent says it cannot reach its tools:** the Voice light's "ElevenLabs: calls from the agent" check. A 401 in the API log means the token stored at ElevenLabs is not the desk's; that only happens when the agent's tools were edited by hand there.
- **No ticket after the call:** Settings → System → failed jobs, queue "Phone calls". "ElevenLabs has no transcript for this call" on every retry means the call belongs to another workspace than the key's. A 401 on `/phone/elevenlabs/events` in the API log means the webhook's signature did not match.
- **The agent greets without the caller's name:** the call-start webhook did not reach the desk. ElevenLabs documents it for Twilio numbers; on other numbers the caller is still recognised from the first tool call on.

## Still to find out on the first real run

1. Whether the call-start webhook fires for SIP and Exotel numbers, and for a dashboard test call.
2. Whether ElevenLabs sends the stored secret as the whole `Authorization` header (the desk accepts the token with or without `Bearer`).
3. The recording's format (the desk stores WAV or MP3 as it arrives).
4. Whether a tool with no inputs is called with an empty body.
5. For Indian numbers: whether the number's provider asks for KYC, and whether ElevenLabs asks for an India deployment.
6. The price per minute on your plan.
