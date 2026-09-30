# Research: reusing whatsapp-crm for the TMS WhatsApp channel

Studied on 30 September 2026 at commit `47100ad` of https://github.com/BlackDeathWarrior/whatsapp-crm.

## What it is

- A fork of [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm) (v0.8.0), a self-hostable WhatsApp CRM. The fork adds four commits on 26 September 2026: more LLM providers, a per-provider key store, custom MCP servers, and a privacy-policy page for Meta app review.
- **Licence:** MIT, copyright 2026 Arnas Donauskas. Ported code must keep the copyright and permission notice.
- **Size:** about 11,100 lines in `src/lib/whatsapp/` alone, with tests next to most files.

## Stack

| Concern | Choice                                                                                     |
| ------- | ------------------------------------------------------------------------------------------ |
| App     | Next.js 16 (App Router, route handlers), React 19, Tailwind 4, shadcn                      |
| Data    | Supabase (Postgres + Auth + Storage), row-level security on every table, 43 SQL migrations |
| Tooling | npm, Vitest 4, TypeScript 6                                                                |
| Hosting | Vercel or Hostinger; the webhook uses `after()` to finish work after acknowledging Meta    |
| Extras  | Flow builder, automations, broadcasts, pipelines, public REST API, its own MCP server      |

## How it talks to WhatsApp

**Official Meta WhatsApp Cloud API**, called directly over the Graph API (`https://graph.facebook.com/v21.0`). It does not use Baileys, whatsapp-web.js or a BSP, so there is no ban risk from unofficial clients.

### Webhook (`src/app/api/whatsapp/webhook/route.ts`)

- `GET`: the `hub.challenge` handshake. It compares `hub.verify_token` against every stored (encrypted) verify token.
- `POST`: reads the raw body and checks `X-Hub-Signature-256` with HMAC-SHA256 in constant time (`webhook-signature.ts`). `META_APP_SECRET` may list several secrets, one per Meta app. It fails closed when no secret is set.
- It acknowledges fast and processes in `after()`. It handles `messages` (text, image, video, document, audio, sticker, location, reaction, interactive replies, template button taps, reply context), `statuses` (sent, delivered, read, failed with Meta error codes) and template-status changes.
- **Identity** (`wa-identity.ts`): since Meta's 2026 username rollout, a sender may arrive with only a business-scoped user id (BSUID, `from_user_id`) and no phone number. The code keys contacts on the BSUID when present, falls back to the phone, and backfills the BSUID onto known phone contacts.

### Sending (`meta-api.ts`, `send-message.ts`)

- `meta-api.ts` is plain `fetch` with almost no imports: text, media (image, video, document, audio), templates, reactions, typing indicators, interactive buttons and lists, resumable media upload, template submit/edit/delete, phone-number register/verify, WABA subscription.
- `MetaApiError` and `meta-error-explain.ts` turn Meta error codes into readable reasons (for example 131047, outside the 24-hour window).
- `send-message.ts` is tied to Supabase: it loads the config, decrypts the token and writes the message row.

### Sessions and auth

- It is a Cloud API integration, so there is no device session or QR code. Each account stores `phone_number_id`, `waba_id`, the access token and the verify token in `whatsapp_config`, with the token encrypted by AES-256-GCM (`encryption.ts`, key `ENCRYPTION_KEY`, hex). Legacy CBC rows can still be decrypted.
- Multiple WABAs and apps are supported (`docs/multi-waba.md`, `waba-pairing.ts`).

### Media

- Inbound media goes through `getMediaUrl` then `downloadMedia` (a bearer-authenticated fetch). `mirror-inbound-media.ts` copies it into Supabase Storage with a size cap and a MIME-based extension.
- Outbound media is uploaded through Meta's resumable upload.

### Templates

- Templates are synced from Meta, validated (`template-validators.ts`), built into send payloads with variables, header media and buttons (`template-send-builder.ts`), and tracked through status webhooks.

### Other reusable pieces

- `lib/mcp/client.ts`: a hand-written MCP client over Streamable HTTP (initialize, tools/list, tools/call). Every request goes through an SSRF guard (`ai/outbound-url.ts`).
- `lib/ai/handoff.ts`: a deterministic handoff summary note.
- `lib/ai/auto-reply.ts`: a per-conversation reply cap with human handoff.
- `lib/webhooks/ssrf.ts`, `sign.ts`: SSRF checks and HMAC signing for outgoing webhooks.

## Port or sidecar?

**Recommendation: (a) port the adapter code into a TMS `WhatsAppChannel`.**

| Option      | For                                                                                                                                                                                                                                                                                                                   | Against                                                                                                                                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Port    | The valuable code (`meta-api.ts`, signature check, BSUID identity, phone utils, template builder and validators, error explanations) is framework-free TypeScript under MIT. It maps directly onto TMS's `MessageEnvelope` → `InboundService` and `ChannelSender` → worker. One database, one audit trail, one inbox. | We must adapt the Supabase-bound parts (config loading, media mirroring, message writes) to Drizzle and S3. We must port the tests too. We have to track upstream fixes (Meta API changes) by hand.                                                                                                                                                 |
| (b) Sidecar | Reuses the whole app as is, including broadcasts and the template editor.                                                                                                                                                                                                                                             | It is a complete CRM, not a gateway. Contacts, conversations, users and AI replies would live in a second Postgres (Supabase), so the same customer has two histories and two AI agents could answer. It needs Supabase to run, which breaks the "one compose stack" and free-AWS goals. Its auth model (Supabase accounts) doesn't match TMS RBAC. |

Port list (into `apps/api/src/channels/whatsapp/`): `meta-api.ts` (the send and media functions only), `webhook-signature.ts`, `wa-identity.ts`, `phone-utils.ts`, `template-send-builder.ts`, `template-validators.ts`, `template-components.ts`, `meta-error-explain.ts`, `interactive.ts`, and their tests. Re-implement `mirror-inbound-media` against `StorageService`, and `encryption.ts` as part of the TMS secrets module.

Later, `lib/mcp/client.ts` and its SSRF guard are worth studying for the Tool Gateway (Phase 6), though TMS will likely use `@modelcontextprotocol/sdk` behind the same SSRF guard.

## Concerns

- **Licence:** MIT allows this. Keep the notice in a header comment on each ported file and add a `THIRD_PARTY_NOTICES.md`.
- **Graph API version:** it is pinned to `v21.0`, released in October 2024. Meta supports a Graph version for about two years, so v21.0 is close to end of life. Bump the version when porting.
- **Maintenance:** upstream is active (merged PRs up to #596 in September 2026). The fork is 4 commits ahead and does not track upstream automatically. Porting freezes a snapshot, so a Meta change (like the 2026 BSUID rollout) has to be applied to TMS by hand.
- **Meta requirements for a live number:** a Meta Business account, a Meta app with the WhatsApp product, a verified business (for production volume), a phone number that isn't on the WhatsApp consumer app, and approved templates for messages outside the 24-hour window. Meta's free test number can message up to 5 verified recipients, which is enough for a demo.
- **Unofficial libraries** (Baileys, whatsapp-web.js) automate the consumer app, break WhatsApp's terms and get numbers banned. TMS should not use them.
