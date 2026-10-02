# Chat widget

A chat button for your pages, added with two script tags. Messages open tickets in TMS; replies from the AI or an agent appear in the chat as they are sent.

Back to the [integration guide](./README.md).

## Add it

In Orbit Desk, **Settings → Integrations → your integration → Chat widget** shows the snippet for your site. It looks like this:

```html
<script src="https://support.example.com/widget/tms-chat.js"></script>
<script>
  TMSChat.init({
    server: 'https://support.example.com',
    integration: 'ethnic-threads',
  });
</script>
```

Paste it before `</body>`. With `integration` set, chats started on your site are your integration's own tickets: your webhooks hear about them and your API key can read them.

`/widget/site.html` on your TMS address is a page that stands in for a site; add `?integration=<identifier>` to try yours.

## Options

All are optional.

| Option          | What it does                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server`        | Where TMS is served. Defaults to where the script was loaded from.                                                                                                 |
| `integration`   | Your integration's identifier.                                                                                                                                     |
| `theme`         | `{ primary, onPrimary, radius, position }`: the launcher and header colour, the text colour on it, the panel's corner radius in pixels, and `'left'` or `'right'`. |
| `strings`       | `{ launcher, title, intro, placeholder, send, details, start, typing, retry, disconnected, emailError }`: the widget's wording.                                    |
| `visitor`       | `{ name, email }` you already know. Unverified: it saves the visitor typing them.                                                                                  |
| `askForDetails` | `false` skips the name and email form for anonymous visitors.                                                                                                      |
| `context`       | A small object (at most 2 KB) saying what the visitor is looking at.                                                                                               |
| `identityToken` | Vouches for a signed-in visitor (below).                                                                                                                           |
| `on`            | Callbacks (below).                                                                                                                                                 |

```js
const chat = TMSChat.init({
  integration: 'ethnic-threads',
  theme: { primary: '#7a1f3d', position: 'right' },
  strings: { launcher: 'Need help?', title: 'Ask us' },
  visitor: { name: user.name },
  context: { product_id: 'MYN-48213', title: 'Cotton straight kurta' },
  on: {
    ticket: (t) => console.log('opened', t.reference),
    message: (m) => showBadge(),
  },
});
```

`init` returns a handle:

| Method               | Does                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `open()`, `close()`  | Opens or closes the panel, for your own "Contact us" button.                                                                                  |
| `setContext(object)` | Replaces the context as the visitor moves around, for example when they open a product.                                                       |
| `identify(token)`    | The visitor signed in: the chat becomes their own conversation. Call `identify(null)` when they sign out, so the next person does not see it. |
| `destroy()`          | Disconnects and removes the widget.                                                                                                           |

While the assistant writes an answer the widget shows three moving dots. `strings.typing` is what a screen reader says for them ("Support is typing").

## Context

Agents see the context next to the ticket ("Context from Ethnic Threads: Product id MYN-48213"), and the AI reads it as background. It is attached when a message opens a ticket, so keep it current with `setContext`.

It comes from a browser, so TMS treats it as untrusted: it is shown as text and never acted on. Do not put anything in it that the visitor should not be able to set.

## Callbacks

| Callback        | Called when                           | Argument                                                   |
| --------------- | ------------------------------------- | ---------------------------------------------------------- |
| `open`, `close` | The panel opens or closes             | —                                                          |
| `ticket`        | The visitor's message opened a ticket | `{ reference }`                                            |
| `message`       | A reply arrived                       | `{ id, body, from }` with `from` `agent`, `ai` or `system` |

A callback that throws does not affect the chat.

## Signed-in visitors

Without anything more, every visitor is anonymous: a new customer per browser. To make a visitor's chat part of their history, with the tickets your server raised for them, your **server** signs a short token saying who they are.

1. In Settings → Integrations → Chat widget, **Generate secret**. It is shown once (`chid_…`). Keep it on your server.
2. On each page load for a signed-in user, sign a token and put it in the page:

   ```ts
   import { signChatIdentity } from '@tms/sdk';
   const identityToken = signChatIdentity(
     { sub: user.id, name: user.name, email: user.email },
     process.env.TMS_CHAT_IDENTITY_SECRET!,
   );
   ```

   ```python
   from tms_support import sign_chat_identity
   identity_token = sign_chat_identity(CHAT_IDENTITY_SECRET, sub=user.id, name=user.name, email=user.email)
   ```

3. Pass it to the widget: `TMSChat.init({ integration: '…', identityToken })`, or `chat.identify(identityToken)` after a sign-in without a page load.

The token is a standard JWT: HS256, claims `sub` and/or `email`, optional `name`, and `exp` (five minutes is plenty; it is only read when the chat connects). `sub` is your own id for the person, the same one you send as `customer.externalId` to the API, so both find the same customer.

A token that does not verify is ignored and the visitor is treated as anonymous. Never sign tokens in the browser: anyone holding the secret can chat as any of your users.

## Notes

- The widget renders in a shadow root: your CSS does not affect it, and its CSS does not affect your page.
- A returning visitor resumes their conversation (the session is kept in the browser's local storage, per site).
- When a ticket is solved, the visitor is asked to rate it in the chat.
- The widget's own status lines ("Connecting…") and the rating question are in English.
