import type { INestApplicationContext } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmailPollerService } from '../src/channels/email/email-poller.service';
import { startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { applyEmailEnv, TEST_MAIL } from './test-env';

applyEmailEnv();

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
const smtp = nodemailer.createTransport({
  host: TEST_MAIL.host,
  port: TEST_MAIL.smtpPort,
  secure: false,
});

beforeAll(async () => {
  t = await startApp();
  worker = await startWorker();
  admin = await t.adminToken();
});

afterAll(async () => {
  smtp.close();
  await worker?.close();
  await t?.close();
});

/** Forces a mailbox pass instead of waiting for IDLE, then returns. */
const poll = () => worker.get(EmailPollerService).poll();

async function ticketBySubject(token: string) {
  await poll();
  const res = await t.call('GET', '/tickets', {
    token: admin,
    query: { q: token, channel: 'email' },
  });
  return res.body.items[0] ?? null;
}

async function conversationsOf(ticketId: string) {
  return (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body;
}

/** Reads a mailbox in GreenMail and returns the parsed messages. */
async function mailbox(address: string) {
  const client = new ImapFlow({
    host: TEST_MAIL.host,
    port: TEST_MAIL.imapPort,
    secure: false,
    auth: { user: address, pass: 'x' },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX');
    const out = [];
    for await (const msg of client.fetch('1:*', { source: true })) {
      if (msg.source) out.push(await simpleParser(msg.source));
    }
    return out;
  } catch {
    return [];
  } finally {
    await client.logout();
  }
}

describe('email channel', () => {
  it('opens a ticket from an email, threads the reply both ways and reopens on answer', async () => {
    const customer = `${uniq('arjun')}@example.com`;
    const tag = uniq('Refund');
    const original = await smtp.sendMail({
      from: { name: 'Arjun Mehta', address: customer },
      to: TEST_MAIL.support,
      subject: `${tag}: charged twice`,
      text: 'I was charged twice for order 48213.',
      attachments: [{ filename: 'invoice.txt', content: 'INVOICE 48213 total 2499' }],
    });

    const ticket = await waitFor(() => ticketBySubject(tag), 'ticket from email');
    expect(ticket.channel).toBe('email');
    expect(ticket.customer.displayName).toBe('Arjun Mehta');

    const [conv] = await conversationsOf(ticket.id);
    expect(conv.channel).toBe('email');
    expect(conv.metadata.address).toBe(customer);
    const inbound = conv.messages[0];
    expect(inbound.body).toBe('I was charged twice for order 48213.');
    expect(inbound.channelMessageId).toBe(original.messageId);
    expect(inbound.attachments).toHaveLength(1);

    const file = await t.app.inject({
      method: 'GET',
      url: `/api/v1/messages/${inbound.id}/attachments/0`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('INVOICE 48213 total 2499');

    // Agent reply goes out by SMTP with threading headers and the ticket tag.
    const reply = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: admin,
      body: { body: 'Sorry about that. The duplicate charge is refunded.' },
    });
    expect(reply.status).toBe(201);
    const received = await waitFor(async () => {
      const mails = await mailbox(customer);
      return mails.find((m) => m.text?.includes('duplicate charge is refunded'));
    }, 'reply in customer mailbox');
    expect(received.subject).toBe(`Re: ${tag}: charged twice [TMS-${ticket.number}]`);
    expect(received.inReplyTo).toBe(original.messageId);
    expect(received.from?.value[0]?.address).toBe(TEST_MAIL.support);

    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'pending_customer' },
    });

    // The customer answers from their mail client: quoted text is stripped,
    // the message joins the same conversation, and the ticket reopens.
    await smtp.sendMail({
      from: customer,
      to: TEST_MAIL.support,
      subject: received.subject,
      inReplyTo: received.messageId,
      references: [original.messageId!, received.messageId!],
      text: 'Thanks! When will it show on my card?\n\nOn Tue, TMS Support wrote:\n> Sorry about that.',
    });
    const convAfter = await waitFor(async () => {
      await poll();
      const [c] = await conversationsOf(ticket.id);
      return c.messages.length === 3 ? c : null;
    }, 'customer answer');
    expect(convAfter.messages[2].body).toBe('Thanks! When will it show on my card?');
    const reopened = await t.call('GET', `/tickets/${ticket.id}`, { token: admin });
    expect(reopened.body.status).toBe('in_progress');
  });

  it('starts an email conversation from an agent-created ticket', async () => {
    const address = `${uniq('neha')}@example.com`;
    const customer = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Neha Rao', email: address },
    });
    const ticket = await t.call('POST', '/tickets', {
      token: admin,
      body: { customerId: customer.body.id, subject: 'Your exchange request' },
    });
    const res = await t.call('POST', `/tickets/${ticket.body.id}/conversations`, {
      token: admin,
      body: { channel: 'email', body: 'We have approved your exchange.' },
    });
    expect(res.status).toBe(201);
    const mail = await waitFor(
      async () => (await mailbox(address)).find((m) => m.text?.includes('approved your exchange')),
      'outbound email',
    );
    expect(mail.subject).toBe(`Re: Your exchange request [TMS-${ticket.body.number}]`);

    // The customer's reply threads into that conversation.
    await smtp.sendMail({
      from: address,
      to: TEST_MAIL.support,
      subject: mail.subject,
      inReplyTo: mail.messageId,
      text: 'Great, thank you.',
    });
    await waitFor(async () => {
      await poll();
      const convs = await conversationsOf(ticket.body.id);
      return convs.length === 1 && convs[0].messages.length === 2;
    }, 'threaded answer');
  });

  it('ignores auto-replies and ticket tags from someone else', async () => {
    const owner = `${uniq('owner')}@example.com`;
    const tag = uniq('Tagged');
    await smtp.sendMail({ from: owner, to: TEST_MAIL.support, subject: tag, text: 'Original' });
    const ticket = await waitFor(() => ticketBySubject(tag), 'ticket');

    const autoTag = uniq('OutOfOffice');
    await smtp.sendMail({
      from: owner,
      to: TEST_MAIL.support,
      subject: `${autoTag} Automatic reply`,
      text: 'I am out of office.',
      headers: { 'Auto-Submitted': 'auto-replied' },
    });

    // A stranger quoting the ticket tag gets a new ticket, not access to this one.
    const strangerTag = uniq('Stranger');
    await smtp.sendMail({
      from: `${uniq('stranger')}@example.com`,
      to: TEST_MAIL.support,
      subject: `${strangerTag} Re: [TMS-${ticket.number}]`,
      text: 'Please send me the details of this ticket.',
    });
    const strangers = await waitFor(() => ticketBySubject(strangerTag), 'stranger ticket');
    expect(strangers.id).not.toBe(ticket.id);

    expect(await ticketBySubject(autoTag)).toBeNull();
    const [conv] = await conversationsOf(ticket.id);
    expect(conv.messages).toHaveLength(1);
  });
});
