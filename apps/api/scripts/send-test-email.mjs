#!/usr/bin/env node
// Sends a "customer" email to the dev support mailbox (GreenMail) so you can
// watch it become a ticket. Usage:
//   pnpm demo:email -- --from priya@example.com --subject "Where is my order?" --text "Order 48213"
//   pnpm demo:email -- --in-reply-to "<message-id@tms.local>"   (answer a TMS reply)
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';

const { values } = parseArgs({
  options: {
    from: { type: 'string', default: 'priya.sharma@example.com' },
    name: { type: 'string', default: 'Priya Sharma' },
    to: { type: 'string', default: 'support@tms.local' },
    subject: { type: 'string', default: 'Where is my order?' },
    text: { type: 'string', default: 'Hi, my order 48213 has not arrived yet. Can you check?' },
    'in-reply-to': { type: 'string' },
    host: { type: 'string', default: process.env.DEMO_SMTP_HOST ?? 'localhost' },
    port: { type: 'string', default: process.env.DEMO_SMTP_PORT ?? '3025' },
  },
});

const transport = nodemailer.createTransport({
  host: values.host,
  port: Number(values.port),
  secure: false,
});
const info = await transport.sendMail({
  from: { name: values.name, address: values.from },
  to: values.to,
  subject: values.subject,
  text: values.text,
  inReplyTo: values['in-reply-to'],
  references: values['in-reply-to'],
});
console.log(`Sent ${info.messageId} from ${values.from} to ${values.to}`);
transport.close();
