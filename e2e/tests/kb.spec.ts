import { call, findTicket, login } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

async function openKb(page: import('@playwright/test').Page) {
  await page.getByRole('link', { name: 'Knowledge base' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Answers, with sources' }),
  ).toBeVisible();
}

async function deleteDocsTitled(title: string) {
  const admin = (await login()).accessToken;
  const docs = await call<Array<{ id: string; title: string }>>(
    admin,
    'GET',
    `/kb/documents?q=${encodeURIComponent(title)}`,
  );
  for (const d of docs.filter((x) => x.title === title))
    await call(admin, 'DELETE', `/kb/documents/${d.id}`);
}

test.describe('knowledge base', () => {
  test('an agent searches approved documents and gets cited answers', async ({ page }) => {
    await signInOrbit(page, AGENTS.jonah.email, SAMPLE_PASSWORD);
    await openKb(page);
    await expect(page.getByRole('button', { name: 'Add document' })).toHaveCount(0);

    // Drafts are not listed for agents.
    const docs = page.getByRole('table');
    await expect(docs.getByText('Returns and refunds policy')).toBeVisible();
    await expect(docs.getByText('Monsoon delivery delays (draft)')).toHaveCount(0);

    await page.getByLabel('Search the knowledge base').fill('when will my refund reach my card');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const results = page.getByRole('list', { name: 'Knowledge base results' });
    // Top-five retrieval (the recall@5 standard); exact ranking depends on the embedding model.
    const refund = results.getByRole('listitem').filter({ hasText: 'Refund timing' }).first();
    await expect(refund).toContainText('Returns and refunds policy');
    await expect(refund).toContainText(/% similar/);
  });

  test('a supervisor adds an FAQ entry, approves it, and search finds it', async ({ page }) => {
    const question = `Do you deliver to lighthouse islands? ${Date.now().toString(36)}`;
    try {
      await signInOrbit(page, AGENTS.priya.email, SAMPLE_PASSWORD);
      await openKb(page);
      await page.getByRole('button', { name: 'Add document' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: 'FAQ entry' }).click();
      await dialog.getByLabel('Question').fill(question);
      await dialog
        .getByLabel('Answer')
        .fill('Yes: lighthouse islands get a boat delivery every second Tuesday.');
      await dialog.locator('#kb-visibility').selectOption('public');
      await dialog.getByRole('button', { name: 'Add as draft' }).click();

      const row = page.getByRole('row', { name: new RegExp(question.replace(/[?]/g, '\\?')) });
      await expect(row).toContainText('Draft');
      await expect(row).toContainText('Indexed · 1 chunk', { timeout: 20_000 });
      await row.getByRole('button', { name: 'Approve' }).click();
      await expect(row).toContainText('Approved');

      await page.getByLabel('Search the knowledge base').fill('boat delivery lighthouse islands');
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(
        page.getByRole('list', { name: 'Knowledge base results' }).getByRole('listitem').first(),
      ).toContainText(question);
    } finally {
      await deleteDocsTitled(question);
    }
  });

  test('an uploaded Markdown file takes its title from its first heading', async ({ page }) => {
    const heading = `Cargo bike care guide ${Date.now().toString(36)}`;
    try {
      await signInOrbit(page, AGENTS.priya.email, SAMPLE_PASSWORD);
      await openKb(page);
      await page.getByRole('button', { name: 'Add document' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('File').setInputFiles({
        name: 'care.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(`# ${heading}\n\n## Chains\n\nOil the chain every 300 km.\n`),
      });
      await dialog.getByRole('button', { name: 'Add as draft' }).click();
      await expect(page.getByRole('row', { name: new RegExp(heading) })).toContainText(
        'Indexed · 1 chunk',
        {
          timeout: 20_000,
        },
      );
    } finally {
      await deleteDocsTitled(heading);
    }
  });

  test('the ticket drawer suggests articles and inserts a cited answer into the reply', async ({
    page,
  }) => {
    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Charged three times for order 55120');
    await signInOrbit(page);
    const drawer = await openTicket(page, t.reference);
    const kb = drawer.getByRole('region', { name: 'Knowledge base' });
    await expect(kb.getByLabel('Search the knowledge base')).toHaveValue(t.subject);
    await kb.getByLabel('Search the knowledge base').fill('charged twice duplicate charge refund');
    await kb.getByRole('button', { name: 'Search', exact: true }).click();
    const hit = kb.getByRole('listitem').filter({ hasText: 'Billing and payments FAQ' }).first();
    await expect(hit).toBeVisible();
    await hit.getByRole('button', { name: 'Insert in reply' }).click();
    await expect(drawer.locator('#composer')).toHaveValue(/\(Source: Billing and payments FAQ/);
  });

  test('fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInOrbit(page, AGENTS.priya.email, SAMPLE_PASSWORD);
    await page.goto(`${env.orbit}/#/kb`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Answers, with sources' }),
    ).toBeVisible();
    await page.getByLabel('Search the knowledge base').fill('delivery');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Knowledge base results' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
