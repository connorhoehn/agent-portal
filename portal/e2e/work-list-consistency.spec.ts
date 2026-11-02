import { expect, test } from '@playwright/test';

for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
  test(`Overview and Work share row anatomy: ${theme}/${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(theme => {
      localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme }));
      localStorage.setItem('shell.conversation-pane.open', '0');
    }, theme);
    const writes: string[] = [];
    await page.route('**/api/**', route => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
      writes.push(route.request().url()); return route.abort();
    });
    for (const project of ['p-observability', 'p-llm-platform']) {
      await page.goto(`/iq/projects/${project}?scope=all&tab=overview`);
      const overview = page.getByTestId('overview-up-next');
      const title = overview.locator('button > span > span[title]').first();
      await expect(title).toBeVisible();
      const expectedTitle = (await title.boundingBox())!;
      const expectedAvatar = (await overview.locator('[data-ui-text="avatar"]').first().boundingBox())!;
      await page.getByRole('tab', { name: /^Work\b/ }).click();
      const list = page.getByTestId('initiative-work-list');
      const rows = list.locator('[data-work-row]');
      await expect(rows.first()).toBeVisible();
      for (const row of await rows.all()) {
        const title = row.locator('[data-work-title]');
        const reference = row.locator('[data-work-reference]');
        await expect(title).toHaveCSS('font-size', '14px');
        await expect(title).toHaveCSS('font-weight', '500');
        await expect(reference).toHaveCSS('font-size', '12px');
        const titleBox = (await title.boundingBox())!;
        const referenceBox = (await reference.boundingBox())!;
        expect(Math.abs(titleBox.x - expectedTitle.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(referenceBox.x - titleBox.x)).toBeLessThanOrEqual(1);
        expect(referenceBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
        const avatars = row.locator('[data-ui-text="avatar"]');
        if (await avatars.count()) {
          const avatarBox = (await avatars.boundingBox())!;
          expect(avatarBox.width).toBe(24);
          expect(Math.abs(avatarBox.x - expectedAvatar.x)).toBeLessThanOrEqual(1);
          await expect.poll(() => avatars.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`${project}-${theme}-${width}.png`) });
      // Public keys remain searchable; clicking the owner opens the same item.
      const firstKey = await rows.first().locator('[data-work-reference]').innerText();
      await list.getByRole('textbox', { name: 'Search work' }).fill(firstKey);
      await expect(rows).toHaveCount(1);
      const id = await rows.first().getAttribute('data-work-row');
      await rows.first().getByTestId('work-table-owner-cell').click();
      await expect(page).toHaveURL(new RegExp(`item=${id}`));
      await expect(page.getByTestId('initiative-work-rail').getByText(firstKey, { exact: true })).toBeVisible();
    }
    expect(writes).toEqual([]);
  });
}

test('every initiative Work list uses the shared row profile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/**', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) ? route.continue() : route.abort());
  await page.goto('/iq/projects?scope=all');
  const response = await page.request.get('/api/graph/projects?scope=all&limit=100');
  expect(response.ok()).toBe(true);
  const projects = await response.json();
  expect(projects.length).toBeGreaterThan(5);
  const coverage: Array<{ id: string; rows: number }> = [];
  for (const project of projects) {
    await page.goto(`/iq/projects/${project.id}?scope=all&tab=work`);
    const list = page.getByTestId('initiative-work-list');
    await expect(list).toBeVisible();
    await expect(list.getByText('Loading work…')).toHaveCount(0);
    const rows = list.locator('[data-work-row]');
    coverage.push({ id: project.id, rows: await rows.count() });
    for (const row of await rows.all()) {
      await expect(row.locator('[data-work-title]')).toHaveCSS('font-size', '14px');
      await expect(row.locator('[data-work-reference]')).toHaveCSS('font-size', '12px');
      await expect(row.getByTestId('work-table-owner-cell')).toHaveCSS('width', '184px');
    }
  }
  expect(coverage.reduce((total, project) => total + project.rows, 0)).toBeGreaterThan(20);
  await test.info().attach('initiative-work-coverage', { body: JSON.stringify(coverage, null, 2), contentType: 'application/json' });
});
