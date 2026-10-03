# ADR 0039: Phone calls answered by a Sarvam Voice Agent

Status: accepted (2026-10-04)

## Context

ADR 0018 left real phone numbers unbuilt and expected a telephony provider to stream audio into `VoiceSession`. The product owner then rented a number from Sarvam. Sarvam's docs (read 2026-10-04) say a rented number connects only to a Sarvam Voice Agent, a hosted agent that runs Sarvam's own speech and language models, and that no part of that stack can be replaced. So the call engine of ADR 0018 cannot be fed from this number.

Two ways were left. Relay: the Sarvam agent passes every thing the caller says to the desk's AI and reads the answer out. Or the Sarvam agent answers by itself and uses the desk as its source of facts. The relay keeps one AI but puts two models and seconds of silence into every turn of a phone call. The product owner chose the second.

## Decision

**The phone agent is a second AI, at Sarvam.** The desk runs no model during a phone call.

**It holds no knowledge of its own.** Its instruction (kept in `docs/runbooks/phone-agent.md`) tells it to answer policies only from `search_knowledge` and everything about products, orders and the account only from `desk_tool`. The desk's knowledge base and tools stay the one source.

**The desk's tools reach it through one generic tool.** Sarvam's tools are defined by hand in its dashboard, so the desk's are not copied there. The agent gets four fixed tools: `desk_tool` (name plus arguments as JSON text, run by `ToolGatewayService.invoke`), `list_tools`, `search_knowledge` and `request_person`. The catalogue is read from the registry on every call and handed over by the start hook, so a tool added in Settings is offered on the next call with nothing to change at Sarvam.

**Who the caller is.** Customer-bound tools run only for a number proven on a customer (ADR 0034), taken from the call's record, never from what the agent sends. Other callers get the "link your number" answer.

**The routes** (`apps/api/src/channels/phone`, API process): `POST /phone/sarvam/start` and `/phone/sarvam/tools/:name` need the hook token (secret `phone.hook_token`, made in the browser, saved write-only) and, when `PHONE_SARVAM_IPS` is set, Sarvam's address. They answer 200 with text to speak even when a tool fails: an error status would leave the caller in silence.

**The ticket is written when the call ends**, by the worker (`phone-calls` queue, `PhoneCallCloser`). `POST /phone/sarvam/ended` carries no token, because Sarvam documents no way to sign its webhook; it is only a trigger. The worker fetches the transcript from Sarvam with our key before it writes anything, then passes each caller turn through `InboundService.handle()` (channel `voice`) and stores each agent turn as a spoken AI reply marked `spokenBy: 'sarvam_agent'`. Turns written are counted on the call's record, so a retry never repeats one. `request_person` becomes a handover (source `ai`); otherwise `AiAutoResolveService.callEnded` resolves the ticket with the closure `phone_call_ended`. A call with no caller speech leaves no ticket. A sweep closes calls whose trigger never came.

**Call records** are `voice_calls` rows with `transport = 'phone'`.

## Consequences

- Two AIs can drift. The no-knowledge rule and the instruction living in the repository limit it; they do not remove it.
- The desk's guard, conduct rules, confidence checks and prompt do not apply to what the phone agent says. Tools still obey the gateway.
- A caller's number can be faked on the phone network. Someone faking a customer's number could hear their orders, change their cart or cancel an order. Accepted by the product owner's decision to offer every tool; a spoken check or a per-tool switch is the later fix.
- Tools that need an approval are not offered yet: the outcome has no way to reach a caller who has hung up. They arrive with outbound calls (the outcome is a call back).
- No live transcript in Orbit Desk, no recording, no agent joining the call, no live transfer.
- The "ended" route is unauthenticated. An id Sarvam does not know writes nothing, a call no hook announced is asked about only four times, and the route has its own limit; a forged trigger still costs a few requests to Sarvam.
- Sarvam does not document the transcript response. `parseTranscript` reads the shape its webhook documents and fails with the key names of anything else.
- Not yet run against Sarvam: it needs the product owner's account and a real call.
