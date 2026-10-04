# Research: a voice agent on Sarvam AI

Checked against Sarvam's official docs and pricing page on 30 September 2026. Prices and limits change, so recheck them before committing spend.

## Sarvam APIs

Auth for every API is an `api-subscription-key` header with a key from the Sarvam dashboard.

### Speech-to-text: Saaras v4 (v3 still available)

- **Languages:** 23, meaning 22 Indian languages plus English. Language code `unknown` (the default) auto-detects and returns the detected code with `language_probability`.
- **Modes:** `transcribe`, `translate` (straight to English), `verbatim`, `translit`, `codemix`.
- **Streaming:** `wss://api.sarvam.ai/speech-to-text/ws`.
  - Send base64 audio as `wav`, `pcm_s16le`, `pcm_l16` or `pcm_raw`, at 16 kHz (preferred), 22.05 kHz or 24 kHz, or 8 kHz set when connecting.
  - With `vad_signals=true` the server sends `START_SPEECH` and `END_SPEECH` events. `START_SPEECH` is our barge-in trigger.
  - `flush_signal` forces a final transcript.
  - Streaming has no timestamps and no diarization.
- **Batch:** a REST endpoint for files, and a batch job API with diarization for longer recordings (such as stored call recordings).

### Text-to-speech: Bulbul v3 (v2 still available)

- **Languages:** 11, meaning 10 Indian languages plus English (hi, bn, ta, te, gu, kn, ml, mr, pa, od, en-IN). There are about 37 v3 voices (such as `shubh`, `ritu`, `priya`, `kabir`).
- **Streaming:** `wss://api.sarvam.ai/text-to-speech/ws?model=bulbul:v3`.
  - Send a `config` message first: `language_code`, `speaker`, `output_audio_codec` (`mp3`, `linear16`, `mulaw`, `alaw`, `opus`, `flac`, `aac`, `wav`), `speech_sample_rate` (8000 up to 24000), `pace`, `temperature`.
  - Then send `text` messages (at most 2,500 characters each), `flush` to force output, and `ping` as a keep-alive (the socket times out after a minute).
  - **`mulaw` at 8000 Hz** is exactly what Twilio and Plivo media streams expect, so TTS output passes through without resampling.

### Text

- **Language detection:** `POST https://api.sarvam.ai/text-lid` with `input` (at most 1,000 characters). It returns `language_code` and `script_code` and covers 11 languages.
- **Translation:** Mayura covers 11 languages. Sarvam-Translate covers all 23.
- **Chat LLMs:** Sarvam-105B (`sarvam-105b`, `sarvam-105b-conversations`), plus hosted open-weight models on `/v2`. The API is OpenAI-compatible, so LiteLLM can route to it like any other provider.

### Pricing (pay as you go)

| API                          | Price                                       |
| ---------------------------- | ------------------------------------------- |
| STT (REST, streaming, batch) | ₹30 per audio hour (₹45 with diarization)   |
| TTS (REST, streaming)        | ₹3 per 1,000 characters                     |
| Translation, transliteration | ₹0.005 per character (less on higher tiers) |
| Sarvam 105B chat             | ₹29.28 in / ₹73.20 out per million tokens   |

**Free tier:** ₹100 of credits on sign-up (it was ₹1,000 before May 2026). Credits never expire and work across every API. There is no ongoing free allowance after that.

### Rate limits (Starter, per account)

| API              | REST            | WebSocket     |
| ---------------- | --------------- | ------------- |
| STT              | 60 requests/min | 20 concurrent |
| TTS              | 60 requests/min | 60 concurrent |
| TTS on Bulbul v3 | 30 requests/min | 30 concurrent |
| Chat             | 60 requests/min | —             |

This means at most **20 concurrent live calls**, which is plenty for a demo.

### What a demo costs

Take one hour of demo calls in which the AI speaks about half the time. That is about 30 minutes of speech at roughly 900 characters a minute, so about 27,000 characters.

| Item                    | Cost                           |
| ----------------------- | ------------------------------ |
| STT (1 hour)            | ₹30                            |
| TTS (27,000 characters) | about ₹81                      |
| **Total**               | **about ₹111**, or about $1.30 |

The ₹100 of free credits covers most of it, and ₹500 of top-up covers a demo season.

## Getting audio in and out

| Option                            | How audio flows                                                                                                                                | Demo cost                                                                                                                                                                                  | Notes                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **Browser (WebRTC/getUserMedia)** | The Orbit Desk or widget page captures mic audio and streams 16 kHz PCM over a WebSocket to the TMS API. TTS audio is played back in the page. | **Free** (Sarvam usage only)                                                                                                                                                               | No phone number or KYC needed. Works on the AWS demo over HTTPS. It is the fastest route to a demo, but it is not a phone call. |
| **Twilio Media Streams**          | TwiML `<Connect><Stream>` opens a bidirectional WebSocket carrying mulaw 8 kHz both ways. A `clear` message cancels queued audio (barge-in).   | $0.004 per minute for streaming, plus voice minutes (US inbound is about $0.0085 per minute), plus a number (a US local number is about $1.15 a month). A trial account comes with credit. | India numbers need regulatory documents. A US number works for a demo, but callers in India pay international rates.            |
| **Exotel (Voicebot applet)**      | The Voicebot applet streams 8 kHz, 16-bit PCM (optionally 16 or 24 kHz) over a bidirectional WebSocket and supports a `clear` event.           | Pricing only through sales. Plans are monthly and need KYC.                                                                                                                                | India-native, with Indian numbers. A good choice for production in India. Pipecat has a reference integration.                  |
| **Plivo Audio Streams**           | The `<Stream bidirectional>` XML element carries mulaw 8 kHz over a WebSocket.                                                                 | India inbound with streaming is about ₹0.60 per minute (streaming is included).                                                                                                            | Indian numbers need KYC. Cheaper per minute than Twilio for India.                                                              |
| **SIP**                           | A SIP trunk into our own media server (FreeSWITCH, Asterisk or LiveKit SIP), bridged to the STT/TTS pipeline.                                  | Trunk plus DID plus a server                                                                                                                                                               | Most operational work. Not worth it for a demo.                                                                                 |

**For the demo:** start with in-browser voice (free, no KYC) and put the telephony provider behind one `VoiceTransport` interface. Twilio's trial is then the cheapest way to add a real phone number, and Exotel or Plivo the choice for Indian numbers in production.

## The pipeline in TMS

```
caller audio ─► transport (browser WS | Twilio | Exotel | Plivo)
            ─► Sarvam STT stream (language=unknown, vad_signals=true)
            ─► final transcript → MessageEnvelope(channel=voice) → InboundService.handle()
            ─► AI agent (controller=ai) → reply text
            ─► Sarvam TTS stream (detected language, mulaw 8 kHz or PCM 16 kHz)
            ─► transport ─► caller
barge-in:   START_SPEECH while TTS is playing → stop TTS, send transport "clear"
handover:   AI requests a human → play a hold message → ring agents in Orbit Desk
            (in-browser softphone) or transfer the call through the provider
transcript: each STT final and each TTS utterance is stored as a message on the voice
            conversation, so the ticket shows the whole call; the recording (optional)
            goes to S3
```

Constraints this puts on TMS:

- The voice socket is long-lived and stateful. It runs in the API process, like the chat gateway. The AI turn must not wait on the outbox round-trip, so voice needs a synchronous "agent turn" path that still writes its messages, audit and outbox in one transaction.
- **Latency budget:** STT final (about 300–600 ms after end of speech), then the LLM's first token, then the first TTS audio. Use a fast `chat_agent` model and stream LLM tokens into TTS sentence by sentence.
