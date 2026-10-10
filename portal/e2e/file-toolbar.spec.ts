import { expect, test, type Page } from '@playwright/test';

async function mount(page: Page, tenant: 'orgiq' | 'assessment', dark = false) {
  const reads: string[] = [], writes: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() !== 'GET') writes.push(request.method() + ' ' + path); else reads.push(path);
    if (path === '/api/session/me') return route.fulfill({ json: { sub: 'inert-file-reviewer', name: 'Fixture Reviewer', tenant, role: 'member', grants: { [tenant]: ['member'] }, switchable: { [tenant]: ['member'] }, availableRoles: ['member'], availableTenants: [tenant], masquerading: null } });
    if (path === '/api/session/realtime-token') return route.fulfill({ json: { token: 'inert-file-review-token', expiresAt: '2099-10-10T12:00:00Z', platformApiUrl: 'http://127.0.0.1:5283/fixture-platform' } });
    if (path === '/fixture-platform/api/recordings') return route.fulfill({ json: { items: [], cursor: null } });
    if (path === '/api/initiative-decks') return route.fulfill({ json: [{ id: 'fixture-work-deck', projectId: 'p-observability', title: 'Observability review', updatedAt: '2026-10-10T12:00:00Z' }] });
    if (path === '/api/assessment/decks') return route.fulfill({ json: [{ id: 'fixture-assessment-deck', teamId: 'TEAM-005', title: 'Notification review', latestRevision: null, updatedAt: '2026-10-10T12:00:00Z' }] });
    if (path === '/api/assessment/knowledge/tree') return route.fulfill({ json: { sections: [{ key: 'fixture-docs', title: 'Shared Workspace', kind: 'synced', nodes: [{ id: 'fixture-rubric', title: 'Rubric overview', parent_id: null, is_dir: false, classification: 'document' }] }] } });
    return route.fulfill({ status: 404, json: { error: `Inert fixture has no ${path}` } });
  });
  await page.route('**/__file-toolbar**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/file-toolbar.tsx"></script></body></html>' }));
  await page.goto(`/__file-toolbar?tenant=${tenant}${dark ? '&theme=dark' : ''}`);
  return { reads, writes, errors };
}

test('Work icon controls keep native keyboard choice, tooltips, filtering and scoped refresh', async ({ page }) => {
  const proof = await mount(page, 'orgiq');
  const toolbar = page.getByTestId('initiative-files-toolbar');
  await expect(page.getByTestId('initiative-files-cards')).toBeVisible();
  const cards = toolbar.getByRole('radio', { name: 'Cards', exact: true });
  const list = toolbar.getByRole('radio', { name: 'List', exact: true });
  await expect(cards).toBeChecked();
  expect(await cards.textContent()).toBe('');
  await cards.focus();
  await expect(page.getByRole('tooltip', { name: 'Cards', exact: true })).toBeVisible();
  await cards.press('ArrowRight');
  await expect(list).toBeChecked();
  await expect(list).toBeFocused();
  await expect(page.getByTestId('initiative-files-list')).toBeVisible();
  await list.press('ArrowLeft');
  await expect(cards).toBeChecked();
  await toolbar.getByLabel('Search project files').fill('does-not-match');
  await expect(page.getByText('No matching files', { exact: true })).toBeVisible();
  await toolbar.getByLabel('Search project files').fill('');
  const refresh = toolbar.getByRole('button', { name: 'Refresh files', exact: true });
  await refresh.hover();
  await expect(page.getByRole('tooltip', { name: 'Refresh files', exact: true })).toBeVisible();
  const before = proof.reads.filter(path => path === '/api/initiative-decks').length;
  await refresh.click();
  await expect.poll(() => proof.reads.filter(path => path === '/api/initiative-decks').length).toBeGreaterThan(before);
  await expect(refresh).toBeEnabled();
  await expect(toolbar.getByRole('button', { name: 'Open workspace' })).toHaveText('Workspace');
  await page.mouse.move(0, 0); await refresh.blur(); await cards.blur();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('work-file-toolbar.png'), fullPage: true });
  await toolbar.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('/iq/workspace');
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

test('Assessment uses the shared themed controls without dropping native document and presentation readers', async ({ page }) => {
  const proof = await mount(page, 'assessment');
  const toolbar = page.getByTestId('document-list-controls');
  await expect(page.getByTestId('document-result-list')).toBeVisible();
  await toolbar.getByRole('radio', { name: 'Cards', exact: true }).click();
  await expect(page.getByTestId('document-result-cards')).toBeVisible();
  await expect(page.getByTestId('document-file-card')).toHaveCount(2);
  await toolbar.getByLabel('Search documents').fill('Rubric');
  await expect(page.getByTestId('document-file-card')).toHaveCount(1);
  await toolbar.getByLabel('Search documents').fill('');
  const refresh = toolbar.getByRole('button', { name: 'Refresh files', exact: true });
  const before = proof.reads.filter(path => path === '/api/assessment/knowledge/tree').length;
  await refresh.click();
  await expect.poll(() => proof.reads.filter(path => path === '/api/assessment/knowledge/tree').length).toBeGreaterThan(before);
  await expect(refresh).toBeEnabled();
  await expect.poll(() => toolbar.getByRole('radio', { name: 'Cards', exact: true }).evaluate(node => getComputedStyle(node).color)).toBe('rgb(11, 102, 102)');
  await refresh.blur(); await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('assessment-file-toolbar.png'), fullPage: true });
  await toolbar.getByRole('button', { name: 'Open workspace' }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('/assessment/workspace?view=library');
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

test('compact and dark file toolbars wrap without horizontal overflow and keep focus visible', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 740 });
  const proof = await mount(page, 'orgiq', true);
  const toolbar = page.getByTestId('initiative-files-toolbar');
  await expect(toolbar.getByRole('button', { name: 'Refresh files', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(420);
  await toolbar.getByRole('radio', { name: 'Cards', exact: true }).focus();
  await toolbar.getByRole('radio', { name: 'Cards', exact: true }).press('ArrowRight');
  await expect(toolbar.getByRole('radio', { name: 'List', exact: true })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('dark-compact-file-toolbar.png'), fullPage: true });
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});
