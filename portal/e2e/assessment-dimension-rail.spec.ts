import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5_000, navigationTimeout: 10_000 });

test('TEAM-005 dimension rail is readable and retains grouped keyboard navigation', async ({ page }) => {
  const principal = await signIn(page, 'u-asha', { expectTenant: 'assessment' });
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/assessment\//.test(new URL(request.url()).pathname)) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const teamResponse = await page.request.get('/api/assessment/teams/TEAM-005');
  expect(teamResponse.status()).toBe(200);
  const before = await teamResponse.json();
  await page.goto('/assessment/teams/TEAM-005');
  const rail = page.getByTestId('assessment-dimension-master-detail-rail');
  await expect(rail).toBeVisible();
  if (await rail.getAttribute('data-collapsed') === 'true') await page.getByRole('button', { name: 'Show dimensions', exact: true }).click();
  const list = page.getByTestId('dimension-rail');
  await expect(list).toBeVisible();
  const measure = () => rail.evaluate(element => ({ width: element.getBoundingClientRect().width,
    heading: [...element.querySelectorAll('h2 span')].map(node => ({ text: node.textContent, width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth })),
    titles: [...element.querySelectorAll('[data-focus-key^="r:"] .truncate[title]')].map(node => ({ text: node.textContent,
      width: node.getBoundingClientRect().width, scrollWidth: node.scrollWidth, fontSize: getComputedStyle(node).fontSize, whiteSpace: getComputedStyle(node).whiteSpace })),
  }));
  await expect(page.getByTestId('assessment-dimension-master-detail-rail-title')).toContainText('Dimensions');
  await expect(page.getByTestId('dimension-rail-group-count-claims')).toHaveText('5');
  await expect(page.getByTestId('dimension-rail-group-count-unassessed')).toHaveText('12');
  await expect(list.locator('[data-row-id]')).toHaveCount(17);
  await expect(page.getByTestId('dimension-rail-row-subline-1')).toContainText('Verified');
  await expect(page.getByTestId('dimension-rail-row-subline-1')).toContainText('Claim L2');
  await expect(page.getByTestId('dimension-rail-row-subline-1')).toContainText('Low confidence');
  await expect(page.getByTestId('dimension-rail-row-subline-6')).toContainText('Not yet assessed');
  const first = page.getByTestId('dimension-rail-row-open-1'), second = page.getByTestId('dimension-rail-row-open-2');
  await first.focus(); await first.press('ArrowDown'); await expect(second).toBeFocused(); await second.press('Enter');
  await expect(page.getByTestId('dimension-rail-row-2')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: 'Continuous Delivery (CD)', exact: true })).toBeVisible();
  await second.press('ArrowLeft');
  const claimsGroup = page.getByTestId('dimension-rail-group-toggle-claims');
  await expect(claimsGroup).toBeFocused(); await expect(claimsGroup).toHaveAttribute('aria-expanded', 'false');
  await claimsGroup.press('ArrowRight'); await expect(second).toBeVisible();
  await page.getByTestId('dimension-rail-filter').getByRole('radio', { name: 'Open claims 5', exact: true }).click();
  await expect(list.locator('[data-row-id]')).toHaveCount(5);
  await expect(page.getByTestId('dimension-rail-group-unassessed')).toHaveCount(0);
  await expect(page.getByTestId('assessment-dimension-master-detail-rail-count')).toHaveText('5');
  await page.getByTestId('dimension-rail-filter').getByRole('radio', { name: 'All 17', exact: true }).click();
  await expect(list.locator('[data-row-id]')).toHaveCount(17);
  await expect(page.getByTestId('dimension-rail-row-2')).toHaveAttribute('aria-current', 'true');
  const wide = await measure();
  expect(wide.titles).toHaveLength(17);
  for (const title of wide.titles) { expect(title.whiteSpace).toBe('normal'); expect(title.scrollWidth).toBeLessThanOrEqual(title.width + 1); }
  await page.screenshot({ path: test.info().outputPath('dimension-rail-wide.png') });
  await page.setViewportSize({ width: 1024, height: 768 });
  if (await rail.getAttribute('data-collapsed') === 'true') await page.getByRole('button', { name: 'Show dimensions', exact: true }).click();
  await expect(list).toBeVisible();
  await second.focus(); await second.press('End');
  const last = page.getByTestId('dimension-rail-row-open-17');
  await expect(last).toBeFocused(); await last.press('Enter');
  await expect(page.getByTestId('dimension-rail-row-17')).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('heading', { name: 'Engineering Metrics & Continuous Improvement', exact: true })).toBeVisible();
  const narrow = await measure();
  for (const title of narrow.titles) expect(title.scrollWidth).toBeLessThanOrEqual(title.width + 1);
  expect(narrow.heading[0].scrollWidth).toBeLessThanOrEqual(narrow.heading[0].width + 1);
  await page.screenshot({ path: test.info().outputPath('dimension-rail-narrow.png') });
  await page.getByRole('button', { name: 'Hide dimensions', exact: true }).click();
  await expect(rail).toHaveAttribute('data-collapsed', 'true');
  await page.getByRole('button', { name: 'Show dimensions', exact: true }).click();
  await expect(list).toBeVisible();
  await expect(page.getByTestId('dimension-rail-row-17')).toHaveAttribute('aria-current', 'true');
  const after = await (await page.request.get('/api/assessment/teams/TEAM-005')).json();
  expect(after.dimensions).toEqual(before.dimensions);
  expect(errors).toEqual([]); expect(writes).toEqual([]);
  await writeFile(test.info().outputPath('dimension-rail.json'), JSON.stringify({ principal, wide, narrow, noAssessmentWrites: true, errors }, null, 2));
});
