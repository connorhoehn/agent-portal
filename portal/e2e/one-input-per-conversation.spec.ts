import { test, expect, type Page } from '@playwright/test';
import { signIn } from './realSession';

// One input per conversation on screen (the library ConversationInputProvider). On an
// assessment document the dock under the page is the conversation's composer;
// with the context column's Chat panel open beside it, the panel is the
// thread only and its send intent puts the caret in the dock (in Chat mode).
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183).

const DOC = process.env.ONE_INPUT_DOC ?? 'page:100002';
test.use({ viewport: { width: 1672, height: 941 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

/** Editable chat composers drawn on screen (the rich composer's input). */
const visibleComposers = (page: Page) => page.locator('[data-testid$="composer-input"]:visible, [data-testid="rich-chat-composer-input"]:visible');

test('the document dock is the conversation’s one composer; the Chat panel is the thread and its Write focuses the dock', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await signIn(page, 'u-farah');
  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(DOC)}`);
  const dock = page.getByTestId('page-composer-dock');
  await expect(dock).toBeVisible({ timeout: 30_000 });

  // Open the context column's Chat panel beside the page.
  await page.getByRole('group', { name: 'Document context' }).getByRole('button', { name: 'Chat', exact: true }).click();
  const panel = page.getByTestId('document-chat-panel');
  await expect(panel).toBeVisible();

  // Exactly one composer on screen: the dock's. The panel shows the hand-off instead.
  await expect(panel.getByTestId('document-chat-input-elsewhere')).toBeVisible();
  await expect(panel.getByTestId('document-chat-composer')).toHaveCount(0);
  await expect(panel.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(visibleComposers(page)).toHaveCount(1);
  await expect(dock.getByTestId('page-composer-input')).toBeVisible();

  // The panel's send intent: Chat mode in the dock, caret in it.
  await panel.getByTestId('document-chat-input-elsewhere-focus').click();
  await expect(dock.getByTestId('page-composer-input')).toBeFocused();
  await expect(dock.locator('[data-placeholder="Message this document’s conversation…"]')).toHaveCount(1);

  // What the dock sends lands in the thread beside it.
  const note = `One input ${Date.now()}`;
  await page.keyboard.type(note);
  await page.keyboard.press('Enter');
  await expect(panel.getByText(note)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: test.info().outputPath('one-input-document.png') });

  // Away from the Editor tab the dock is gone, so the panel composes again.
  await page.getByTestId('document-shell').getByRole('tab', { name: /^Comments/ }).click();
  await expect(panel.getByTestId('document-chat-input-elsewhere')).toHaveCount(0);
  await expect(panel.getByTestId('document-chat-composer-input')).toBeVisible();
  await expect(visibleComposers(page)).toHaveCount(1);
  expect(errors, 'page errors').toEqual([]);
});
