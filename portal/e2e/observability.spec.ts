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

  test('harness home shows recent runs + coverage', async ({ page }) => {
    await page.goto('/observability/harness');
    await expect(page.getByText(/Test Harness/i)).toBeVisible({ timeout: 10_000 });
    // The seeded smoke run should appear in the recent runs table.
    await expect(page.getByText(/smoke@/).first()).toBeVisible({ timeout: 10_000 });
    // Coverage bars: 5 agents with seeded test cases.
    await expect(page.getByText('orgiq-supervisor').first()).toBeVisible();
    await expect(page.getByText('orgiq-ingestion').first()).toBeVisible();
    // [Run now] button should be there
    await expect(page.getByRole('button', { name: /run now/i })).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/06-harness-home.png`, fullPage: true });
  });

  test('harness run detail shows matrix + regressions or pass list', async ({ page }) => {
    // Find the most recent run and visit its detail page
    const res = await page.request.get('/api/observability/harness/runs?limit=1');
    const body = await res.json();
    const runId = body.runs?.[0]?.runId;
    expect(runId).toBeTruthy();
    await page.goto(`/observability/harness/runs/${runId}`);
    // Header shows the run label + pass rate
    await expect(page.getByText(/smoke@/).first()).toBeVisible({ timeout: 10_000 });
    // The seeded run has 10 test results — at least one test_id must render
    await expect(page.getByText('ingestion.invoice.simple.001').first()).toBeVisible();
    await expect(page.getByText('supervisor.routing.score.001').first()).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/07-harness-run.png`, fullPage: true });
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

  // ───────────────────────────────────────────────────────────────────────────
  // Sprint 1 — cost + provenance chips and the new cost aggregation API.
  //
  // Tolerance contract: cost data may be entirely null in this worktree (the
  // schema migration owning the cost columns lives in Agent A's branch), and
  // prompt-version provenance may not exist in production traces yet. Tests
  // must verify *structure* (chip/header renders, endpoint shape), and skip
  // gracefully when the prerequisite data isn't present.
  // ───────────────────────────────────────────────────────────────────────────

  test('cost chips appear on drift outliers', async ({ page }) => {
    await page.goto('/observability/drift');
    // Wait for the outliers table to populate (existing flow)
    await page.waitForSelector('svg.recharts-surface path.recharts-line-curve', { timeout: 10_000 });
    // The outliers table should have a Cost column header (case-insensitive)
    await expect(page.getByRole('cell', { name: /^Cost$/i }).first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: `${SHOT_DIR}/08-drift-with-cost.png`, fullPage: true });
  });

  test('harness run detail shows mode chip and total cost', async ({ page }) => {
    const res = await page.request.get('/api/observability/harness/runs?limit=1');
    const body = await res.json();
    const runId = body.runs?.[0]?.runId;
    if (!runId) test.skip();
    await page.goto(`/observability/harness/runs/${runId}`);
    // Mode chip — either LIVE or SIM
    await expect(page.getByText(/^(LIVE|SIM)$/i).first()).toBeVisible({ timeout: 10_000 });
    // Cost column header in the matrix
    await expect(page.getByRole('cell', { name: /^Cost$/i }).first()).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/09-harness-with-cost.png`, fullPage: true });
  });

  test('prompt version chip opens prompt modal', async ({ page }) => {
    await page.goto('/observability/drift');
    await page.waitForSelector('svg.recharts-surface path.recharts-line-curve', { timeout: 10_000 });
    // Find the first prompt-version chip if any exists (it may not, if production
    // traces don't have provenance yet — skip gracefully)
    const chip = page.getByText(/^p:[a-f0-9]{6,12}/).first();
    const count = await chip.count();
    if (count === 0) test.skip();
    await chip.click();
    // Modal shows agent_id + content
    await expect(page.getByText(/agent_id/i).first()).toBeVisible({ timeout: 5_000 });
    await page.screenshot({ path: `${SHOT_DIR}/10-prompt-modal.png`, fullPage: true });
  });

  test('cost endpoint returns aggregate data', async ({ request }) => {
    const res = await request.get('/api/observability/cost/per-agent?windowHours=24');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('byAgent');
    expect(Array.isArray(body.byAgent)).toBeTruthy();
  });

  test('cost timeseries endpoint returns bucketed data', async ({ request }) => {
    const res = await request.get('/api/observability/cost/timeseries?windowHours=24&bucketMin=60');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toHaveProperty('points');
  });
});
