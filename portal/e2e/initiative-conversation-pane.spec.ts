import { test, expect, type Page } from '@playwright/test';
import { signIn } from './realSession';

// The initiative's conversation is the fourth column (the user, 2026-10-07:
// the Discussion "should be the fourth vertical split pane on the far right…
// it shouldn't be nested"): primary rail | Initiatives rail | content (the
// overview sections and the docked composer) | the shell's right pane (the
// library `SidePane` on `SidePaneSplit`). A narrow window collapses the pane
// to the footer's Message. Since 2026-10-07 (the user: "keep the chat in the main
// content… just keep the dialogue thread there") the pane holds the thread and
// the page's ONE composer is docked at the bottom of the content column.
// Runs against the shared Tilt app (PARITY_BASE_URL, default :5183).

test.use({ ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });

const OVERVIEW = '/iq/projects/p-observability?scope=all';

/** Editable composers on screen. */
const editors = (page: Page) => page.locator('[contenteditable="true"]:visible');
async function box(page: Page, selector: string) {
  const rect = await page.locator(selector).first().boundingBox();
  expect(rect, selector).not.toBeNull();
  return rect!;
}

test('1680x940: rail, rail, content, conversation pane — the thread in the pane, the one composer in the content', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1680, height: 940 });
  await page.goto('/');
  await signIn(page, 'u-nora');
  await page.goto(OVERVIEW);
  const pane = page.getByTestId('page-conversation-pane');
  await expect(pane).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('initiative-overview')).toBeVisible();
  // The pane is the dialogue thread (the user, 2026-10-07: "keep the chat in the
  // main content… just keep the dialogue thread there").
  await expect(pane.getByTestId('scope-discussion-panel')).toBeVisible({ timeout: 15_000 });

  const primary = await box(page, 'nav[aria-label="Org navigation"]');
  const section = await box(page, '[data-testid="explorer-layout-rail-scroll"]');
  const content = await box(page, '[data-testid="explorer-layout-pane"]');
  const right = await box(page, '[data-testid="page-conversation-pane"]');
  // Four side-by-side columns, left to right, each starting where the last ends.
  expect(primary.x).toBeLessThan(section.x);
  expect(section.x + section.width).toBeLessThanOrEqual(content.x + 1);
  expect(content.x + content.width).toBeLessThanOrEqual(right.x + 8);
  expect(Math.round(right.x + right.width)).toBe(1680);
  expect(right.width).toBeGreaterThanOrEqual(300);
  // A full-height column, not a section of the content.
  expect(right.height).toBeGreaterThan(600);

  // One composer on screen, docked at the bottom of the content column; none in the pane.
  const column = page.getByTestId('explorer-layout-pane-column');
  await expect(editors(page)).toHaveCount(1);
  await expect(column.getByTestId('initiative-composer').locator('[contenteditable="true"]')).toHaveCount(1);
  await expect(pane.locator('[contenteditable="true"]')).toHaveCount(0);
  const dock = await box(page, '[data-testid="explorer-layout-pane-footer"]');
  expect(dock.x + dock.width).toBeLessThanOrEqual(right.x + 1);

  // The pane's header is on the Overview's compact step: 14/600 title, 12/400 meta.
  const type = (testId: string) => page.getByTestId(testId).evaluate(el => {
    const cs = getComputedStyle(el); return `${cs.fontSize}/${cs.fontWeight}`;
  });
  expect(await type('page-conversation-pane-title')).toBe('14px/600');
  expect(await type('page-conversation-pane-subtitle')).toBe('12px/400');
  // The Chat / Pinned / Files / Calls views are the icon switcher on the pane's tab row.
  await expect(pane.getByTestId('initiative-pane-views').getByRole('radiogroup', { name: 'Conversation views' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('conversation-pane-1680.png') });
  expect(errors).toEqual([]);
});

test('1280x720: the pane collapses to the footer’s Message; the content composer keeps its draft throughout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1680, height: 940 });
  await page.goto('/');
  await signIn(page, 'u-nora');
  await page.goto(OVERVIEW);
  const pane = page.getByTestId('page-conversation-pane');
  const input = page.getByTestId('initiative-composer').locator('[contenteditable="true"]');
  await expect(input).toHaveCount(1, { timeout: 20_000 });
  await expect(pane).toBeVisible({ timeout: 20_000 });
  const draft = `Half-written ${Date.now()}`;
  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(draft);
  await expect(input).toContainText(draft);

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(pane).toHaveCount(0);
  // The composer is the content column's: it stays, with its draft.
  await expect(editors(page)).toHaveCount(1);
  await expect(input).toContainText(draft);
  const message = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Message', exact: true });
  await expect(message).toBeEnabled();

  await message.click();
  await expect(pane).toBeVisible();
  await expect(input).toContainText(draft);
  await expect(input).toBeFocused();
  await expect(editors(page)).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('conversation-pane-1280-revealed.png') });

  // × closes it (remembered per device) and Message reopens it.
  await pane.getByRole('button', { name: 'Collapse discussion' }).click();
  await expect(pane).toHaveCount(0);
  await page.setViewportSize({ width: 1680, height: 940 });
  await expect(pane).toHaveCount(0);
  await message.click();
  await expect(pane).toBeVisible();
  await expect(input).toContainText(draft);
  expect(errors).toEqual([]);
});
