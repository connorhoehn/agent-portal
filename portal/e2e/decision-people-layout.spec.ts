import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

for (const theme of ['light', 'dark']) test(`record rails, people photos and initiative details: ${theme}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const writes: string[] = [];
  const actor = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1440, height: 1000 },
    prepare: async context => {
      await context.addInitScript(value => { localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme: value })); localStorage.setItem('shell.conversation-pane.open', '0'); }, theme);
      await context.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
    },
  });
  try {
    const page = actor.page;
    page.setDefaultTimeout(15_000);
    await page.goto('/iq/decisions/d-cognito-cutover');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark')).toBe(theme === 'dark');
    const record = page.getByTestId('decision-record');
    await expect(record).toBeVisible();
    const photos = record.locator('img');
    await expect(photos).toHaveCount(5);
    await expect.poll(() => photos.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    const rail = page.locator('nav[aria-label="Explorer"]');
    await expect(rail.locator('[data-testid$="row-subline-d-cognito-cutover"]')).toHaveText('Auth Migration');
    await expect(rail.getByRole('button', { name: 'Cutover order for legacy SSO tenants Auth Migration', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`decisions-${theme}.png`) });
    await page.goto('/iq/designs/des-auth-rotation?status=awaiting_input');
    const design = page.getByTestId('design-thread');
    await expect(design).toBeVisible();
    await expect.poll(() => design.locator('img').count()).toBeGreaterThan(3);
    await expect.poll(() => design.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`design-photos-${theme}.png`) });
    await page.goto('/iq/projects/p-inference-platform?scope=all&tab=work');
    const workPhotos = page.getByTestId('initiative-work-list').locator('img[src="/avatars/photos/p-049.jpg"]');
    await expect(workPhotos).toHaveCount(2);
    await expect.poll(() => workPhotos.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    await page.getByTestId('initiative-details-trigger').click();
    const pane = page.getByTestId('initiative-pane');
    const facts = page.getByTestId('initiative-facts');
    await expect(facts).toContainText('Paolo Mancini');
    await expect(facts).toContainText('Caleb Turner');
    await expect(facts.locator('img')).toHaveCount(3);
    await expect.poll(() => facts.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      // Ordinary panes auto-collapse when crossing the narrow layout threshold.
      await page.getByTestId('initiative-details-trigger').click();
      await expect(pane).toBeVisible();
      await expect(facts).toBeVisible();
      expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`details-${width}-${theme}.png`) });
    }
    await pane.getByRole('button', { name: 'Open work item ORG-INF-4' }).click();
    await expect(pane).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Cold-start p99 breaches SLA after scale-to-zero' })).toBeVisible();
    const sprintsResponse = await page.request.get('/api/sprints?scope=all');
    expect(sprintsResponse.ok()).toBe(true);
    const sprintData = await sprintsResponse.json();
    expect(sprintData.sprints.some((sprint: { stewardAvatarUrl?: string }) => sprint.stewardAvatarUrl)).toBe(true);
    expect(writes).toEqual([]); expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});
