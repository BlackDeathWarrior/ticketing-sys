import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmailPollerService } from '../src/channels/email/email-poller.service';
import { OutboundService } from '../src/channels/outbound.service';
import { makeUser, startApp, startWorker, type TestClient, uniq, waitFor } from './helpers';
import { applyEmailEnv, TEST_MAIL } from './test-env';

applyEmailEnv();

let t: TestClient;
let worker: INestApplicationContext;
let admin: string;
let categoryId: string;
const smtp = nodemailer.createTransport({
  host: TEST_MAIL.host,
  port: TEST_MAIL.smtpPort,
  secure: false,
});

beforeAll(async () => {
  t = await startApp();
  worker = await startWorker();
  admin = await t.adminToken();
  const res = await t.call('POST', '/categories', {
    token: admin,
    body: { name: uniq('Returns') },
  });
  categoryId = res.body.id;
});

afterAll(async () => {
  smtp.close();
  await worker?.close();
  await t?.close();
});

interface FormFile {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** Posts the form the way the help center page does: multipart, no token. */
async function submit(fields: Record<string, string>, files: FormFile[] = []) {
  const boundary = `----tms${uniq()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
      ),
      f.content,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/public/requests',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(parts),
  });
  return { status: res.statusCode, body: res.json() };
}

function form(overrides: Record<string, string> = {}) {
  return {
    submissionId: randomUUID(),
    name: 'Lena Fischer',
    email: `${uniq('lena')}@example.org`,
    subject: `${uniq('Wrong size')}: jacket`,
    description: 'I ordered a medium jacket and received a small one. Can I exchange it?',
    ...overrides,
  };
}

interface TicketRow {
  id: string;
  number: number;
  channel: string;
  categoryId: string | null;
  customer: { displayName: string };
}

async function ticketFor(subject: string) {
  const res = await t.call('GET', '/tickets', { token: admin, query: { q: subject } });
  return res.body.items as TicketRow[];
}

async function conversationsOf(ticketId: string) {
  return (await t.call('GET', `/tickets/${ticketId}/conversations`, { token: admin })).body;
}

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

describe('web form channel', () => {
  it('describes the form publicly: topics and upload limits', async () => {
    const res = await t.call('GET', '/public/request-form');
    expect(res.status).toBe(200);
    expect(res.body.maxFiles).toBe(3);
    expect(res.body.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(res.body.categories).toContainEqual({ id: categoryId, name: expect.any(String) });
    // Only names and ids leave the building.
    expect(Object.keys(res.body.categories[0]).sort()).toEqual(['id', 'name']);
  });

  it('opens a ticket with attachments, acknowledges by email and threads the replies', async () => {
    const f = form({ categoryId, orderNumber: 'DS-48213' });
    const res = await submit(f, [
      { filename: 'label.png', contentType: 'image/png', content: Buffer.from('PNGDATA') },
      {
        filename: 'receipt.txt',
        contentType: 'text/plain',
        content: Buffer.from('ORDER DS-48213'),
      },
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ reference: expect.stringMatching(/^TMS-\d+$/), email: f.email });

    const [ticket] = await ticketFor(f.subject);
    expect(ticket).toBeDefined();
    expect(`TMS-${ticket!.number}`).toBe(res.body.reference);
    expect(ticket!.channel).toBe('web_form');
    expect(ticket!.categoryId).toBe(categoryId);
    expect(ticket!.customer.displayName).toBe('Lena Fischer');

    const [conv] = await conversationsOf(ticket!.id);
    expect(conv.channel).toBe('web_form');
    expect(conv.metadata).toMatchObject({ address: f.email, subject: f.subject });
    const inbound = conv.messages[0];
    expect(inbound.body).toContain('received a small one');
    expect(inbound.body).toContain('Order number: DS-48213');
    expect(inbound.attachments.map((a: { filename: string }) => a.filename)).toEqual([
      'label.png',
      'receipt.txt',
    ]);
    const file = await t.app.inject({
      method: 'GET',
      url: `/api/v1/messages/${inbound.id}/attachments/1`,
      headers: { authorization: `Bearer ${admin}` },
    });
    expect(file.body).toBe('ORDER DS-48213');

    // The worker emails the reference; it is a system message, not a first response.
    const ack = await waitFor(async () => {
      const mails = await mailbox(f.email);
      return mails.find((m) => m.text?.includes(res.body.reference));
    }, 'acknowledgement email');
    expect(ack.subject).toBe(`Re: ${f.subject} [${res.body.reference}]`);
    expect(ack.text).toContain('Hi Lena,');
    const after = (await conversationsOf(ticket!.id))[0];
    const system = after.messages.find((m: { authorType: string }) => m.authorType === 'system');
    expect(system.deliveryStatus).toBe('sent');
    const fresh = (await t.call('GET', `/tickets/${ticket!.id}`, { token: admin })).body;
    expect(fresh.firstResponseAt).toBeNull();

    // A retried event doesn't send it twice.
    await worker.get(OutboundService, { strict: false }).acknowledgeWebForm(conv.id, inbound.id);
    expect((await mailbox(f.email)).filter((m) => m.text?.includes('Your reference'))).toHaveLength(
      1,
    );

    // The customer answers the acknowledgement: same ticket, same conversation.
    await smtp.sendMail({
      from: { name: 'Lena Fischer', address: f.email },
      to: TEST_MAIL.support,
      subject: ack.subject,
      inReplyTo: ack.messageId,
      references: [ack.messageId!],
      text: 'Here is a photo of the size label as well.',
    });
    await waitFor(async () => {
      await worker.get(EmailPollerService, { strict: false }).poll();
      const convs = await conversationsOf(ticket!.id);
      return (
        convs.length === 1 &&
        convs[0].messages.some((m: { body: string }) => m.body.includes('photo of the size label'))
      );
    }, 'customer reply on the web-form conversation');
    expect(await ticketFor(f.subject)).toHaveLength(1);

    // An agent's reply goes out by email with the ticket tag.
    const reply = await t.call('POST', `/conversations/${conv.id}/messages`, {
      token: admin,
      body: { body: 'Thanks Lena, a medium is on its way.' },
    });
    expect(reply.status).toBe(201);
    const answer = await waitFor(async () => {
      const mails = await mailbox(f.email);
      return mails.find((m) => m.text?.includes('a medium is on its way'));
    }, 'agent reply by email');
    expect(answer.subject).toBe(`Re: ${f.subject} [${res.body.reference}]`);
  });

  it('never opens two tickets for one submission', async () => {
    const f = form();
    const first = await submit(f);
    const again = await submit(f);
    expect(again.status).toBe(201);
    expect(again.body.reference).toBe(first.body.reference);
    expect(await ticketFor(f.subject)).toHaveLength(1);
  });

  it('accepts JSON without files', async () => {
    const f = form();
    const res = await t.call('POST', '/public/requests', { body: f });
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^TMS-\d+$/);
  });

  it('rejects invalid submissions with field messages', async () => {
    const bad = await submit(form({ email: 'not-an-email', description: 'short' }));
    expect(bad.status).toBe(400);
    expect(bad.body.issues).toEqual(
      expect.arrayContaining([
        { path: 'email', message: 'Enter a valid email address' },
        { path: 'description', message: 'Describe the problem in a few words' },
      ]),
    );

    expect((await submit(form({ website: 'http://spam.example' }))).status).toBe(400);
    const topic = await submit(form({ categoryId: randomUUID() }));
    expect(topic.status).toBe(400);
    expect(topic.body.message).toBe('Unknown topic');

    const tiny = { filename: 'a.txt', contentType: 'text/plain', content: Buffer.from('a') };
    const tooMany = await submit(form(), [tiny, tiny, tiny, tiny]);
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toBe('Attach at most 3 files');
  });

  it('rejects files over 10 MB', async () => {
    const big = {
      filename: 'video.mov',
      contentType: 'video/quicktime',
      content: Buffer.alloc(10 * 1024 * 1024 + 1),
    };
    const f = form();
    const res = await submit(f, [big]);
    expect(res.status).toBe(413);
    expect(await ticketFor(f.subject)).toHaveLength(0);
  });
});

describe('branding (ADR 0026)', () => {
  const defaults = {
    companyName: 'Demo Store',
    supportName: 'Support',
    helpCenterNote: 'Demo Store is a fictional shop used to demonstrate TMS.',
    referenceLabel: 'Order number',
  };
  const publicBranding = async () => (await t.call('GET', '/public/request-form')).body.branding;
  const firstMessage = async (subject: string) => {
    const [ticket] = await ticketFor(subject);
    return (await conversationsOf(ticket!.id))[0]!.messages[0]!.body as string;
  };

  afterAll(async () => {
    await t.call('PUT', '/settings/branding', { token: admin, body: {} });
  });

  it('is the sample shop until someone says otherwise', async () => {
    expect((await t.call('GET', '/settings/branding', { token: admin })).body).toEqual(defaults);
    expect(await publicBranding()).toEqual(defaults);
  });

  it('names the company in the help center and the reference field on the form', async () => {
    const saved = await t.call('PUT', '/settings/branding', {
      token: admin,
      body: {
        companyName: 'Ethnic Threads',
        supportName: 'Ethnic Threads Care',
        helpCenterNote: '',
        referenceLabel: 'Listing',
      },
    });
    expect(saved.status).toBe(200);
    expect(await publicBranding()).toEqual({
      companyName: 'Ethnic Threads',
      supportName: 'Ethnic Threads Care',
      helpCenterNote: '',
      referenceLabel: 'Listing',
    });

    const f = form({ orderNumber: 'MYN-48213' });
    expect((await t.call('POST', '/public/requests', { body: f })).status).toBe(201);
    expect(await firstMessage(f.subject)).toBe(`${f.description}\n\nListing: MYN-48213`);
  });

  it('hides the reference field when it has no label', async () => {
    const saved = await t.call('PUT', '/settings/branding', {
      token: admin,
      body: { companyName: 'Ethnic Threads', referenceLabel: '' },
    });
    expect(saved.body.referenceLabel).toBeNull();
    expect((await publicBranding()).referenceLabel).toBeNull();
    // A page that still sends one is not refused.
    const f = form({ orderNumber: 'MYN-1' });
    expect((await t.call('POST', '/public/requests', { body: f })).status).toBe(201);
    expect(await firstMessage(f.subject)).toBe(`${f.description}\n\nReference: MYN-1`);
  });

  it('is changed by people who manage channels, and checked', async () => {
    const agent = await makeUser(t, admin, 'agent');
    for (const method of ['GET', 'PUT'] as const) {
      const res = await t.call(method, '/settings/branding', { token: agent.token, body: {} });
      expect(res.status).toBe(403);
    }
    const bad = await t.call('PUT', '/settings/branding', {
      token: admin,
      body: { companyName: '' },
    });
    expect(bad.status).toBe(400);
  });
});
