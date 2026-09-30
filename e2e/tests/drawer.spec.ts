import {
  call,
  customerByEmail,
  eventually,
  login,
  mailpitSearch,
  mailpitText,
  type TicketRow,
  userByEmail,
} from './api';
import { AGENTS } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/** A fresh ticket per run, so the drawer tests never depend on earlier runs. */
async function freshTicket() {
  const admin = (await login()).accessToken;
  const hana = await customerByEmail(admin, 'hana.ito@atlasfreight.example.com');
  const leo = await userByEmail(admin, AGENTS.leo.email);
  const subject = `Pallet labels print upside down ${Date.now().toString(36)}`;
  const ticket = await call<TicketRow>(admin, 'POST', '/tickets', {
    customerId: hana.id,
    subject,
    description:
      'Every shipping label from the Rotterdam depot prints upside down since the driver update.',
    priority: 'normal',
    channel: 'email',
    tags: ['labels'],
  });
  await call(admin, 'POST', `/tickets/${ticket.id}/assign`, { assigneeId: leo.id });
  return { admin, ticket, subject };
}

test.describe('Orbit Desk ticket drawer', () => {
  test('shows the ticket, only allowed transitions, and the conversation', async ({ page }) => {
    const { ticket, subject } = await freshTicket();
    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);

    await expect(drawer.getByRole('heading', { name: subject })).toBeVisible();
    await expect(drawer.getByText('Atlas Freight Co.')).toBeVisible();
    await expect(drawer.getByText('#labels')).toBeVisible();
    await expect(drawer.getByText('prints upside down since the driver update')).toBeVisible();

    // human_assigned → in_progress, ai_handling, pending_customer, resolved (default workflow).
    const status = drawer.getByRole('radiogroup', { name: 'Status' });
    await expect(status.getByRole('radio')).toHaveText([
      'Human Assigned',
      'AI Handling',
      'In Progress',
      'Pending Customer',
      'Resolved',
    ]);
    await expect(status.getByRole('radio', { name: 'Human Assigned' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(status.getByRole('radio', { name: 'Closed' })).toHaveCount(0);
    await expect(status.getByRole('radio', { name: 'New' })).toHaveCount(0);
    await expect(drawer.getByLabel('Assignee')).toHaveValue(/.+/);
  });

  test('adds a note, changes status, priority and assignee', async ({ page }) => {
    const { admin, ticket } = await freshTicket();
    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);

    await drawer.getByRole('tab', { name: 'Internal note' }).click();
    const note = `@Leo check driver version on depot PCs (${Date.now().toString(36)})`;
    await drawer.getByLabel('Internal note').fill(note);
    await drawer.getByRole('button', { name: 'Add note' }).click();
    const noteItem = drawer.locator('li[data-kind="note"]', { hasText: note });
    await expect(noteItem).toContainText('Internal note');
    await expect(noteItem).toContainText('Administrator');

    await drawer.getByRole('radio', { name: 'In Progress' }).click();
    await expect(drawer.getByRole('radio', { name: 'In Progress' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // In Progress allows going back to Human Assigned but not AI Handling.
    await expect(drawer.getByRole('radio', { name: 'AI Handling' })).toHaveCount(0);

    await drawer.getByLabel('Priority').selectOption('urgent');
    await expect(drawer.getByLabel('Priority')).toHaveValue('urgent');

    const sam = await userByEmail(admin, AGENTS.sam.email);
    await drawer.getByLabel('Assignee').selectOption(sam.id);
    await expect(drawer.getByLabel('Assignee')).toHaveValue(sam.id);

    const saved = await call<TicketRow>(admin, 'GET', `/tickets/${ticket.id}`);
    expect(saved).toMatchObject({
      status: 'in_progress',
      priority: 'urgent',
      assignee: { id: sam.id },
    });
    const notes = await call<Array<{ body: string }>>(admin, 'GET', `/tickets/${ticket.id}/notes`);
    expect(notes.map((n) => n.body)).toContain(note);

    // The queue row reflects the change.
    await page.keyboard.press('Escape');
    const row = page.locator(`tr[data-ticket="${ticket.reference}"]`);
    await expect(row).toContainText('In Progress');
    await expect(row).toContainText('Urgent');
    await expect(row).toContainText('Sam');
  });

  test('a reply is emailed to the customer and shown as delivered', async ({ page }) => {
    const { ticket } = await freshTicket();
    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);

    const reply = `Hi Hana, please roll back the label driver to 4.2 while we fix this. (${Date.now().toString(36)})`;
    await drawer.getByLabel('Reply to Hana Ito').fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    const sent = drawer.locator('li[data-kind="agent"]', { hasText: reply });
    await expect(sent).toBeVisible();
    // Delivery happens in the worker; the "pending" label clears once it's sent.
    await expect(sent).not.toContainText('pending', { timeout: 30_000 });

    const mail = await eventually('reply in Mailpit', async () => {
      const hits = await mailpitSearch(`subject:"[${ticket.reference}]"`);
      return hits.find((m) => m.To.some((t) => t.Address === 'hana.ito@atlasfreight.example.com'));
    });
    expect(mail.Subject).toContain(`[${ticket.reference}]`);
    expect(await mailpitText(mail.ID)).toContain('roll back the label driver');
  });
});
