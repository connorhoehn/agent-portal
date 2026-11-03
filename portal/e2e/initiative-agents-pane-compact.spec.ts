// The initiative header's tab panels and the Details pane after the 2026-11-02
// redesign (the user: a tab must not repeat its title as a heading in its
// panel; the pane is compact and does not repeat the header's status or the
// page's own Docs / Activity tabs). Runs as a clone; reads only.
import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

const OUT = '../.scratch/initiative-redesign-2026-11-02';
for (const theme of ['light', 'dark'] as const) test(`Agents tab and Details pane are compact and unrepeated (${theme})`, async ({ browser }) => {
  test.setTimeout(120_000);
  const person = await openAsClone(browser, 'u-release', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: `initiative-redesign-${theme}`,
    prepare: async context => { await context.addInitScript(t => { try { localStorage.setItem('theme', t); } catch {} }, theme); },
    url: '/iq/projects/p-auth-migration?scope=all&tab=agents' });
  const { page } = person;
  try {
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    const section = page.getByTestId('initiative-agents');
    await expect(section.getByTestId('initiative-agents-runs')).toBeVisible({ timeout: 20_000 });
    // No heading repeats the tab; the switches and the meta share one row above the table.
    await expect(section.getByRole('heading')).toHaveCount(0);
    const view = (await section.getByTestId('initiative-agents-view').boundingBox())!;
    const meta = (await section.getByTestId('initiative-agents-meta').boundingBox())!;
    const table = (await section.getByTestId('initiative-agents-runs').boundingBox())!;
    expect(Math.abs((meta.y + meta.height / 2) - (view.y + view.height / 2))).toBeLessThan(8);
    expect(table.y).toBeGreaterThan(view.y + view.height);
    await expect(section.getByTestId('initiative-agents-meta')).toContainText(/agent spend over \d+ runs? in the last 30 days/);
    await page.screenshot({ path: `${OUT}/agents-tab-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 520 } });

    // The Details pane: the initiative is its title, Details its tab.
    await page.getByTestId('initiative-details-trigger').click();
    await expect(page.getByTestId('initiative-pane-tab-details')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('page-conversation-pane-title')).toHaveText('Auth Migration');
    await expect(page.getByText('Initiative details', { exact: true })).toHaveCount(0);
    const details = page.getByTestId('initiative-pane-details');
    await expect(details).toBeVisible();
    await expect(details.getByTestId('initiative-facts')).not.toContainText('Status');
    await expect(details.getByTestId('initiative-facts')).toContainText('Owner');
    await expect(details.getByTestId('initiative-details-docs')).toHaveCount(0);
    await expect(details.getByTestId('initiative-details-activity')).toHaveCount(0);
    const action = details.getByTestId('initiative-details-action');
    await expect(action).toBeVisible();
    await expect(action.getByRole('button', { name: /^Open work item / })).toHaveCount(1);
    await expect(action.getByRole('button', { name: /^Open ORG-/ })).toHaveCount(0);
    const pane = (await page.getByTestId('initiative-pane').boundingBox())!;
    await page.screenshot({ path: `${OUT}/details-pane-${theme}.png`, clip: { x: pane.x, y: 0, width: pane.width, height: 700 } });
    expect(person.errors).toEqual([]);
  } finally { await person.close(); }
});
