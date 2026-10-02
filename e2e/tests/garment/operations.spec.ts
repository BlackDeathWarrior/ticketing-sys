import { call, login, raw } from '../api';
import { env } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  appEnv,
  garment,
  newShopper,
  openChat,
  registerShopper,
  signInAdmin,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
  waitFor,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

interface IncidentRow {
  fingerprint: string;
  title: string;
  status: string;
  occurrences: number;
  ticket: string | null;
}
interface StaffTicket {
  id: string;
  reference: string;
  status: string;
  priority: string;
  tags: string[];
  slaState: string | null;
  handling: string;
  team: { name: string } | null;
}

/** The app's open incidents, read with the key its worker reports them with. */
async function openIncidents(): Promise<IncidentRow[]> {
  const res = await fetch(`${env.api}/api/v1/integration/incidents?status=open&limit=50`, {
    headers: { authorization: `Bearer ${appEnv().SUPPORT_API_KEY_EVENTS}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as IncidentRow[];
}

test.describe('Ethnic Threads: what the app reports about itself', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('the stale catalogue is an incident, routed to the team that runs the scraper', async ({
    browser,
    page,
  }) => {
    // Nobody posted this: the worker noticed, on boot, that its newest listing is months old.
    const stale = await waitFor('the stale catalogue incident', async () =>
      (await openIncidents()).find((i) => i.fingerprint === 'catalog.stale'),
    );
    expect(stale.title).toMatch(/^Catalogue is [\d.]+ days old$/);

    const admin = (await login()).accessToken;
    const ticket = await call<StaffTicket>(admin, 'GET', `/tickets/${stale.ticket}`);
    expect(ticket.tags).toContain('incident');
    expect(ticket.team?.name).toBe('Site Reliability');
    // Nobody is asked to answer a machine: the AI stays out of it.
    expect(ticket.handling).not.toBe('ai');

    await signInOrbit(page);
    const drawer = await openTicket(page, stale.ticket!);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Incident reported by Ethnic Threads');
    await expect(context).toContainText('catalog.stale');

    // The app's admin sees it on the storefront too.
    const site = await browser.newPage();
    await signInAdmin(site);
    const incidents = site.getByLabel('Open incidents');
    await expect(incidents).toContainText(stale.title, { timeout: 20_000 });
    await expect(incidents).toContainText(stale.ticket!);
    await site.close();
  });

  test('a scrape that fails opens one ticket, however often it fails', async ({
    browser,
    page,
  }) => {
    const status = (await (await fetch(`${garment.worker}/api/scrape-status`)).json()) as {
      sources: string;
    };
    test.skip(
      status.sources !== 'notasource',
      'Start the app worker with -Sources notasource, so a run fails without visiting a store',
    );
    const before = (await openIncidents()).find((i) => i.fingerprint === 'scraper.run_failed');

    // The admin starts a scrape from the storefront, twice. Each run really exits with code 1.
    const site = await browser.newPage();
    await signInAdmin(site);
    const start = site.getByRole('button', { name: /Refresh All Inventory|Restart Scraper/ });
    for (let run = 1; run <= 2; run++) {
      const count = (before?.occurrences ?? 0) + run;
      await expect(start).toBeEnabled({ timeout: 20_000 });
      await start.click();
      await waitFor(`run ${run} to be counted`, async () => {
        const now = (await openIncidents()).find((i) => i.fingerprint === 'scraper.run_failed');
        return now && now.occurrences >= count ? now : undefined;
      });
    }
    const incident = (await openIncidents()).find((i) => i.fingerprint === 'scraper.run_failed')!;
    expect(incident.title).toBe('Scraper run failed (exit code 1)');
    // One ticket for all of them.
    expect(incident.ticket).toBe(before?.ticket ?? incident.ticket);

    const panel = site.getByLabel('Open incidents');
    await expect(panel).toContainText('Scraper run failed (exit code 1)', { timeout: 20_000 });
    await expect(panel).toContainText(new RegExp(`Reported ${incident.occurrences} times`), {
      timeout: 20_000,
    });

    await signInOrbit(page);
    const drawer = await openTicket(page, incident.ticket!);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context.getByRole('list', { name: 'Incident reports' })).toContainText(
      `reported ${incident.occurrences} times`,
    );
    // What the scraper printed as it failed came with the report.
    await expect(drawer).toContainText("No valid sources in 'notasource'");
    await site.close();
  });

  test('a test delivery from Settings reaches the app, signed', async ({ browser, page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/integrations`);
    await page
      .getByRole('row', { name: /ethnic-threads/ })
      .getByRole('button', { name: 'Keys and webhooks' })
      .click();
    const card = page.getByRole('region', { name: 'Webhooks of Ethnic Threads' });
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(card.getByRole('status')).toContainText('The test was delivered');

    // The worker verified the signature and stored it; a forged one is refused.
    const site = await browser.newPage();
    await signInAdmin(site);
    await expect(site.getByLabel('Support desk activity')).toContainText('Test delivery', {
      timeout: 20_000,
    });
    const forged = await fetch(`${garment.worker}/api/support/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tms-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
      },
      body: JSON.stringify({ id: `forged-${stamp()}`, type: 'ticket.created', data: {} }),
    });
    expect(forged.status).toBe(401);

    await card.getByRole('button', { name: 'Deliveries' }).click();
    const log = card.getByRole('region', { name: 'Deliveries' });
    await expect(log.getByRole('row', { name: /Delivered/ }).first()).toBeVisible();
    await site.close();
  });

  test('keys are limited to their job, their rate, and can be switched off at once', async () => {
    const settings = appEnv();
    const ticketsWith = (key: string) =>
      fetch(`${env.api}/api/v1/integration/tickets?limit=1`, {
        headers: { authorization: `Bearer ${key}` },
      });

    // The worker's key reports incidents; it cannot read shoppers' tickets.
    expect((await ticketsWith(settings.SUPPORT_API_KEY_EVENTS!)).status).toBe(403);
    expect((await ticketsWith(settings.SUPPORT_API_KEY_WEB!)).status).toBe(200);
    // A staff route refuses any key.
    const staff = await fetch(`${env.api}/api/v1/tickets?limit=1`, {
      headers: { authorization: `Bearer ${settings.SUPPORT_API_KEY_WEB}` },
    });
    expect(staff.status).toBe(403);

    // A key of its own, so this can run again: five calls a minute, then no more.
    const admin = (await login()).accessToken;
    const integrations = await call<Array<{ id: string; slug: string }>>(
      admin,
      'GET',
      '/integrations',
    );
    const id = integrations.find((i) => i.slug === 'ethnic-threads')!.id;
    const made = await call<{ id: string; key: string }>(
      admin,
      'POST',
      `/integrations/${id}/keys`,
      {
        name: `E2E limited ${stamp()}`,
        scopes: ['integration:ticket'],
        rateLimitPerMinute: 5,
      },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await ticketsWith(made.key)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const revoked = await raw(admin, 'POST', `/integrations/keys/${made.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await ticketsWith(made.key)).status).toBe(401);
  });

  test('an urgent chat that asks for a person breaches its two-minute answer time', async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);
    const panel = await openChat(site);
    await panel
      .getByLabel('Message')
      .fill('This is urgent: I want to talk to a real person about a wrong price, please.');
    await panel.getByRole('button', { name: 'Send' }).click();

    const admin = (await login()).accessToken;
    const ticket = await waitFor('the handed-over ticket', async () => {
      const found = await call<{
        items: Array<StaffTicket & { customer: { displayName: string } }>;
      }>(admin, 'GET', '/tickets?channel=webchat&limit=50');
      const mine = found.items.find((t) => t.customer.displayName === shopper.name);
      return mine?.handling === 'handed_over' ? mine : undefined;
    });
    // The shopper is told a person will answer.
    await expect(panel.locator('.msg').last()).toBeVisible();

    // Nobody answers: the urgent policy gives two minutes.
    const late = await waitFor(
      'the answer time to be breached',
      async () => {
        const now = await call<StaffTicket>(admin, 'GET', `/tickets/${ticket.id}`);
        return now.slaState === 'breached' ? now : undefined;
      },
      200_000,
    );
    expect(late.priority).toBe('urgent');

    await signInOrbit(page);
    const drawer = await openTicket(page, late.reference);
    const sla = drawer.getByRole('region', { name: 'SLA' });
    await expect(sla).toContainText('First response');
    await expect(sla.locator('[data-state="breached"]').first()).toBeVisible();
    await site.close();
  });
});
