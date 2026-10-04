import { call, login } from './api';
import { expect, openTicket, signInOrbit, test } from './fixtures';

const stamp = () => Date.now().toString(36);

interface Report {
  action: string;
  incident: { ticket: string; occurrences: number };
}

test.describe('incidents an app reports', () => {
  test('repeated failures share one ticket, which closes itself on recovery', async ({ page }) => {
    const admin = (await login()).accessToken;
    const name = `Acme Store ${stamp()}`;
    const integration = await call<{ id: string }>(admin, 'POST', '/integrations', {
      slug: `worker-${stamp()}`,
      name,
    });
    const { key } = await call<{ key: string }>(
      admin,
      'POST',
      `/integrations/${integration.id}/keys`,
      { name: 'Worker', scopes: ['integration:event'] },
    );
    const report = (body: Record<string, unknown>) =>
      call<Report>(key, 'POST', '/integration/events', body);

    // The scraper fails three times in a row.
    const fingerprint = `scraper.run_failed:${stamp()}`;
    const failure = {
      fingerprint,
      title: 'Scraper exited with code 1',
      severity: 'error',
      source: 'scraper/worker',
      details: { exit_code: 1 },
    };
    const first = await report(failure);
    expect(first.action).toBe('opened');
    await report(failure);
    const third = await report({ ...failure, message: 'Unknown source: notasource' });
    expect(third).toMatchObject({
      action: 'updated',
      incident: { ticket: first.incident.ticket, occurrences: 3 },
    });

    // One ticket in the queue, saying what it is and how often it happened.
    await signInOrbit(page);
    const drawer = await openTicket(page, first.incident.ticket);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText(`Incident reported by ${name}`);
    await expect(context.getByRole('list', { name: 'Incident reports' })).toContainText(
      'Still happening · reported 3 times',
    );
    await expect(context).toContainText(fingerprint);
    await expect(context).toContainText('scraper/worker');
    await expect(drawer).toContainText('Reported again: 2 times');

    // The next run succeeds: the app says so, and the ticket nobody had taken is resolved.
    const recovery = await report({
      fingerprint,
      status: 'resolved',
      message: 'Scrape finished with 5 products.',
    });
    expect(recovery.action).toBe('resolved');
    await expect(context.getByRole('list', { name: 'Incident reports' })).toContainText(
      'Recovered just now · reported 3 times',
    );
    await expect(drawer).toContainText(`${name} reported that this has recovered (3 reports).`);
    await expect(drawer.getByRole('radio', { name: 'Resolved' })).toBeChecked();
  });
});
