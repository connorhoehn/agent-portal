import { test, expect, type Page } from '@playwright/test';

// The judge's browser half for docs/assessment-documents-parity-goal.md.
// Runs against a stack whose middleware can mint document grants — start it
// with `node scripts/social-documents.mjs up` and `npm run dev:mock:social`
// (docs/social-calls-local-stack.md) — and point PARITY_BASE_URL at its
// portal when that is not :5183. Without the document env the pane is the
// reader fallback, and this spec fails on purpose: it is measuring the editor.
//
// u-farah lands in the assessment tenant as lead-assessor (ManageKnowledge),
// so no tenant or role switch — and no session-epoch bump — is needed.

const OUT = '../docs/design/documents-parity';
const DOC = 'page:100002';
// The page's canvas — the composer dock under it is a ProseMirror too.
const CANVAS = '.ProseMirror:not(.chat-composer-input)';
test.use({ viewport: { width: 1672, height: 941 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

async function signIn(page: Page) {
  await page.goto('/');
  const status = await page.evaluate(async () => (await fetch('/api/session/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ userId: 'u-farah' }),
  })).status);
  expect(status, 'demo login').toBe(200);
}

test('assessment workspace page opens in the shared document editor frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);

  const shell = page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Document collaboration is unavailable')).toHaveCount(0);
  for (const name of ['Editor', 'Comments', 'Versions', 'History', 'Reviews']) {
    await expect(shell.getByRole('tab', { name: new RegExp(`^${name}`) })).toBeVisible();
  }
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${OUT}/parity-journey-reader.png` });

  // A synced page is read until Edit draft; then the toolbar card and ruler.
  await shell.getByRole('button', { name: 'Edit draft' }).click();
  await expect(page.locator(`${CANVAS}[contenteditable="true"]`)).toBeVisible();
  await expect(shell.getByRole('toolbar').first()).toBeVisible();
  await expect(page.locator('[data-testid*="ruler"]').first()).toBeVisible();
  await expect(shell.getByText('Local draft')).toBeVisible();
  await page.screenshot({ path: `${OUT}/parity-journey-edit-draft.png` });
  await shell.getByRole('button', { name: 'Done editing' }).click();

  // Versions is docked in its tab (VersionHistoryPanel docked), not a slide-out over the window.
  await shell.getByRole('tab', { name: /^Versions/ }).click();
  await expect(page.getByTestId('document-tab-versions').getByTestId('document-versions')).toBeVisible();
  await expect(shell.getByRole('tab', { name: /^Versions/ })).toHaveAttribute('aria-selected', 'true');
  await page.waitForTimeout(400); // the tab underline and head buttons settle their transitions
  await page.screenshot({ path: `${OUT}/parity-journey-versions.png` });

  for (const tab of ['Comments', 'History', 'Reviews']) {
    await shell.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.getByTestId(`document-tab-${tab.toLowerCase()}`)).toBeVisible();
    await page.screenshot({ path: `${OUT}/parity-journey-${tab.toLowerCase()}.png` });
  }
  expect(errors, 'page errors').toEqual([]);
});

// Phases 3–4 (gaps 7, 9, 10): the reference's rail, list page and composer dock.
test('the rail, the All documents list and the document conversation match the reference', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await signIn(page);
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  const shell = page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });

  // "DOCUMENTS n", the three views, sources as folders on the rail-scale tree.
  const frame = page.getByTestId('knowledge-explorer');
  await expect(frame.getByText(/^Documents$/i).first()).toBeVisible();
  const views = page.getByTestId('document-rail-views');
  for (const name of ['All documents', 'Recent', 'Shared with me']) await expect(views.getByText(name, { exact: true })).toBeVisible();
  const tree = page.getByTestId('document-rail-tree');
  await expect(tree.getByTestId('document-rail-tree-row-section:confluence-eng')).toBeVisible();
  await expect(tree.getByTestId(`document-rail-tree-row-${DOC}`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('section-pull-confluence-eng').or(tree.getByTestId('document-rail-tree-row-section:confluence-eng'))).toBeVisible();

  // The composer dock: the document chip, the conversation placeholder, Send.
  const dock = page.getByTestId('page-composer-dock');
  await expect(dock).toBeVisible();
  await expect(dock.getByText('Rubric Overview')).toBeVisible();
  // The placeholder is the editor's empty paragraph, drawn from its data-placeholder.
  await expect(dock.locator('[data-placeholder="Message this document’s conversation…"]')).toHaveCount(1);
  await page.screenshot({ path: `${OUT}/parity-journey-rail-dock.png` });

  // A message goes to the document's conversation on the BFF gateway and comes back in the Chat panel.
  const note = `Parity check ${Date.now()}`;
  await page.getByTestId('page-composer-input').click();
  await page.keyboard.type(note);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('document-chat-panel').getByText(note)).toBeVisible({ timeout: 10_000 });
  await page.screenshot({ path: `${OUT}/parity-journey-chat.png` });

  // Recent and Shared with me swap the tree for their own list.
  await views.getByText('Recent', { exact: true }).click();
  await expect(page.getByTestId('document-rail-recent')).toBeVisible();
  await views.getByText('Shared with me', { exact: true }).click();
  await expect(page.getByTestId('document-rail-shared-empty')).toBeVisible();

  // All documents: PageHeader + Upload + New ▾, search + filter, result rows.
  await views.getByText('All documents', { exact: true }).click();
  const list = page.getByTestId('document-list-page');
  await expect(list).toBeVisible();
  await expect(list.getByRole('heading', { name: 'All documents' })).toBeVisible();
  await expect(page.getByTestId('document-upload')).toBeVisible();
  await expect(page.getByTestId('new-document-btn')).toBeVisible();
  await expect(list.getByRole('button', { name: /Filter documents/ })).toBeVisible();
  const rows = page.getByTestId('document-result-list');
  await expect(rows.getByText('Rubric Overview')).toBeVisible();
  await list.getByRole('searchbox', { name: 'Search documents' }).or(list.getByRole('textbox', { name: 'Search documents' })).first().fill('faq');
  await expect(page.getByTestId('document-result-count')).toHaveText('1 result');
  await page.screenshot({ path: `${OUT}/parity-journey-list.png` });
  expect(errors, 'page errors').toEqual([]);
});
