# Phase 9 demo checklist: voice calls

Prerequisites: `pnpm docker:up && pnpm sample:load`, a Sarvam API key (calls use Sarvam credits), and a browser with a microphone. `localhost` is allowed to use the microphone; any other address needs HTTPS.

Calls over a real phone number work differently (a Sarvam Voice Agent answers): see `phone-agent.md`.

## Without a key

1. Open http://localhost:8080/widget/voice.html and click **Start call**. It answers "Voice calls are not available right now. Please use the chat."
2. In Orbit Desk (http://localhost:8081, `admin@example.com`), **Settings → Channels**: the Voice light is grey, "Not set up".

## Set it up

1. In the **Sarvam voice** card, save your key under **API subscription key**. Only the last four characters show afterwards.
2. Check the greeting (it must say the call is recorded), then **Save settings**.
3. **Test connection.** The Voice light turns green: "Ready for calls".

## A call answered by the AI

1. Open the call page, read the recording notice and click **Start call**. Allow the microphone.
2. You hear the greeting. Ask "What is your returns policy?" in English or Hindi.
3. The answer is spoken in your language and shown as captions. Start talking while it speaks: it stops.
4. In Orbit Desk, a new ticket (channel "Voice call") shows the transcript with AI badges.

## Handing over to a person

1. On a call, say "I want to talk to a person". You hear the hold line.
2. Sign in as an agent (`jonah.reyes@tms.example`, password `Sample-Passw0rd!`). The handover notification opens the ticket.
3. In the **Voice call** panel click **Join call** and allow the microphone. Talk to the caller; what you both say lands on the ticket.
4. **Leave call** puts the caller back on hold; **Hand back** on the ticket returns the call to the AI. **End call** hangs up.

## After the call

1. The ticket's **Voice call** panel shows the length, the language and who answered.
2. As a supervisor or admin, play the recording (caller on the left, our side on the right). The audit log records that you listened.
3. Recordings are deleted after 30 days. Switch **Record calls** off to keep transcripts only.

## If something is wrong

- Light red, "Sarvam refused the connection": the key is wrong or out of credits.
- "All our lines are busy": `VOICE_MAX_CALLS` calls are already running (default 5).
- "The microphone is blocked": allow it in the browser's site settings.
