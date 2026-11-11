// Browser-only coverage for the executor the normal mock dispatch cannot produce.
// These hand-written reports are Demo data, not evidence of a microVM execution.
// The API's actual executor filtering is covered by run-reports-list.test.ts.
import assert from 'node:assert/strict';

const reports = [
  {
    runRef: 'browser-fixture-microvm', workItemId: 'wi-auth-e2-s2', initiativeId: 'p-auth-migration',
    executor: 'microvm', startedAt: null, endedAt: '2026-11-11T10:00:00.000Z',
    outcome: 'done', failureCode: null, summary: 'Demo: checked the tenant cutover checklist.',
    changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
    runbooksOffered: [], runbooksUsed: [], selfReport: 'ok',
    cost: { billedUsd: null, reportedUsd: null, basis: 'simulated' },
  },
  {
    runRef: 'browser-fixture-local', workItemId: 'wi-obs-e2-s3', initiativeId: 'p-observability',
    executor: 'local', startedAt: null, endedAt: '2026-11-11T09:00:00.000Z',
    outcome: 'done', failureCode: null, summary: 'Demo: checked the error-budget dashboard.',
    changes: { files: [], changeRequestId: null }, verification: [], obstacles: [],
    runbooksOffered: [], runbooksUsed: [], selfReport: 'ok',
    cost: { billedUsd: null, reportedUsd: null, basis: 'simulated' },
  },
];

export async function verifyMicrovmFilter(page, portal, screenshot) {
  const endpoint = /\/api\/run-reports(?:\?|$)/;
  const fixture = async (route) => {
    const executor = new URL(route.request().url()).searchParams.get('executor');
    await route.fulfill({ json: { reports: executor === 'microvm' ? [reports[0]] : reports, next: null } });
  };
  await page.route(endpoint, fixture);
  try {
    await page.goto(`${portal}/iq/runs?outcome=done`, { waitUntil: 'domcontentloaded' });
    const rows = page.getByTestId('run-row-link');
    const local = page.locator('a[data-testid="run-row-link"][href$="browser-fixture-local"]');
    await local.waitFor({ state: 'visible' });
    await page.getByRole('button', { name: /^Filters(?: \(\d+ active\))?$/ }).click();
    await page.getByRole('combobox', { name: 'Ran on', exact: true }).click();
    await page.getByRole('option', { name: 'MicroVM', exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('executor') === 'microvm');
    assert.equal(new URL(page.url()).searchParams.get('outcome'), 'done', 'choosing an executor keeps the outcome filter');
    await local.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    assert.equal(await rows.count(), 1, 'only the microVM report remains');
    assert.equal(await rows.first().getAttribute('href'), '/iq/runs/browser-fixture-microvm');
    const table = page.getByTestId('iq-runs-table');
    assert.match(await table.innerText(), /MicroVM/);
    assert.match(await table.innerText(), /Demo data/);
    await screenshot(page, 'r4-microvm-browser-fixture');

    // Reload exercises URL initialization as well as changing the visible control.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('a[data-testid="run-row-link"][href$="browser-fixture-microvm"]').waitFor({ state: 'visible' });
    assert.equal(await local.count(), 0, 'reload keeps the executor filter');
    await page.getByRole('button', { name: /^Filters(?: \(\d+ active\))?$/ }).click();
    await page.getByRole('combobox', { name: 'Ran on', exact: true }).click();
    await page.getByRole('option', { name: 'All', exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has('executor'));
    await local.waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).searchParams.get('outcome'), 'done', 'clearing the executor keeps the outcome filter');
  } finally {
    await page.unroute(endpoint, fixture);
  }
}
