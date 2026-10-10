import { expect, test, type Page } from '@playwright/test';

const records = [
  { type: 'person', id: 'fixture-person', title: 'Fixture Reviewer', description: 'Maintains shared component contracts.', subtitle: 'Public role · Platform', href: '/iq/people/fixture-person' },
  { type: 'initiative', id: 'p-design-system-api', title: 'Design System API', description: 'Keep product components consistent.', subtitle: 'Project context', href: '/iq/projects/p-design-system-api', status: 'in_progress' },
  { type: 'work', id: 'fixture-work', title: 'Compact Search results', description: 'Verify selection and real navigation.', subtitle: 'Work context', href: '/iq/projects/p-design-system-api?tab=work&item=fixture-work', status: 'open' },
  { type: 'decision', id: 'fixture-decision', title: 'Use native Search controls', description: 'Preserve existing authorization and selection.', subtitle: 'Decision context', href: '/iq/projects/p-design-system-api?tab=decisions&decision=fixture-decision' },
  { type: 'knowledge', id: 'fixture-knowledge', title: 'Search component reference', description: 'A saved native component reference.', subtitle: 'Document context', href: '/iq/workspace?doc=fixture-knowledge' },
  { type: 'asset', id: 'fixture-asset', title: 'Search review workflow', description: 'Read-only library metadata.', subtitle: 'Library context', href: '/iq/agents?agent=fixture-asset' },
];
const counts = { all: records.length, person: 1, initiative: 1, work: 1, decision: 1, knowledge: 1, asset: 1 };
async function mount(page: Page, query = 'scope=p-design-system-api&offset=25') {
  const writes: string[] = [], reads: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/pages/InvokePage.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "export { default } from '/e2e/fixtures/search-presentation-runtime.tsx';" }));
  await page.route('**/src/pages/search/SearchComposer.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: "export { SearchComposer } from '/e2e/fixtures/search-presentation-runtime.tsx';" }));
  await page.route('**/api/**', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(`${request.method()} ${url.pathname}`);
    else reads.push(url.pathname);
    if (url.pathname === '/api/session/me') return route.fulfill({ json: { sub: 'fixture-search-reviewer', name: 'Fixture Reviewer', tenant: 'orgiq', role: 'member', grants: { orgiq: ['member'] }, switchable: { orgiq: ['member'] }, availableRoles: ['member'], availableTenants: ['orgiq'], masquerading: null } });
    if (url.pathname === '/api/search') {
      const kind = url.searchParams.get('type') ?? 'all', filtered = kind === 'all' ? records : records.filter(row => row.type === kind);
      return route.fulfill({ json: { query: url.searchParams.get('q') ?? '', results: filtered, related: [], counts, total: filtered.length, edges: [] } });
    }
    if (url.pathname === '/api/search/records') return route.fulfill({ json: { records: records.filter(row => (url.searchParams.get('keys') ?? '').split(',').includes(`${row.type}:${row.id}`)), edges: [] } });
    if (url.pathname === '/api/saved-searches') return route.fulfill({ json: { searches: [] } });
    if (url.pathname === '/api/graph/entities') return route.fulfill({ json: { nodes: [{ id: 'fixture-person', name: 'Fixture Reviewer', title: 'Public role', department: 'Platform', skills: [], influenceScore: 0, presence: 'office' }], edges: [], departments: [{ id: 'fixture-department', name: 'Platform', color: '#6366f1' }] } });
    return route.fulfill({ status: 503, json: { error: 'Unmocked API denied in read-only Search fixture' } });
  });
  await page.route('**/__search-presentation**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/search-presentation.tsx"></script></body></html>' }));
  await page.goto('/__search-presentation?' + query);
  await expect(page.getByTestId('record-result-list')).toBeVisible();
  return { writes, reads, errors };
}

