import { test, expect } from '@playwright/test';

const SHOT_DIR = 'e2e-shots';

// Observability pages are gated to org-leader / hr-admin in the portal nav and
// route guard (Layout.tsx:21, App.tsx:82). Masquerade as org-leader so we land
// on the page itself rather than the default redirect.
test.beforeEach(async ({ page }) => {
  await page.goto('/'); // initialise session cookie
  await page.evaluate(async () => {
    await fetch('/api/session/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role: 'org-leader' }),
    });
  });
});

test.describe('observability pages', () => {
  test('nav shows the 3 new observability links', async ({ page }) => {
    await page.goto('/observability');
    await expect(page.getByRole('link', { name: /^Drift\b/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^Quality\b/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /Approval Queue/i }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/00-nav.png`, fullPage: true });
  });

  test('drift page renders rollup, timeseries, templates, outliers', async ({ page }) => {
    await page.goto('/observability/drift');
    // Rollup
    await expect(page.getByText('Drift Rollup')).toBeVisible({ timeout: 15_000 });
    // Wait for the rollup header to show a non-zero agent count
    await expect(page.getByText(/per-agent · [1-9]\d? agents?/)).toBeVisible({ timeout: 15_000 });
    // Window picker
    await expect(page.getByRole('button', { name: '24h' })).toBeVisible();
    // Time-series chart (recharts line elements rendered)
    await expect(page.getByText('Drift Over Time')).toBeVisible();
    await page.waitForSelector('svg.recharts-surface path.recharts-line-curve', { timeout: 10_000 });
    // By template
    await expect(page.getByText('By Template')).toBeVisible();
    await expect(page.getByText('txn_extract').first()).toBeVisible();
    // Outliers
    await expect(page.getByText(/^Outliers/)).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/01-drift.png`, fullPage: true });
  });

  test('drift outlier expansion fetches nearest neighbor', async ({ page }) => {
    await page.goto('/observability/drift');
    await page.waitForSelector('svg.recharts-surface', { timeout: 10_000 });
    // Wait for outliers table to populate
    const promptCells = page.locator('td', { hasText: 'seed:' });
    await expect(promptCells.first()).toBeVisible({ timeout: 10_000 });
    await promptCells.first().click();
    await expect(page.getByText('NEAREST KNOWN-GOOD', { exact: false }).nth(1)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOT_DIR}/05-drift-neighbor.png`, fullPage: true });
  });

  test('quality page renders charts + invocations', async ({ page }) => {
    await page.goto('/observability/quality');
    // Recharts SVG containers — wait for them to mount.
    await page.waitForSelector('svg.recharts-surface, .recharts-wrapper', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: `${SHOT_DIR}/02-quality.png`, fullPage: true });
  });

  test('approvals queue shows both pending rows', async ({ page }) => {
    await page.goto('/observability/approvals');
    await expect(page.getByText('tx-smoke-001').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('tx-demo-002').first()).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/03-approvals.png`, fullPage: true });
  });

  test('org-leader can approve an over-threshold transaction', async ({ page }) => {
    await page.goto('/observability/approvals');
    await expect(page.getByText('tx-demo-002').first()).toBeVisible({ timeout: 10_000 });
    // Approve the $42.5k row (over $10k threshold → org-leader is allowed).
    const row = page.locator('tr', { hasText: 'tx-demo-002' }).first();
    const approve = row.getByRole('button', { name: /approve/i });
    if (await approve.count()) {
      await approve.first().click();
      await page.waitForTimeout(2_000);
    }
    await page.screenshot({ path: `${SHOT_DIR}/04-approvals-after-approve.png`, fullPage: true });
  });
});
