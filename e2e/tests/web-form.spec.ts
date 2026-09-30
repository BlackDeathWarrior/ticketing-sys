import { call, eventually, login, mailpitSearch, mailpitText, type TicketRow } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

test.describe('Help center request form', () => {
  test('a customer submits a request with a file; the agent sees it and replies by email', async ({
    browser,
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const email = `lena.${stamp}@example.org`;
    const subject = `Wrong size delivered ${stamp}`;

    const customer = await browser.newPage();
    await customer.goto(env.helpCenter);
    await expect(customer.getByRole('heading', { name: 'How can we help?' })).toBeVisible();
    // The chat widget is offered next to the form.
    await expect(customer.getByRole('button', { name: 'Start a chat' })).toBeVisible();

    const form = customer.getByRole('form', { name: 'Submit a request' });
    await form.getByLabel('Your name').fill('Lena Fischer');
    await form.getByLabel('Email').fill(email);
    await form.getByLabel('Topic').selectOption({ label: 'Orders' });
    await form.getByLabel('Order number').fill('DS-48213');
    await form.getByLabel('Subject').fill(subject);
    await form
      .getByLabel('How can we help?')
      .fill('I ordered a medium jacket and received a small one. Can I exchange it?');
    await form.locator('input[type="file"]').setInputFiles({
      name: 'size-label.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Label: S (ordered M)'),
    });
    await expect(form.getByText('size-label.txt')).toBeVisible();
    await form.getByRole('button', { name: 'Send request' }).click();

    await expect(customer.getByRole('heading', { name: 'Request received' })).toBeFocused();
    const reference = (await customer.locator('[data-reference]').textContent())!;
    expect(reference).toMatch(/^TMS-\d+$/);
    await expect(customer.getByText(email)).toBeVisible();

    // The acknowledgement email carries the reference.
    const ack = await eventually(
      'acknowledgement in Mailpit',
      async () =>
        (await mailpitSearch(`to:${email}`)).find((m) => m.Subject.includes(`[${reference}]`)),
      60_000,
    );
    expect(await mailpitText(ack.ID)).toContain(`Your reference is ${reference}`);
    await customer.close();

    // In Orbit Desk: filter the queue to web-form tickets, open it, see the file.
    await signInOrbit(page);
    await page.getByLabel('Channel').selectOption({ label: 'Web form' });
    await expect(page.locator('tr[data-ticket]', { hasText: subject })).toBeVisible();
    const drawer = await openTicket(page, reference);
    await expect(drawer.getByText('Web form', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Order number: DS-48213')).toBeVisible();
    const files = drawer.getByRole('list', { name: 'Attachments' });
    const download = page.waitForEvent('download');
    await files.getByRole('button', { name: /size-label\.txt/ }).click();
    expect((await download).suggestedFilename()).toBe('size-label.txt');

    const reply = `Hi Lena, a medium is on its way (${stamp}).`;
    await drawer.getByLabel('Reply to Lena Fischer').fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    const answer = await eventually('agent reply in Mailpit', async () => {
      for (const m of await mailpitSearch(`to:${email}`)) {
        if ((await mailpitText(m.ID)).includes('a medium is on its way')) return m;
      }
      return undefined;
    });
    expect(answer.Subject).toBe(`Re: ${subject} [${reference}]`);

    const admin = (await login()).accessToken;
    const [ticket] = (
      await call<{ items: TicketRow[] }>(admin, 'GET', `/tickets?q=${encodeURIComponent(subject)}`)
    ).items;
    expect(ticket).toMatchObject({ channel: 'web_form', reference });
  });

  test('explains what to fix, and fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(env.helpCenter);
    const form = page.getByRole('form', { name: 'Submit a request' });
    await form.getByLabel('Email').fill('not-an-email');
    await form.getByRole('button', { name: 'Send request' }).click();

    await expect(page.getByRole('alert')).toHaveText('Please correct the highlighted fields.');
    await expect(form.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByText('Enter a valid email address')).toBeVisible();
    await expect(form.getByText('Add a short subject')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });
});
