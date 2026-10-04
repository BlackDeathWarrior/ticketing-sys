import { call, login } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

const stamp = () => Date.now().toString(36);

/** The stand-in site page, set up for one integration. */
function sitePage(params: Record<string, string>): string {
  const url = new URL(env.widgetSite);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

test.describe("the chat widget on an integration's site", () => {
  test('carries the site’s look, tells the page about the ticket, and is the integration’s ticket', async ({
    browser,
    page,
  }) => {
    const admin = (await login()).accessToken;
    const name = `Acme Store ${stamp()}`;
    const slug = `site-${stamp()}`;
    const integration = await call<{ id: string }>(admin, 'POST', '/integrations', { slug, name });
    const { key } = await call<{ key: string }>(
      admin,
      'POST',
      `/integrations/${integration.id}/keys`,
      { name: 'Backend', scopes: ['integration:ticket'] },
    );

    // Settings shows the snippet the site pastes.
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/integrations`);
    await page
      .getByRole('row', { name: new RegExp(name) })
      .getByRole('button', { name: 'Keys and webhooks' })
      .click();
    const card = page.getByRole('region', { name: `Chat widget of ${name}` });
    await expect(card.getByTestId('widget-snippet')).toContainText(`integration: '${slug}'`);
    await expect(card.getByTestId('widget-snippet')).toContainText('/widget/tms-chat.js');
    await expect(card).toContainText('No secret yet: every visitor is anonymous.');

    // A visitor on the site: its wording and colour, no name form (the site named them).
    const visitor = await browser.newPage();
    const text = `Is this kurta available in medium? (${stamp()})`;
    await visitor.goto(
      sitePage({ integration: slug, name: 'Asha Verma', product: 'MYN-48213', primary: '#7a1f3d' }),
    );
    const launcher = visitor.getByRole('button', { name: 'Need help?' });
    await expect(launcher).toHaveCSS('background-color', 'rgb(122, 31, 61)');
    await launcher.click();
    const panel = visitor.getByRole('dialog', { name: 'Ask us' });
    await panel.getByLabel('Message').fill(text);
    await panel.getByRole('button', { name: 'Send' }).click();

    // The page's own callback got the ticket reference.
    await expect(visitor.locator('#ticket')).toHaveText(/^TMS-\d+$/);
    const reference = (await visitor.locator('#ticket').textContent())!;

    // An agent sees where it came from and what was on screen, and answers.
    await page.goto(env.orbit);
    const drawer = await openTicket(page, reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText(`Context from ${name}`);
    await expect(context).toContainText('MYN-48213');
    const reply = `Yes, medium is in stock. (${stamp()})`;
    await drawer.getByLabel(/^Reply/).fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    await expect(panel).toContainText(reply);
    await expect(visitor.locator('#replies')).not.toHaveText('0');

    // The site's backend reads the same conversation with its key.
    const res = await fetch(`${env.api}/api/v1/integration/tickets/${reference}/messages`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const messages = (await res.json()) as Array<{ from: string; body: string }>;
    expect(messages.map((m) => m.body)).toEqual(expect.arrayContaining([text, reply]));
    await visitor.close();
  });
});
