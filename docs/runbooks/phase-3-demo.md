# Phase 3 demo checklist: LLM platform and Settings keys

Prerequisites: `pnpm docker:up && pnpm sample:load`.

- The loader registers the scripted **Demo model** provider (`apps/fake-providers`), so this works without any real key.
- To try a real provider, have its API key at hand. Never paste it anywhere except the Settings form.

## Providers and caps

1. Sign in to Orbit Desk (http://localhost:8081) as `admin@example.com`, then open **Settings** in the sidebar (under Admin).
2. **AI providers** lists "Demo model (scripted)":
   - the key column shows `••••demo`;
   - the spend column shows spend against a $5/month cap.
3. Click **Test**. The row shows "Connected" with the time.
4. Click **Add provider** and pick a real provider, for example Anthropic. Enter a name, the key and a cap such as `2`, then **Add provider**.
   - The table shows only the key's last four characters.
   - Reload the page: the key is still masked.
   - `GET /api/v1/audit?action=llm.provider_created` has the entry, and the entry does not contain the key.
5. **Test** the new provider. A wrong key shows "Failed", with the provider's reason on hover.

## Models and roles

1. Open **Models & roles** and click **Add model**. Pick your provider and enter a model name, for example `claude-haiku-4-5`. Capabilities and prices fill in from LiteLLM.
2. Under **Roles**, "AI agent (chat and email)" lists models cheapest first. Click **Try it**: the answer names the model that replied.
3. Set the cheapest provider's cap to `0` on **AI providers**. Back in **Models & roles**, it shows "over budget". **Try it** now answers from the next model.
4. **Change** a role to "Fixed order", tick two models, reorder them and save. **Try it** uses the first one.
5. **Usage** shows spend by provider and role, and the recent calls.

## Channel credentials

1. Open **Channels**. Email shows "Currently read from environment variables".
   - Click **Test connection**: it logs in to GreenMail over IMAP and SMTP.
2. Under **Sarvam voice**, enter a Sarvam key and **Save**.
   - The field clears, and "Stored: ••••" shows the last four characters.
   - **Test connection** calls Sarvam's language detection.
   - Delete the key again.

## Permission checks

- Sign in as `jonah.reyes@tms.example` (agent) or `maya.lindqvist@tms.example` (team lead). There is no Settings link, and `GET /api/v1/settings/secrets` returns 403.
- As `priya.natarajan@tms.example` (supervisor), `GET /api/v1/settings/llm/providers` returns 403.
