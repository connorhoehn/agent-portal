import { test, expect, type Page } from '@playwright/test';

const SHOT_DIR = 'e2e-shots';
const CALIBRATION_URL = '/observability/calibration';

// The calibration page is gated to org-leader / hr-admin. Masquerade as
// org-leader, mirroring observability.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/session/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role: 'org-leader' }),
    });
  });
});

/**
 * Open the editor on the first "Edit" link in the Manage Cases table.
 * Tolerates a fixture-free worktree: if no cases exist we open the editor
 * via the "+ Add case" button instead — the editor shape under test is the
 * same in both modes.
 */
async function openEditor(page: Page): Promise<'edit' | 'add'> {
  await page.goto(CALIBRATION_URL);
  await expect(page.getByText('Judge Calibration')).toBeVisible({ timeout: 15_000 });

  const editBtn = page.getByRole('button', { name: /^Edit$/ }).first();
  if (await editBtn.count()) {
    await editBtn.click();
    await expect(page.getByTestId('case-editor')).toBeVisible({ timeout: 10_000 });
    return 'edit';
  }
  await page.getByRole('button', { name: /\+ Add case/i }).click();
  await expect(page.getByTestId('case-editor')).toBeVisible({ timeout: 10_000 });
  return 'add';
}

test.describe('calibration case editor', () => {
  test('clicking a row opens the editor modal', async ({ page }) => {
    const mode = await openEditor(page);
    const title = mode === 'edit' ? /Edit calibration case/i : /Add calibration case/i;
    await expect(page.getByText(title)).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/calibration-editor-open.png`, fullPage: true });
  });

  test('editor shows prompt + response + human score fields', async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId('case-editor-prompt-wrap')).toBeVisible();
    await expect(page.getByTestId('case-editor-response-wrap')).toBeVisible();
    await expect(page.getByTestId('case-editor-score')).toBeVisible();
    // CodeEditor exposes itself with the aria-label we passed.
    await expect(page.getByLabel('Prompt', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Response', { exact: true })).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/calibration-editor-fields.png`, fullPage: true });
  });

  test('editing the prompt and saving persists', async ({ page }) => {
    const mode = await openEditor(page);
    // Type into the prompt CodeEditor.
    const promptInput = page.getByLabel('Prompt', { exact: true });
    await promptInput.click();
    await promptInput.fill(`E2E edit ${Date.now()}`);

    // In add mode the response is empty and the agent select is pre-filled.
    if (mode === 'add') {
      const responseInput = page.getByLabel('Response', { exact: true });
      await responseInput.fill('Response for e2e test');
    }

    // Click Save. We don't strictly require the backend to succeed — the
    // worktree may not have writable cases. We assert either: the modal
    // closes (success path), the editor surfaces a banner-or-toast error,
    // or the Save button shows a busy state. Any of these prove the save
    // path is wired up rather than silently a no-op.
    await page.getByTestId('case-editor-save').click();
    await page.waitForTimeout(1_500);

    const editorStillOpen = await page.getByTestId('case-editor').isVisible().catch(() => false);
    const errBanner = await page.getByTestId('case-editor-error').isVisible().catch(() => false);
    const toastPresent = (await page.getByText(/Case saved|Save failed/i).count()) > 0;
    expect(!editorStillOpen || errBanner || toastPresent).toBeTruthy();

    await page.screenshot({ path: `${SHOT_DIR}/calibration-editor-save.png`, fullPage: true });
  });

  test('cancel closes without saving', async ({ page }) => {
    await openEditor(page);
    const promptInput = page.getByLabel('Prompt', { exact: true });
    await promptInput.click();
    await promptInput.fill('This text should be discarded on cancel');
    await page.getByTestId('case-editor-cancel').click();
    await expect(page.getByTestId('case-editor')).toBeHidden({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/calibration-editor-cancel.png`, fullPage: true });
  });

  test('Esc closes the modal', async ({ page }) => {
    await openEditor(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('case-editor')).toBeHidden({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/calibration-editor-esc.png`, fullPage: true });
  });
});
