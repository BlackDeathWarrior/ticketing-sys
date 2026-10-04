# ADR 0040: Phone agents: two providers behind one seam

Status: accepted (2026-10-04)

## Context

ADR 0039 put a Sarvam Voice Agent on a number rented from Sarvam. The product owner then asked for ElevenLabs Agents as a second choice: both can be switched on at once, each on its own number, with a setting for which one places the calls this desk starts.

The two differ in what they let an outside system do. Sarvam's agent, tools and webhook are made by hand in its dashboard, and its webhook is not signed. ElevenLabs has an API for all of it (agents, tools, stored secrets, webhooks, numbers), fills request headers from its own variables, and signs its post-call webhook. A Sarvam-rented number cannot be used with ElevenLabs; an ElevenLabs agent answers on a number brought from Twilio, Exotel or a SIP trunk.

## Decision

**One seam.** `PhoneAgentProvider` (`apps/api/src/channels/phone/phone-provider.ts`) is what the desk needs from a provider once a call is over: its transcript and its recording. `PhoneProviders` hands out the provider a call belongs to; `voice_calls.provider` says which. Everything else is shared: who the caller is, the gateway, knowledge search, asking for a person, links and confirmations by WhatsApp, the closing job and its sweep. Sarvam's routes and bodies did not change.

**ElevenLabs holds each tool by name; Sarvam keeps one generic tool.** Sarvam's tools cannot be made by API, so the desk's catalogue travels through `desk_tool` as text (ADR 0039). At ElevenLabs the desk creates one tool per desk tool, with that tool's own inputs, plus the desk's own three (`search_knowledge`, `request_person`, `send_whatsapp`). A model calls a named tool with typed inputs more reliably than it writes JSON as text, and nothing then depends on the call-start webhook.

**The desk sets the ElevenLabs agent up, and keeps it in step.** `ElevenLabsAgentSync` runs in the worker (queue `phone-agent-sync`): the hook token, the tools, the post-call webhook, the agent with the instruction from `phone-agent-instruction.ts`, and the number. It runs on the card's button and by itself when a tool, the card or the branding changes. A tool ElevenLabs refuses is skipped and named on the card; the agent never loses a tool that was working.

**The desk writes at ElevenLabs only what it created.** It stores the ids of the agent, the webhook, the secret and each tool (`phone_agent_tools`) and changes or deletes those and nothing else. It never lists a workspace and deletes from the list.

**Two secrets are the desk's own.** `elevenlabs.hook_token` and `elevenlabs.webhook_secret` are made and saved during set-up. No route sets or deletes them, and nobody is shown them.

**The call's identity comes from headers ElevenLabs fills.** Every tool request carries `X-Call-Id` and `X-Caller` from ElevenLabs' own variables. The body is the tool's inputs and nothing else, so the agent's model cannot name another caller.

**A signed event is still only a trigger.** The post-call webhook's signature is checked over the raw body, and a forged one writes nothing. The transcript and the recording are then fetched with our key, exactly as for Sarvam, so there is one closing path and the ticket never holds what a request body claimed.

**What holds for every phone call lives on its own card.** The provider for outbound calls, calling hours and the WhatsApp link template are the `calls` settings. Until that card is saved, calling hours and the template saved on the Sarvam card are still read.

**The desk places calls through one engine.** `PhoneOutboundService.request` is the only way a call starts: from a ticket (staff, permission `voice:call`), for a shopper who asked to be rung, or with an approval's outcome. It writes the call's record and nothing else; the worker hands the call to the provider chosen on the general card. Sarvam is told where to report (its webhook is unsigned, so a report is believed only for an attempt this desk started); ElevenLabs reports through its signed events. A call that never connected leaves its outcome on the record and a note on the ticket.

**On a call the desk placed, the customer is the one it rang.** Tools act for the customer on the call's record, whatever number or name the request carries. That closes, for outbound calls, the caller-ID weakness accepted for inbound ones.

**A call placed from a ticket stays that ticket's.** Its transcript is written onto the ticket in a voice conversation of its own, the AI neither takes the ticket nor resolves it, and the intake keeps a call's turns out of a conversation that is answered by email.

**An action that needs approval is taken on the call and answered by a call back.** An approval belongs to a ticket, and a phone call has none until it ends. So the request is checked while the caller is on the line, kept on the call's record, and asked for when the ticket is written. When a colleague decides, the phone agent rings the customer with the outcome and the reason; if that call cannot be placed or is not answered, a note asks a person to follow up. This replaces "tools that need an approval are not offered" in ADR 0039.

## Consequences

- Three AIs can drift: the desk's, Sarvam's and ElevenLabs'. One instruction in code and the no-knowledge rule limit it. Sarvam's copy is still pasted by hand.
- A tool added in Settings is on an ElevenLabs call only after the sync ran (about half a minute), and not at all while the sync fails. The card and the Voice light say so.
- The desk holds a key that can change an outside account. The stored-ids rule is what keeps a mistake from touching what the owner made there by hand.
- The call-start webhook is documented for Twilio numbers. Where it does not fire, the first tool call opens the call's record and the caller gets the plain greeting.
- The hook token is stored at ElevenLabs once and not rotated by the sync.
- Recordings are WAV from Sarvam and may be MP3 from ElevenLabs; the stored key's extension and the playback route say which.
- A request for an approval that the gateway refuses when the ticket is written (the tool was switched off meanwhile) is logged and dropped: the caller was told they would be rung back, and is not. The ticket stays open for a person.
- An ElevenLabs number that reaches it through Exotel cannot place calls yet: that API path was not read.
- Calling hours and the one-call-at-a-time check are not taken under a lock.
- Read from ElevenLabs' API reference and SDK on 2026-10-04 and not yet run against ElevenLabs: it needs the product owner's account.
