# Third-party notices

Code in this repository that was copied or adapted from other projects, with the licences that require this notice. Dependencies installed from npm carry their own licences in `node_modules`.

## whatsapp-crm (wacrm)

- **Source:** https://github.com/BlackDeathWarrior/whatsapp-crm at commit `47100ad`, a fork of https://github.com/ArnasDon/wacrm.
- **Used in:** `apps/api/src/channels/whatsapp/`: `meta-api.ts`, `meta-errors.ts`, `phone-utils.ts`, `template-send-builder.ts`, `wa-identity.ts`, `webhook-payload.ts`, `webhook-signature.ts` and `whatsapp.test.ts`; and `apps/api/src/integrations/api-key.util.ts`. Each file's header names the original file and what changed.
- **Why:** the WhatsApp Cloud API adapter (ADR 0015), and API key generation and hashing (ADR 0022).
- **Licence:** MIT.

```
MIT License

Copyright (c) 2026 Arnas Donauskas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