test('Search menus expose current choices with compact native icons and retain query and draft across views', async ({ page }) => {
  test.setTimeout(90000);
  const proof = await mount(page);
  const header = page.getByTestId('search-header'), scope = page.getByTestId('search-scope');
  expect(await scope.textContent()).toBe('');
  await scope.focus();
  await expect(page.getByRole('tooltip')).toHaveText('Search scope: Design System API');
  await scope.click();
  await expect(page.getByRole('menuitem', { name: 'Design System API', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');
  await expect(scope).toBeFocused();
  await page.getByTestId('search-sort').click();
  await page.getByRole('menuitem', { name: 'Recent', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('sort=recent');
  await expect(page.getByTestId('fixture-route')).not.toContainText('offset=');
  await page.getByTestId('search-type').click();
  await page.getByRole('menuitem', { name: 'People', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('type=person');
  await page.getByTestId('search-type').focus();
  await expect(page.getByRole('tooltip')).toHaveText('Record type: People');
  await header.getByRole('tab', { name: 'Answer', exact: true }).click();
  await expect(page.getByLabel('Unsent fixture inquiry')).toHaveValue('Unsent fixture inquiry');
  await expect(page.getByTestId('search-chips')).toBeVisible();
  await header.getByRole('tab', { name: 'Connections', exact: true }).click();
  await expect(page.getByTestId('search-people-toolbar')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Filter by presence', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Rare skills/ })).toHaveCount(0);
  const graphPerson = page.getByTestId('search-org-graph').locator('[data-person-id="fixture-person"]');
  await expect(graphPerson).toBeVisible();
  await expect(graphPerson.locator(':scope > g[transform]')).toHaveCount(0);
  await page.getByRole('button', { name: /^Platform/ }).first().click();
  expect(proof.reads.some(path => path === '/api/work/findings')).toBe(false);
  await expect(page.getByLabel('Unsent fixture inquiry')).toHaveValue('Unsent fixture inquiry');
  await header.getByRole('tab', { name: 'Results', exact: false }).click();
  await expect(page.getByTestId('search-trail')).toHaveText(/Initiatives.*Design System API.*Search/);
  await expect(page.getByTestId('search-trail')).not.toContainText('Engage');
  await page.mouse.move(0, 0); await page.getByTestId('search-type').blur();
  await page.screenshot({ path: test.info().outputPath('search-controls.png') });
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

test('every Search result type has compact native navigation and consistent subordinate typography', async ({ page }) => {
  const proof = await mount(page, 'scope=p-design-system-api');
  for (const record of records) {
    const row = page.locator(`[data-record-key="${record.type}:${record.id}"]`);
    await expect(row.getByRole('button', { name: `Open ${record.title}`, exact: true })).toHaveText('');
    await expect(row.getByRole('link', { name: record.title, exact: true })).toHaveAttribute('href', record.href);
    const fonts = await row.evaluate(node => ({ title: getComputedStyle(node.querySelector('a')!).fontSize, weight: getComputedStyle(node.querySelector('a')!).fontWeight,
      description: node.querySelector('.line-clamp-2') ? getComputedStyle(node.querySelector('.line-clamp-2')!).fontSize : null, meta: getComputedStyle(node.querySelector('span.truncate')!).fontSize }));
    expect(fonts).toEqual({ title: '14px', weight: '600', description: record.type === 'person' ? null : '12px', meta: '12px' });
  }
  await expect(page.getByRole('link', { name: /Open profile|Open initiative|Open work item|Open decision|Open document|Open in library/ })).toHaveCount(0);
  await page.getByLabel('Select Compact Search results', { exact: true }).click();
  await expect(page.getByLabel('Select Compact Search results', { exact: true })).toBeChecked();
  await expect(page.getByTestId('fixture-route')).toContainText('selection=work%3Afixture-work');
  await expect(page.getByRole('button', { name: 'Ask about selection', exact: true })).toHaveText('Ask');
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.getByLabel('Select Compact Search results', { exact: true })).not.toBeChecked();
  await page.screenshot({ path: test.info().outputPath('search-results.png') });
  await page.getByRole('button', { name: 'Open Compact Search results', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('/iq/projects/p-design-system-api?tab=work&item=fixture-work');
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});

test('narrow dark Search retains native menu choices without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  const proof = await mount(page, 'scope=p-design-system-api&theme=dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(640);
  await page.getByRole('button', { name: 'Search actions', exact: true }).click();
  await page.getByRole('menuitem', { name: /Record type filter/ }).click();
  await page.getByRole('menuitem', { name: 'Knowledge', exact: true }).click();
  await expect(page.getByTestId('fixture-route')).toContainText('type=knowledge');
  await expect(page.getByLabel('Unsent fixture inquiry')).toHaveValue('Unsent fixture inquiry');
  await page.screenshot({ path: test.info().outputPath('search-dark-compact.png') });
  expect(proof.writes).toEqual([]); expect(proof.errors).toEqual([]);
});
