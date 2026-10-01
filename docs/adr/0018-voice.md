# ADR 0018: Voice calls in the browser, on Sarvam

Status: accepted (2026-10-01)

## Context

The brief asks for a voice channel answered by the AI, with handover to a person. The product owner chose in-browser calls only (no phone numbers yet), Sarvam for speech, all 11 Bulbul languages, and transcripts plus audio recorded. Sarvam's streaming APIs were checked against docs.sarvam.ai on 2026-10-01.

## Decision

**Transport**

- The caller's page (`/widget/voice.html`, bundle `tms-voice.js`) streams 16 kHz mono PCM over a public Socket.IO namespace, `/voice`. A call starts only after the caller sees the recording notice and clicks Start call.
- Agents hear and join calls over their `/agent` socket (`voice:join`, `voice:audio`, `voice:leave`). Joining needs `voice:answer`.

**One call = one `VoiceSession`**

- A state machine (`greeting`, `listening`, `thinking`, `speaking`, `waiting`, `human`, `ended`) in the API process, owned by `VoiceService`. It talks to speech through a `SpeechProvider` interface; `SarvamSpeech` is the only implementation.
- Speech to text: Sarvam `saaras:v4` streaming, language detected per utterance, with its speech start/end signals.
- Text to speech: Sarvam `bulbul:v3` streaming, one socket per sentence. A language outside the 11 gets English.
- Barge-in: when the caller starts talking, the speech socket is closed and the browser drops queued audio.

**It is a normal conversation**

- Each thing the caller says goes through `InboundService.handle()` as a `voice` message, so tickets, identity, audit and the outbox work as on every channel.
- The AI turn runs inline (`AiAgentService.runTurn`), not through the `ai-turns` queue: a caller can't wait for a queue. Same prompts, tools, approvals and knowledge base as chat.
- Spoken replies are stored as `sent` with `message.spoken` (there is nothing for the worker to deliver).
- No drafts on a call: what would be a draft becomes a handover. The AI says a hold line, the ticket is routed as usual (ADR 0014), and an agent joins from the ticket. The agent's speech is transcribed onto the ticket too.
- Typed replies to a voice conversation are refused.

**Recording**

- A stereo WAV (caller left, our side right) is uploaded to S3 when the call ends, if "Record calls" is on. Transcripts are always kept.
- Listening needs `voice:recording_read` (supervisors and up) and is audited. A daily worker job deletes recordings after 30 days.

**Limits and health**

- `VOICE_MAX_CALLS` (default 5) calls at once; the next caller is asked to try again. Calls end at "Longest call" (default 10 minutes).
- The Voice status light (ADR 0016) checks the key, the last connection test and free lines. Sarvam is never probed automatically, because its API is paid.

**No stand-in for Sarvam.** Unit tests run the Sarvam client against a WebSocket server created inside the test; integration tests swap the `SpeechProvider` for a scripted one and go through the real sockets and routes.

## Consequences

- Live calls are held in one API process's memory. With several API instances, an agent can only join a call on the instance their socket reached; a restart ends its calls (`server_shutdown`). Fine for the single-instance demo; a media service is the fix later.
- The AI's reply is spoken after the whole turn finishes, not token by token, so replies start a little later than they could.
- Not yet run against Sarvam itself: it needs a key and credits. The requested speech format (`linear16` at 16 kHz) follows Sarvam's streaming guide; its API reference mentions MP3 only, so this is the first thing to check with a real key.
- Real phone numbers (Twilio, Exotel, Plivo) are not built. They would be a second transport feeding the same `VoiceSession`.
