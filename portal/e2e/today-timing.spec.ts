import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

for (const theme of ['light', 'dark']) test(`Today opens its pending question and run timing uses recorded milestones: ${theme}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const writes: string[] = [];
  const actor = await openAsClone(browser, 'u-release', {
    role: 'org-leader', expectTenant: 'orgiq', landing: null, viewport: { width: 1440, height: 1000 },
    prepare: async context => {
      await context.addInitScript(theme => {
        localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme }));
        localStorage.setItem('work.today-placement.v1', 'header');
        localStorage.setItem('shell.conversation-pane.open', '0');
      }, theme);
      await context.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
    },
  });
  try {
    const page = actor.page; page.setDefaultTimeout(15_000);
    const response = await page.request.get('/api/today');
    expect(response.ok()).toBe(true);
    const review = (await response.json()).items.find((item: { category: string }) => item.category === 'review');
    expect(review.action.label).toBe('Open question');
    const consultId = new URL(review.action.href, 'http://localhost').searchParams.get('consult');
    const consultResponse = await page.request.get(`/api/lab/consults/${encodeURIComponent(consultId!)}`);
    const { consult } = await consultResponse.json();
    expect(consult.status).toBe('pending'); expect(review.detail).toContain(consult.question);
    await page.goto('/iq/projects');
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark')).toBe(theme === 'dark');
    await page.getByRole('button', { name: /^Today: Needs review/ }).click();
    const detail = page.getByRole('dialog', { name: 'Today details' });
    await expect(detail).toContainText(consult.question);
    await detail.getByRole('button', { name: 'Open question' }).click();
    await expect(page).toHaveURL(new RegExp(`/iq/work\\?consult=${consultId}`));
    await expect(page.getByTestId('collection-command-composer-prompts')).toContainText(consult.question);
    await page.screenshot({ path: test.info().outputPath(`linked-question-${theme}.png`) });
    // A deep link must still work outside the first pending-list page.
    await page.route('**/api/lab/consults?status=pending', route => route.fulfill({ json: { consults: [] } }));
    await page.reload();
    await expect(page.getByTestId('collection-command-composer-prompts')).toContainText(consult.question);
    await page.unroute('**/api/lab/consults?status=pending');
    // An answered detail beats a stale pending-list response.
    await page.route(`**/api/lab/consults/${consultId}`, route => route.fulfill({ json: { consult: { ...consult, status: 'answered' } } }));
    await page.reload();
    await expect(page.getByText('This question is answered.', { exact: false })).toBeVisible();
    await expect(page.getByTestId('collection-command-composer-prompts')).not.toContainText(consult.question);
    await page.unroute(`**/api/lab/consults/${consultId}`);
    await page.goto('/iq/work/job-inf-maint-1');
    const jobResponse = await page.request.get('/api/work/jobs/job-inf-maint-1');
    const job = await jobResponse.json();
    const timing = page.getByRole('list', { name: 'Run timing' });
    await expect(timing).toBeVisible(); await expect(timing.getByRole('listitem')).toHaveCount(4);
    if (job.status === 'done') {
      await expect(timing.locator('[data-state="done"]')).toHaveCount(4);
      await expect(timing.locator('[aria-current="step"]')).toHaveCount(0);
    }
    expect((await timing.boundingBox())!.y).toBeLessThan((await page.getByRole('tablist', { name: 'Run details' }).boundingBox())!.y);
    await expect(page.getByRole('heading', { name: 'Recorded tool results' })).toHaveCount(0);
    await page.getByRole('tab', { name: /^Outputs/ }).click();
    await expect(page.getByRole('heading', { name: 'Recorded tool results' })).toBeVisible();
    await page.getByRole('tab', { name: 'Summary', exact: true }).click();
    for (const timestamp of [job.createdAt, job.claimedAt, job.startedAt, job.finishedAt]) {
      if (timestamp) await expect(timing).toContainText(await page.evaluate(time => new Date(time).toLocaleString(), timestamp));
    }
    for (const width of [1440, 900]) {
      await page.setViewportSize({ width, height: 1000 });
      await timing.scrollIntoViewIfNeeded();
      expect((await timing.boundingBox())!.width).toBeLessThanOrEqual(520);
      for (const step of await timing.getByRole('listitem').all()) {
        const b = (await step.boundingBox())!; const track = (await timing.boundingBox())!;
        expect(b.x + b.width).toBeLessThanOrEqual(track.x + track.width + 1);
      }
      const connected = await timing.evaluate(el => [...el.querySelectorAll('[data-workflow-connector]')].every(line => {
        const next = line.closest('li')?.nextElementSibling?.firstElementChild?.firstElementChild;
        return !!next && Math.abs(line.getBoundingClientRect().right - next.getBoundingClientRect().left) < 1;
      }));
      expect(connected).toBe(true);
      await expect(page.getByRole('heading', { name: 'Technical details' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`timing-${width}-${theme}.png`) });
    }
    expect(writes).toEqual([]); expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});
