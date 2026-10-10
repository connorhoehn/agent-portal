import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The initiative's details, docs and logs go far right (the user, 2026-10-07:
// "a card that would pop up and hover for project details and then you could
// open up the fourth vertical side window (far right) for project details…
// link to the project workspace with governance docs from the toolbar…
// Opening up logs or anything else in detail should go far right"):
//
// - the info glyph beside the title shows the details card on hover and on
//   keyboard focus (owner, status, repository), and Escape hides it;
// - Open details opens the shell's right pane on Details, and with a detail
//   open beside the page the primary rail folds (the deep band) while the
//   section rail stays;
// - the toolbar's Workspace documents opens Docs: governance documents linked
//   to the initiative's work, read through the work-document association
//   routes, each opening its record page;
// - a run's Logs opens its Log tab in the pane without navigating, with
//   Open page for the full job page;
// - one composer on screen, always the content column's (the pane is the thread).
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183).

const PID = 'p-auth-migration';
const ITEM = 'wi-auth-e1-s1';
const DOC = 'adr-d-aurora';
const BASE = () => process.env.PARITY_BASE_URL ?? test.info().project.use.baseURL ?? 'http://127.0.0.1:5183';

async function open(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: BASE() });
  await loginAs(context, 'u-release', BASE());
  const page = await context.newPage();
  expect((await page.request.post('/api/session/role', { data: { role } })).status(), `switch to ${role}`).toBe(200);
  return page;
}

async function goto(page: Page, query: string) {
  await page.goto(`/iq/projects/${PID}?scope=all&${query}`);
  await expect(page.getByTestId('initiative-header')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('initiative-pane')).toBeVisible({ timeout: 20_000 });
}

const editors = (page: Page) => page.locator('[contenteditable="true"]:visible');
/** The pane's current tab — the selected tab of its one tablist (what the reader sees). */
const paneTab = (scope: Page | Locator) => ('getByTestId' in scope && 'goto' in scope ? scope.getByTestId('initiative-pane') : scope)
  .getByRole('tablist', { name: 'Pane sections' }).getByRole('tab', { selected: true });
const shell = (page: Page) => page.evaluate(() => {
  const nav = document.querySelector('[data-shell-nav]');
  return { primary: nav?.getAttribute('data-primary-rail'), section: nav?.getAttribute('data-section-rail'), depth: Number(nav?.getAttribute('data-drill-depth')) };
});

test('the details card shows on hover and on focus; Open details opens the pane on Details and folds the primary rail', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'org-leader');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await goto(page, 'tab=agents');
  // Shallow first: the Discussion pane alone is not a detail.
  await expect(paneTab(page)).toHaveText('Discussion');
  expect((await shell(page)).primary).toBe('open');
  await expect(editors(page)).toHaveCount(1);

  const trigger = page.getByTestId('initiative-details-trigger');
  const card = page.getByTestId('initiative-details-card');
  await trigger.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Vera Green');
  await expect(card).toContainText('In progress');
  await expect(card).toContainText('orgiq-auth-service');
  await expect(card).toContainText(/Maintenance/);
  await page.screenshot({ path: test.info().outputPath('details-card.png') });
  await page.mouse.move(5, 890);
  await expect(card).toHaveCount(0);

  // Keyboard: focus alone shows it, Escape hides it, focus stays on the trigger.
  await trigger.focus();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.hover();
  await card.getByTestId('initiative-details-open').click();
  const pane = page.getByTestId('initiative-pane');
  await expect(paneTab(pane)).toHaveText('Details');
  await expect(page).toHaveURL(/[?&]pane=details(&|$)/);
  await expect(page.getByTestId('page-conversation-pane-title')).toHaveText('Details');
  await expect(pane.getByTestId('initiative-facts')).toContainText('Vera Green');
  await expect(pane.getByTestId('initiative-facts')).toContainText('Sponsor');
  await expect.poll(async () => (await shell(page)).primary).toBe('collapsed');
  await page.screenshot({ path: test.info().outputPath('details-pane.png') });
  const rails = await shell(page);
  expect(rails.depth).toBeGreaterThanOrEqual(3);
  expect(rails.section).toBe('open');
  // One composer, the content column's, on every pane tab.
  await expect(editors(page)).toHaveCount(1);
  await expect(page.getByTestId('page-conversation-pane').locator('[contenteditable="true"]')).toHaveCount(0);
  await pane.getByTestId('initiative-pane-tab-discussion').click();
  await expect(paneTab(pane)).toHaveText('Discussion');
  await expect(editors(page)).toHaveCount(1);
  await expect.poll(async () => (await shell(page)).primary).toBe('open');
  expect(errors).toEqual([]);
  await page.context().close();
});

