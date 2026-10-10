import { expect, test, type Page } from '@playwright/test';
test.use({ baseURL: process.env.PANE_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5183' });
async function mount(page: Page, query = '') {
  const errors: string[] = [], mutations: string[] = [], reads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [path, names] of [['src/components/shell/ConversationPane.tsx', 'useConversationPane, ConversationPaneBody'], ['src/components/chat/useChatPins.tsx', 'ConversationViewsSlot']])
    await page.route(`**/${path}*`, route => route.fulfill({ contentType: 'text/javascript', body: `export { ${names} } from '/e2e/fixtures/initiative-details.tsx';` }));
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path); else reads.push(path);
    if (path === '/api/sprints') return route.fulfill({ json: { sprints: [{ id: 'fixture-sprint', name: 'Sprint 98 — Span metrics + decom', orgProjectId: 'p-observability', startsOn: '2026-09-25', endsOn: '2026-10-09', status: 'active' }] } });
    return route.fulfill({ status: 503, json: { error: 'The Details fixture denies unmocked APIs.' } });
  });
  await page.route('**/__pane-avatar-*.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="12" fill="currentColor"/></svg>' }));
  await page.route('**/__initiative-details*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/initiative-details.tsx"></script></body></html>' }));
  await page.goto(`/__initiative-details${query}`); await expect(page.getByTestId('initiative-details-trigger')).toBeVisible();
  return { errors, mutations, reads };
}
test('info opens Details directly; Shift+I reveals it without disrupting editors or drafts', async ({ page }) => {
  const result = await mount(page);
  const trigger = page.getByTestId('initiative-details-trigger'); await trigger.hover();
  await expect(page.getByTestId('initiative-details-summary')).toHaveCount(0);
  await trigger.click(); await expect(page.getByTestId('initiative-pane-tab-details')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('fixture-search')).toHaveText('?pane=details');
  await expect(page.getByTestId('initiative-details-action')).toBeVisible();
  const draft = page.getByRole('textbox', { name: 'Main draft' }); await draft.fill('Preserved draft');
  await page.getByRole('button', { name: 'Discussion tab' }).click();
  await draft.focus(); await page.keyboard.press('Shift+I'); await expect(page.getByTestId('initiative-pane-tab-discussion')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Rich draft' }).focus(); await page.keyboard.press('Shift+I'); await expect(page.getByTestId('initiative-pane-tab-discussion')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Discussion tab' }).focus(); await page.keyboard.press('Shift+I');
  await expect(page.getByTestId('initiative-pane-tab-details')).toHaveAttribute('aria-selected', 'true');
  await expect(draft).toHaveValue('Preserved draftI');
  await page.getByTestId('initiative-details-docs').click(); await expect(page.getByTestId('fixture-opened')).toHaveText('docs');
  await page.getByTestId('initiative-details-activity').click(); await expect(page.getByTestId('fixture-opened')).toHaveText('activity');
  await page.screenshot({ path: test.info().outputPath('details-curated-work.png') });
  expect(result.errors).toEqual([]); expect(result.mutations).toEqual([]); expect(result.reads.every(path => path === '/api/sprints')).toBe(true);
});
test('curated summary keeps one work action, authorized portraits, and honest empty/failed/loading reads', async ({ page }) => {
  const result = await mount(page); await page.getByTestId('initiative-details-trigger').click();
  const pane = page.getByTestId('initiative-pane-details');
  await expect(pane.getByTestId('initiative-details-action')).toHaveCount(1);
  await expect(pane).not.toContainText('THIS MONTH'); await expect(pane).not.toContainText('Repository'); await expect(pane).not.toContainText('Nothing is blocked.');
  await expect(pane.getByTestId('initiative-details-people').locator('img[src="/__pane-avatar-owner.svg"]')).toHaveCount(1);
  await expect(pane.getByTestId('initiative-details-people').locator('img[src="/__pane-avatar-sme.svg"]')).toHaveCount(1);
  await pane.getByRole('button', { name: /Open work item/ }).click(); await expect(page.getByTestId('fixture-opened')).toHaveText('wi-obs-e2-b4');
  await page.getByRole('button', { name: 'Show next work' }).click(); await expect(pane.getByTestId('initiative-details-action')).toContainText('Verify collector coverage');
  await pane.getByRole('button', { name: /Open work item/ }).click(); await expect(page.getByTestId('fixture-opened')).toHaveText('inert-next-work');
  await page.getByRole('button', { name: 'Show empty work' }).click(); await expect(pane.getByTestId('initiative-details-action')).toHaveCount(0); await expect(pane).not.toContainText('Nothing is blocked');
  await page.getByRole('button', { name: 'Show failed read' }).click(); await expect(pane).toContainText('Work could not be read.'); await expect(pane.getByTestId('initiative-details-action')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show loading read' }).click(); await expect(pane).toContainText('Loading work…');
  expect(result.errors).toEqual([]); expect(result.mutations).toEqual([]);
});
test('native pane tabs fit narrow widths, keep matching typography, and focus hidden selections', async ({ page }) => {
  const result = await mount(page); await page.getByTestId('initiative-details-trigger').click();
  for (const width of [1440, 1000, 860]) {
    await page.setViewportSize({ width, height: 850 });
    await page.getByTestId('initiative-details-trigger').click();
    const header = page.getByTestId('initiative-pane-header-row');
    await expect(header).toBeVisible();
    const boxes = await header.evaluate(element => { const root = element.getBoundingClientRect(); return [...element.querySelectorAll('button')].map(button => ({ left: button.getBoundingClientRect().left - root.left, right: button.getBoundingClientRect().right - root.left, width: root.width, font: getComputedStyle(button).fontSize, height: button.getBoundingClientRect().height })); });
    for (const box of boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(box.width + 1); }
    expect(boxes.filter(box => box.height >= 30).every(box => box.font === '14px')).toBe(true);
  }
  const small = page.getByTestId('small-pane-header'); const discussion = small.getByRole('tab', { name: 'Discussion' }); await discussion.focus(); await page.keyboard.press('ArrowRight');
  await expect(small.getByRole('tab', { name: 'Agent' })).toBeFocused(); await page.keyboard.press('End'); await expect(small.getByRole('tab', { name: 'Details' })).toBeFocused();
  await expect(small.getByRole('button', { name: /More views: Agent/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('details-narrow-pane.png') });
  expect(result.errors).toEqual([]); expect(result.mutations).toEqual([]);
});
for (const tenant of ['orgiq', 'assessment', 'social', 'pipelines']) for (const theme of ['light', 'dark']) test(`native themed buttons preserve primary/destructive/focus/disabled semantics in ${tenant} ${theme}`, async ({ page }) => {
  const result = await mount(page, `?tenant=${tenant}&theme=${theme}`);
  const actions = page.getByTestId('native-theme-actions'); const secondary = actions.getByRole('button', { name: 'Secondary', exact: true }); await secondary.focus();
  const style = await secondary.evaluate(element => ({ outlineStyle: getComputedStyle(element).outlineStyle, outlineWidth: getComputedStyle(element).outlineWidth, outlineColor: getComputedStyle(element).outlineColor, bg: getComputedStyle(element).backgroundColor, primary: getComputedStyle(document.documentElement).getPropertyValue('--color-primary') }));
  expect(style.outlineStyle).toBe('solid'); expect(style.outlineWidth).toBe('2px'); expect(style.bg).not.toBe('rgba(0, 0, 0, 0)');
  const primary = actions.getByRole('button', { name: 'Primary', exact: true }), destructive = actions.getByRole('button', { name: 'Destructive' });
  expect(await primary.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(await actions.getByRole('button', { name: 'Primary icon' }).evaluate(el => getComputedStyle(el).backgroundColor));
  expect(await destructive.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(await primary.evaluate(el => getComputedStyle(el).backgroundColor));
  await expect(actions.getByRole('button', { name: 'Disabled', exact: true })).toBeDisabled(); await expect(actions.getByRole('button', { name: 'Pressed icon' })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath(`native-buttons-${tenant}-${theme}.png`) }); expect(result.errors).toEqual([]); expect(result.mutations).toEqual([]);
});
