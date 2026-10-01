# ADR 0016: Channel status lights and one-step WhatsApp connect

Status: accepted (2026-10-01)

## Context

After Phase 8 the WhatsApp settings were spread over a settings form, three separate key fields, a "Test connection" button and a "Still to do" list. Nothing said plainly "this is connected and working". The other channels had even less: email had a test button, and web chat and the help-center form had nothing.

The product owner asked for two things on 2026-10-01:

- a settings screen like the one in whatsapp-crm, to connect Meta in one place;
- a light per channel, green when it is connected and working, so problems are easy to diagnose.

`docs/DESIGN.md` forbids red, green and yellow for status. This request overrides it for connection lights only.

## Decision

**Status lights**

- Every channel has a state: `ok` (green), `warning` (amber), `down` (red) or `off` (grey).
- A channel's state is the worst of its checks. Each check has a label, its own state, and a sentence that says what is wrong and what to do.
- `GET /channels/health` returns all five channels (email, WhatsApp, web chat, help-center form, voice). It needs `settings:channels`.
- Reading the lights calls no outside service. It combines:
  - saved settings and which keys exist;
  - facts the API and worker share through Redis (`ChannelSignalsService`): the last connection check, what the mailbox reader is doing, when Meta last called the webhook;
  - recent messages: last received, last sent, and failed deliveries in the last 24 hours with the latest reason;
  - the worker's heartbeat.
- The rules are pure functions (`channels/health/health-rules.ts`), so each one has a unit test.

| Channel          | Green needs                                                                                                                                                 | Red when                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Email            | The mailbox reader is connected and the mail server accepts our login                                                                                       | A login is refused, the reader reports an error, or the worker is down |
| WhatsApp         | Meta accepts the token for the number, the webhook keys are saved, Meta sends the account's messages to an app, and Meta has called or verified the webhook | No token, a rejected token, no app secret, or no webhook subscription  |
| Web chat         | The worker is running                                                                                                                                       | The worker is down                                                     |
| Help-center form | Email is working, since replies go out by email                                                                                                             | Email is not working                                                   |
| Voice            | Not built yet: always off                                                                                                                                   |                                                                        |

Failed deliveries in the last 24 hours make a channel amber, with the latest reason.

**Live checks**

- `ChannelConfigService.probe(kind)` tries the real service: an IMAP login and an SMTP login for email (reported separately), and a read of the phone number and the account's subscriptions for WhatsApp.
- A probe changes nothing, so it is not audited. "Test connection" is a probe an admin asked for, and it still writes its audit row.
- Probes run:
  - on a timer in the worker (`CHANNEL_CHECK_SECONDS`, default 300; 0 turns it off);
  - when a channel's settings or keys change;
  - when an admin clicks **Check now**.
- Sarvam is never probed automatically, because its check is a paid API call.
- When a channel that was working fails its check, the people with `settings:channels` get a notification (`channel.down`), once per outage hour. A channel that never worked sends none.

**Connect WhatsApp**

- `POST /whatsapp/connect` takes the phone number ID, business account ID, access token, app secret, verify token and an optional two-step PIN. It needs `settings:channels` and `settings:secrets`.
- Steps, following whatsapp-crm:
  1. Meta accepts the token for the phone number.
  2. The number belongs to the business account. A mismatch lists the numbers Meta does see there.
  3. Only then are the settings and keys saved, so a typo or an expired token never replaces values that work.
  4. With a PIN, the number is registered. A wrong PIN is reported, and the connection stands.
  5. The account is subscribed to the app's webhooks.
- The answer lists every step with its state. Keys left empty keep their saved value.
- The form can generate a verify token. It is shown until the page is left, so it can be copied into Meta; after that only its last four characters are.

**Colour**

- Green, amber and red are used by one component, `StatusLight`, and nowhere else. The tokens are `--signal-ok`, `--signal-warn`, `--signal-down` and `--signal-off`.
- Every light has a text label, and the check lists say the state in words, so colour is never the only signal.
- Ticket status, priority and SLA keep the glyph-and-label rule.

## Consequences

- The lights can be wrong for up to five minutes between checks. **Check now** closes the gap.
- The Redis facts are lost on a Redis restart. The lights then show "not checked yet" until the next check; no data is lost.
- The visitor count for web chat is for the API instance that answered. With several instances it undercounts.
- Email's red light needs the probe, which logs in to the mail server every five minutes.
- A green WhatsApp light proves the token, the number and the subscription. It cannot prove that Meta's webhook is pointed at this server until Meta calls it once.
