import { test, expect } from '@playwright/test';

test('legacy promotion deep links land in Review with read-only controls for members', async ({ page }) => {
  await page.goto('/iq/library');
  await page.request.post('/api/session/role', { data: { role: 'member' } });
  await page.goto('/iq/promotions/promo-aurora-cold-start?status=all&extra=kept#observation-obs-aurora-1');
  await expect(page.getByTestId('distillation-promotions')).toBeVisible();
  await expect(page).toHaveURL(/\/iq\/distillation\/review\?.*view=promotions/);
  const url = new URL(page.url());
  expect(url.searchParams.get('item')).toBe('promo-aurora-cold-start');
  expect(url.searchParams.get('extra')).toBe('kept');
  expect(url.hash).toBe('#observation-obs-aurora-1');
  await expect(page.getByText('Promoting or dismissing a candidate needs Manage bots.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve + record a passing dry run', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Promotions', exact: true })).toHaveCount(0);
  await page.getByLabel('Promotion status').selectOption('dismissed');
  await expect(page.getByText('No candidates in this view')).toBeVisible();
});

test('promotion retains explicit dry-run approval and dismissed history in Review', async ({ page }) => {
  await page.goto('/iq/library');
  await page.request.post('/api/session/role', { data: { role: 'org-leader' } });
  const { candidates } = await (await page.request.get('/api/promotions')).json();
  const candidate = candidates.find((c: { id: string }) => c.id === 'promo-aurora-cold-start');
  candidate.status = 'candidate'; candidate.dryRunPassed = null;
  let submitted: unknown;
  await page.route('**/api/promotions', (route) => route.fulfill({ json: { candidates } }));
  await page.route(`**/api/promotions/${candidate.id}`, (route) => route.fulfill({ json: candidate }));
  await page.route(`**/api/promotions/${candidate.id}/promote`, (route) => {
    submitted = route.request().postDataJSON();
    candidate.status = 'promoted'; candidate.dryRunPassed = true;
    return route.fulfill({ json: candidate });
  });
  await page.goto(`/iq/distillation/review?view=promotions&item=${candidate.id}`);
  await page.getByRole('button', { name: 'Approve + record a passing dry run', exact: true }).click();
  await expect(page.getByText('Approval: Recorded · Dry run: Passed')).toBeVisible();
  expect(submitted).toEqual({ dryRunPassed: true });
  await expect(page.getByTestId('distillation-promotions-pane').getByText('Promoted — review release readiness in Agent library before enabling execution.')).toBeVisible();
  await expect(page.getByTestId('distillation-promotions-pane').getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(0);
  // The UI reads server state, including dismissed history; no live fixture mutation.
  candidate.status = 'dismissed'; candidate.rationale += ' — dismissed: superseded';
  await page.goto(`/iq/distillation/review?view=promotions&status=dismissed&item=${candidate.id}`);
  await expect(page.getByText('Dismissed — not going forward.')).toBeVisible();
  await expect(page.getByText(/dismissed: superseded/)).toBeVisible();
});

test('library deep links retain asset inputs, versions and usage under Build', async ({ page }) => {
  await page.goto('/iq/library/lib-stakeholder-email');
  await expect(page.getByTestId('catalog-explorer')).toBeVisible();
  await expect(page.getByText('Contract', { exact: true })).toBeVisible();
  await expect(page.getByText('Health & usage', { exact: true })).toBeVisible();
  await expect(page.getByTestId('section-crumbs').getByText('Build', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Agent library', exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/iq\/library\/lib-stakeholder-email$/);
});

test('knowledge reviews keep their own sample selection and verdict actions', async ({ page }) => {
  await page.goto('/iq/library');
  await page.request.post('/api/session/role', { data: { role: 'org-leader' } });
  const { samples } = await (await page.request.get('/api/distillation/review')).json();
  const pending = samples.find((sample: { verdict: string }) => sample.verdict === 'pending');
  await page.goto(`/iq/distillation/review?sample=${pending.id}`);
  await expect(page.getByTestId('review-claim')).toBeVisible();
  await expect(page.getByTestId('review-agree')).toBeVisible();
  await expect(page.getByText('This records your review; it does not publish the guide.')).toBeVisible();
  await expect(page.getByTestId('distillation-promotions')).toHaveCount(0);
});
