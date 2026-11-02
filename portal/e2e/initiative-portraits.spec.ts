import { expect, test, type Locator } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 1000 } });

async function loaded(img: Locator) {
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
}

for (const theme of ['light', 'dark']) test(`initiative overview, work and demo presence preserve portraits: ${theme}`, async ({ page }) => {
  const writes: string[] = [];
  await page.addInitScript(theme => {
    localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme }));
    localStorage.setItem('shell.conversation-pane.open', '0');
  }, theme);
  await page.route('**/api/**', route => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
    writes.push(route.request().url()); return route.abort();
  });
  for (const project of ['p-llm-platform', 'p-observability']) {
    await page.goto(`/iq/projects/${project}?scope=all&tab=overview`);
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme === 'dark')).toBe(theme === 'dark');
    const overview = page.getByTestId('initiative-overview');
    await expect(overview.getByTestId('overview-up-next')).toBeVisible();
    const response = await page.request.get(`/api/graph/projects/${project}`);
    expect(response.ok()).toBe(true);
    const { contributors } = await response.json();
    const portraits = new Map(contributors.map((p: { name: string; avatarUrl: string }) => [p.name, p.avatarUrl]));
    const people = overview.locator('[data-ui-text="avatar"]:visible');
    await expect(people.first()).toBeVisible();
    await expect.poll(() => people.evaluateAll((avatars, expected: Record<string, string>) => avatars.length > 0 && avatars.every(person => {
      const img = person.querySelector('img');
      return img && img.getAttribute('src') === expected[person.getAttribute('title') ?? ''] && img.complete && img.naturalWidth > 0;
    }), Object.fromEntries(portraits))).toBe(true);
    if (project === 'p-observability') await loaded(overview.getByTestId('overview-attention').locator('img[alt="Eli Garcia"]:visible').first());
    const presence = page.getByTestId('initiative-workspace').locator('[data-presence-user-id="demo-user"] img').first();
    await expect(presence).toHaveAttribute('src', '/avatars/photos/demo-user.jpg');
    await loaded(presence);
    await page.screenshot({ path: test.info().outputPath(`${project}-${theme}.png`) });
  }
  const directory = await page.request.get('/api/people/shared');
  expect((await directory.json()).me.avatarUrl).toBe('/avatars/photos/demo-user.jpg');
  await page.goto('/iq/projects/p-llm-platform?scope=all&tab=work');
  const owners = page.getByTestId('initiative-work-list').getByTestId('work-table-owner-cell');
  await loaded(owners.locator('img[alt="Nina Rivera"]').first());
  await loaded(owners.locator('img[alt="Caleb Turner"]').first());
  await loaded(owners.locator('img[alt="Katya Petrov"]').first());
  // A genuinely missing portrait still renders initials, without borrowing a namesake's image.
  await page.route('**/api/graph/projects/p-llm-platform', async route => {
    const response = await route.fetch(); const project = await response.json();
    project.contributors = project.contributors.map((p: { personId: string }) => p.personId === 'p-047' ? { ...p, avatarUrl: null } : p);
    await route.fulfill({ response, json: project });
  });
  await page.goto('/iq/projects/p-llm-platform?scope=all&tab=overview');
  const nina = page.getByTestId('initiative-overview').locator('[data-ui-text="avatar"][title="Nina Rivera"]:visible');
  await expect(nina.first()).toHaveText('NR');
  await expect(nina.locator('img')).toHaveCount(0);
  expect(writes).toEqual([]);
});