test('the toolbar’s Workspace documents opens Docs with the governance documents linked to the work', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'org-leader');
  // The mock starts with no associations (like a new database): link one
  // through the real association route, and unlink it after if this run made it.
  const linked = await page.request.put(`/api/graph/work-items/${ITEM}/documents/${DOC}`);
  expect([200, 201]).toContain(linked.status());
  const created = (await linked.json()).created === true;
  try {
    await goto(page, 'tab=overview');
    await page.getByTestId('initiative-header').getByRole('button', { name: 'Workspace documents' }).click();
    const pane = page.getByTestId('initiative-pane');
    await expect(paneTab(pane)).toHaveText('Docs');
    await expect(page.getByTestId('page-conversation-pane-title')).toHaveText('Docs');
    const list = pane.getByTestId('initiative-docs-list');
    const row = list.getByText('ADR: Adopt Aurora over Neptune');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(list).toContainText('ADR');
    await expect(editors(page)).toHaveCount(1);
    await expect(pane.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(pane.getByTestId('initiative-docs-workspace')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('docs-pane.png') });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/iq/documents/${DOC}$`));
  } finally {
    if (created) await page.request.delete(`/api/graph/work-items/${ITEM}/documents/${DOC}`);
    await page.context().close();
  }
});

test('a member’s Logs opens the run’s log in the pane, not a navigation; Open page goes to the job', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'member');
  await goto(page, 'tab=agents');
  const rows = page.getByTestId('initiative-agents-runs').locator('tbody tr');
  await expect(rows.first()).toContainText('auth-dep-watch', { timeout: 20_000 });
  const logs = rows.first().getByTestId('agents-run-logs');
  const href = (await logs.getAttribute('href'))!;
  const jobId = decodeURIComponent(href.split('/').pop()!);
  const before = page.url();
  await logs.click();
  const pane = page.getByTestId('initiative-pane');
  await expect(paneTab(pane)).toHaveText('Log');
  expect(new URL(page.url()).pathname).toBe(new URL(before).pathname);
  await expect(page).toHaveURL(new RegExp(`pane=log&paneRecord=run%3A${jobId}`));
  const log = pane.getByTestId('initiative-log');
  await expect(log).toContainText('auth-dep-watch');
  await expect(log.getByTestId('initiative-log-line').first()).toBeVisible();
  await expect(log.getByTestId('initiative-log-lines')).toContainText('read_file');
  await expect(editors(page)).toHaveCount(1);
  await expect(pane.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect.poll(async () => (await shell(page)).primary).toBe('collapsed');
  await page.screenshot({ path: test.info().outputPath('log-pane.png') });

  await log.getByTestId('initiative-log-open-page').click();
  await expect(page).toHaveURL(new RegExp(`/iq/work/${jobId}$`));
  await expect(page.locator('main')).toContainText('auth-dep-watch', { timeout: 20_000 });
  await page.context().close();
});

test('a decision’s and a contributor’s detail open in the pane, not a modal or a navigation', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await open(browser, 'org-leader');
  await goto(page, 'tab=decisions');
  const pane = page.getByTestId('initiative-pane');
  await page.getByRole('button', { name: /^Open details for / }).first().click();
  await expect(paneTab(pane)).toHaveText('Decision');
  await expect(pane.getByTestId('initiative-decision')).toBeVisible();
  await page.getByTestId('initiative-header-tab-contributors').click();
  await page.getByTestId('initiative-workspace').getByRole('table').locator('tbody tr').first().click();
  await expect(paneTab(pane)).toHaveText('Person');
  await expect(page).toHaveURL(/pane=person&paneRecord=person%3Ap-/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(pane.getByTestId('initiative-person')).toBeVisible();
  await page.context().close();
});
