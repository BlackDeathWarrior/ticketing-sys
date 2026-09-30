# ADR 0009: Stored credentials are encrypted, write-only and admin-only

Status: accepted (2026-09-30)

## Context

Admins manage keys from the Settings page: LLM provider keys, channel credentials (email passwords, the WhatsApp token and app secret, the Sarvam key), and later tool and MCP secrets. The requirements are:

- encryption at rest;
- only admins may see or rotate keys;
- keys are shown masked to their last four characters;
- every create, rotate and delete is audited.

## Decision

- **LLM provider keys** are stored in LiteLLM credentials, encrypted with `LITELLM_SALT_KEY` (ADR 0003, 0008). TMS keeps the last four characters.
- **Every other secret** is stored in the TMS `secrets` table by `SecretsService`:
  - encrypted with AES-256-GCM;
  - with a random 12-byte IV per value;
  - with the secret's name bound as additional authenticated data, so a ciphertext can't be moved onto another key's row;
  - in the format `v1:<iv>:<ciphertext>:<tag>`, base64url;
  - under a master key, `TMS_SECRETS_KEY` (32 bytes, base64), which is required in production. On AWS it comes from SSM Parameter Store. Locally it has a fixed, clearly labelled development default.
  - The `key_version` column leaves room to rotate the master key.
- **Write-only:**
  - No API route returns a secret's value.
  - Views return `last4` only when the value has at least 12 characters; shorter values are shown as `••••`.
  - Decrypted values are read only on the server, by senders, pollers and (later) tool calls.
- **Permissions:**
  - A new permission, `settings:secrets`, held by admins only, covers creating, rotating and deleting any key. That includes the `apiKey` field on LLM providers, which is checked in the controller.
  - `settings:llm` (models, roles, caps) and `settings:channels` (channel hosts and options, connection tests) are also admin-only by default.
  - Supervisors have no key access.
- **Audit and events:**
  - Each change writes `settings.secret_created`, `settings.secret_rotated` or `settings.secret_deleted`, with the key name and last four characters, never the value, plus a `settings.secret_changed` event.
  - The worker handles that event: it clears cached settings and reconnects the mailbox when email credentials change.
- **Channel settings:** they now come from the Settings page first and environment variables second (`ChannelConfigService`). The email poller, the SMTP sender and outbound replies read them at runtime.
- **Test connection:** it is the one place a request calls an external service synchronously (IMAP/SMTP login, Sarvam, Meta Graph), because the admin is waiting for the answer. It has a 10-second timeout, and its result is stored and audited.

## Consequences

- Losing `TMS_SECRETS_KEY` makes stored secrets unreadable: they have to be entered again. Back it up with the database.
- AWS KMS envelope encryption can replace the master key later without a schema change: a new `key_version` and `v2` format.
- Secrets never appear in logs. The decrypt error path logs only the key name.
