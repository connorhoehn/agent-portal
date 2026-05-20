// Prompts registry browser — read-only view of observability.prompt_versions.
//
// The page lives at /admin/capabilities/prompts. It is NOT role-gated by the
// router (capabilities/* is open to all roles in App.tsx) but we masquerade as
// org-leader anyway so the nav surfaces the section. The tests hit the
// underlying registry endpoint to decide between the "has rows" and "empty"
// branches without seeding/mutating fixtures.

import { test, expect } from '@playwright/test';

const SHOT_DIR = 'e2e-shots';
const PAGE_URL = '/admin/capabilities/prompts';

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

interface PromptVersionRow {
  promptVersion: string;
  agentId: string;
  content: string;
  contentSha256: string;
  registeredAt: string;
  notes: string | null;
}

async function fetchRegistry(request: import('@playwright/test').APIRequestContext): Promise<PromptVersionRow[]> {
  const res = await request.get('/api/observability/prompt-versions');
  if (!res.ok()) return [];
  const body = await res.json();
  return Array.isArray(body?.versions) ? (body.versions as PromptVersionRow[]) : [];
}

test.describe('prompts registry', () => {
  test('page renders title + table', async ({ page, request }) => {
    await page.goto(PAGE_URL);
    await expect(page.getByTestId('prompts-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Prompt Registry/i).first()).toBeVisible();
    // Filter input is part of the steady-state UI regardless of row count
    await expect(page.getByTestId('prompts-filter')).toBeVisible();

    const rows = await fetchRegistry(request);
    if (rows.length > 0) {
      await expect(page.getByTestId('prompts-table')).toBeVisible({ timeout: 10_000 });
    } else {
      await expect(page.getByTestId('prompts-empty')).toBeVisible({ timeout: 10_000 });
    }
    await page.screenshot({ path: `${SHOT_DIR}/prompts-00-page.png`, fullPage: true });
  });

  test('rows are visible when registry has entries', async ({ page, request }) => {
    const rows = await fetchRegistry(request);
    if (rows.length === 0) test.skip();
    await page.goto(PAGE_URL);
    const table = page.getByTestId('prompts-table');
    await expect(table).toBeVisible({ timeout: 10_000 });
    // Every row uses prompts-row-<shortSha> as its testid. Assert at least the
    // first row from the registry is in the DOM.
    const firstSha = rows[0]!.promptVersion;
    await expect(page.getByTestId(`prompts-row-${firstSha}`)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOT_DIR}/prompts-01-rows.png`, fullPage: true });
  });

  test('clicking a row opens the modal with prompt content', async ({ page, request }) => {
    const rows = await fetchRegistry(request);
    if (rows.length === 0) test.skip();
    const target = rows[0]!;
    await page.goto(PAGE_URL);
    await expect(page.getByTestId(`prompts-row-${target.promptVersion}`)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`prompts-row-${target.promptVersion}`).click();
    await expect(page.getByTestId('prompts-modal')).toBeVisible({ timeout: 5_000 });
    // The modal title combines agent ID + short SHA.
    await expect(page.getByText(`${target.agentId} · ${target.promptVersion}`)).toBeVisible();
    // A non-trivial slice of the prompt content should appear in the CodeEditor.
    if (target.content.length > 0) {
      const snippet = target.content.slice(0, Math.min(40, target.content.length));
      await expect(page.getByText(snippet, { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    }
    await page.screenshot({ path: `${SHOT_DIR}/prompts-02-modal.png`, fullPage: true });
  });

  test('modal closes on Esc + on backdrop click', async ({ page, request }) => {
    const rows = await fetchRegistry(request);
    if (rows.length === 0) test.skip();
    const target = rows[0]!;
    await page.goto(PAGE_URL);
    await expect(page.getByTestId(`prompts-row-${target.promptVersion}`)).toBeVisible({ timeout: 10_000 });

    // Open + Esc-close
    await page.getByTestId(`prompts-row-${target.promptVersion}`).click();
    await expect(page.getByTestId('prompts-modal')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('prompts-modal')).toBeHidden({ timeout: 5_000 });

    // Open + backdrop-close
    await page.getByTestId(`prompts-row-${target.promptVersion}`).click();
    await expect(page.getByTestId('prompts-modal')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('prompts-modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('prompts-modal')).toBeHidden({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/prompts-03-modal-closed.png`, fullPage: true });
  });

  test('filter input narrows the row list', async ({ page, request }) => {
    const rows = await fetchRegistry(request);
    if (rows.length === 0) test.skip();
    await page.goto(PAGE_URL);
    await expect(page.getByTestId('prompts-table')).toBeVisible({ timeout: 10_000 });

    // Type a string that almost certainly matches nothing in the registry.
    await page.getByTestId('prompts-filter').fill('zzz-no-such-agent-zzz');
    await expect(page.getByTestId('prompts-empty-filtered')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('prompts-table')).toBeHidden();

    // Clearing the filter restores the table.
    await page.getByTestId('prompts-filter').fill('');
    await expect(page.getByTestId('prompts-table')).toBeVisible({ timeout: 5_000 });

    // Filtering by an exact agent_id from the registry should match at least one row.
    const target = rows[0]!;
    await page.getByTestId('prompts-filter').fill(target.agentId);
    await expect(page.getByTestId(`prompts-row-${target.promptVersion}`)).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/prompts-04-filter.png`, fullPage: true });
  });

  test('empty state renders when no rows', async ({ page, request }) => {
    const rows = await fetchRegistry(request);
    if (rows.length > 0) test.skip();
    await page.goto(PAGE_URL);
    await expect(page.getByTestId('prompts-empty')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/No prompts registered yet/i)).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/prompts-05-empty.png`, fullPage: true });
  });
});
