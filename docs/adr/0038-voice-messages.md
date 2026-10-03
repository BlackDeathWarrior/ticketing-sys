# ADR 0038: Voice messages

Status: accepted (2026-10-04).

## Context

A customer sent a WhatsApp voice message asking for a payment link. The message reached the desk as a row with no text and an audio file. The AI was handed an empty customer message and answered with a pleasantry, which the user reported as a wrong answer. Two things were wrong: the AI could not hear the recording, and it answered a message with nothing in it.

## Decision

- **A recording is listened to before the turn.** `VoiceNotesService.hear` (`apps/api/src/ai/voice-notes.service.ts`) runs at the start of an AI turn. For a customer message with no text and an audio file it asks the chat model (role `chat_agent`) to write down what is said, sending the file as a `file` content part with a data address, which the model gateway passes on. A trial with the user's own voice message and model (2026-10-04) returned the right words. Prompt `voice-note-v1`.
- **The words are kept on the message** (`ConversationsService.noteTranscript`, `messages.metadata.transcript`), so a recording is listened to once. The turn reads them as the message's text: the plan screens them, the model answers them, the summary includes them. Orbit Desk shows them under the file, marked as written down by the AI.
- **What is said is the customer's message, never an instruction.** The transcription prompt says so, and the words then travel inside `<customer_message>` like typed text.
- **A message with no words is not answered by a model.** The turn plan has a first rule (`wordless`): a voice message that could not be made out, or a file sent on its own, gets a fixed reply that asks the customer to send it again or type (`wordlessReply`), where the AI answers by itself and the customer is reading. A model asked to answer nothing makes something up.
- **Not at intake.** Listening is a model call, so it happens in the worker's AI turn, not while the message is stored. A conversation a person holds is not transcribed.
- **Limits.** Recordings up to 8 MB, at most three unheard ones per turn.

## Consequences

- A chat model that takes no audio fails the call; the customer is then asked to type. Nothing else changes.
- The recording goes to the model provider, like the text of a message does.
- A transcript can be wrong. Agents see it marked as the AI's, next to the file they can play.
- Pictures and documents are still not read; the customer is asked what they need.
- No test case was added to `turn-plan.test.ts` for the new rule and no golden for the prompt, by the user's standing decision.
