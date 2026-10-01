# Phase 8 demo checklist: WhatsApp

WhatsApp ships switched off. It works once you connect a Meta app, and there is no simulator. This page covers what you can see without Meta and how to connect a real number.

## Without a Meta account

Prerequisites: `pnpm docker:up && pnpm sample:load`.

1. Sign in to Orbit Desk (http://localhost:8081) as `admin@example.com`.
2. Open **Settings → Channels → WhatsApp**. The card shows:
   - the settings (channel on/off, phone number ID, business account ID, Graph API version);
   - the three secrets (access token, app secret, webhook verify token);
   - the **webhook address** to paste into Meta;
   - **Still to do**, listing what is missing;
   - the template list, empty until the first sync.
3. The browser tests show the rest. They post signed webhooks the way Meta does:

   ```bash
   pnpm --filter @tms/e2e exec playwright test tests/whatsapp.spec.ts
   ```

   - A customer message opens a WhatsApp ticket in the queue.
   - The AI answers, and the reply shows **Not delivered** with the reason, because no access token is saved.
   - A message older than 24 hours makes the reply box offer templates only.

The tests switch the channel off again when they finish.

## Connecting a real number

You need a Meta developer account and a way for Meta to reach your machine.

### 1. Make the webhook reachable

Meta only calls public HTTPS addresses. For a local stack, run a tunnel to the API (port 3000), for example with cloudflared or ngrok. The webhook address is then:

```
https://<your-tunnel-host>/api/v1/channels/whatsapp/webhook
```

On the AWS demo (Phase 12) the address shown in Settings works as it is.

### 2. Create the Meta app

1. At https://developers.facebook.com, create an app of type **Business** and add the **WhatsApp** product.
2. **WhatsApp → API setup** gives you a free test number. Note the **Phone number ID** and the **WhatsApp Business Account ID**.
3. Add your own phone under **To**, so the test number may message it. A test number can message up to five verified recipients.
4. Copy the **temporary access token** (it lasts 24 hours). For longer use, create a System User token with `whatsapp_business_messaging` and `whatsapp_business_management`.
5. **App settings → Basic** shows the **App secret**.

### 3. Enter the details in Orbit Desk

In **Settings → Channels → WhatsApp**:

1. Set **WhatsApp channel on** to Yes, enter both IDs, and **Save settings**.
2. Save the **Access token** and the **App secret**.
3. Make up a **Webhook verify token** (any long random string) and save it.
4. **Test connection** should answer "Connected to +1 555 … (name), quality green".

Enter keys yourself in the Settings page. Don't paste them into chat, commits or files.

### 4. Point Meta at the webhook

1. In Meta, **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: the webhook address from step 1;
   - Verify token: the one you saved in Orbit Desk.
2. Subscribe to the **messages** field. Add **message_template_status_update** to follow template approvals.
3. In Orbit Desk, click **Subscribe to webhooks** once. It links the business account to the app.

### 5. Try it

1. Send a WhatsApp message from your phone to the test number.
   - A ticket appears in the queue, channel WhatsApp.
   - The AI answers on its own when a model is configured (web chat, WhatsApp and voice answer by themselves).
2. Open the ticket and reply. The label next to your message changes to **Delivered**, then **Read** once the customer opens it.
3. Send a photo from your phone. It appears as an attachment on the message.
4. **Sync templates.** The test account has `hello_world`. Templates you create in WhatsApp Manager appear after Meta approves them.
5. Wait 24 hours, or pick a ticket whose customer last wrote more than a day ago. The reply box offers **WhatsApp template** only.
6. To write first: open a ticket whose customer has a phone number and no conversation, and choose **WhatsApp template** in the reply box.

## When something fails

| What you see                                    | What it means                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| "Not delivered: WhatsApp is not connected"      | No access token is saved, or the channel is off                                                    |
| "The WhatsApp access token has expired"         | Temporary tokens last 24 hours. Save a new one                                                     |
| "not on the allowed list of Meta's test number" | Add the customer's number under **To** in Meta's API setup                                         |
| "More than 24 hours have passed"                | Send an approved template                                                                          |
| Messages don't arrive                           | Check **Still to do** in Settings, the tunnel, and that Meta's webhook is subscribed to `messages` |
| Meta's webhook verification fails               | The verify token in Meta and in Orbit Desk differ, or the address is not reachable over HTTPS      |

Failed webhooks are retried six times and then logged by the worker (`docker logs tms-worker-1`).

## Limits

- One WhatsApp number.
- Agents send text and templates, not files.
- Customers don't get read receipts for messages they send.
- Reactions are ignored.
