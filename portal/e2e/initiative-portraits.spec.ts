import { expect, test, type Locator } from '@playwright/test';
import { openAsClone } from './realSession';

test.use({ viewport: { width: 1440, height: 1000 } });

async function loaded(img: Locator) {
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
}

for (const theme of ['light', 'dark']) test(`All initiatives preserves team portraits and spend alignment: ${theme}`, async ({ browser }) => {
  const person = await openAsClone(browser, 'u-operator', { landing: null, viewport: { width: 1440, height: 1000 }, prepare: async context => {
    await context.addInitScript(theme => localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme })), theme);
  } });
  try {
    const { page } = person;
    const writes: string[] = [];
    await page.route('**/api/**', route => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
      writes.push(route.request().url()); return route.abort();
    });
    await page.goto('/iq/projects?scope=all');
    const projects = await (await page.request.get('/api/graph/projects?scope=all&limit=100')).json();
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      const row = page.getByRole('cell').getByRole('link', { name: project.name, exact: true }).locator('xpath=ancestor::tr');
      await expect(row).toBeVisible();
      expect(project.team.length).toBeGreaterThan(0);
      for (const member of project.team.slice(0, 4)) {
        const img = row.getByRole('img', { name: member.name, exact: true });
        await expect(img).toHaveAttribute('src', member.avatarUrl);
        await loaded(img);
      }
    }
    const spend = page.getByTestId('datatable-header-agentSpendUsd');
    await expect(spend).toHaveCSS('text-align', 'left');
    const column = await spend.evaluate(el => (el as HTMLTableCellElement).cellIndex);
    const cells = page.locator(`tbody tr td:nth-child(${column + 1})`);
    expect(await cells.count()).toBe(projects.length);
    for (const cell of await cells.all()) {
      const value = cell.getByTestId('initiative-spend-value');
      await expect(value).toHaveCSS('justify-content', 'flex-end');
      const rightInset = await cell.evaluate(td => {
        const value = td.querySelector('[data-testid="initiative-spend-value"]')!.lastElementChild!;
        return td.getBoundingClientRect().right - value.getBoundingClientRect().right - parseFloat(getComputedStyle(td).paddingRight);
      });
      expect(Math.abs(rightInset)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: test.info().outputPath(`all-initiatives-${theme}.png`) });
    expect(writes).toEqual([]);
  } finally { await person.close(); }
});

for (const width of [1440, 900]) for (const theme of ['light', 'dark']) test(`initiative overview, work and demo presence preserve portraits: ${theme}/${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
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
    const next = overview.getByTestId('overview-up-next');
    const recent = overview.getByTestId('overview-recent-activity-list');
    const nextTitle = next.locator('button > span > span[title]').first();
    const nextKey = next.getByTestId('action-row-description').first();
    const recentTitle = recent.locator('button > span > span[title]').first();
    await expect(nextKey).toHaveText(/^ORG-/);
    await expect(next.getByTestId('action-row-leading')).toHaveCount(0);
    const titleBox = (await nextTitle.boundingBox())!;
    const keyBox = (await nextKey.boundingBox())!;
    const recentBox = (await recentTitle.boundingBox())!;
    expect(keyBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    expect(Math.abs(keyBox.x - titleBox.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(recentBox.x - titleBox.x)).toBeLessThanOrEqual(1);
    const nextAvatars = next.getByTestId('action-row-person').locator('[data-ui-text="avatar"]');
    const recentAvatars = recent.getByTestId('action-row-person').locator('[data-ui-text="avatar"]');
    await expect(nextAvatars.first()).toBeVisible();
    await expect(recentAvatars.first()).toBeVisible();
    const avatarX = (await recentAvatars.first().boundingBox())!.x;
    for (const avatar of [...await nextAvatars.all(), ...await recentAvatars.all()]) {
      const box = (await avatar.boundingBox())!;
      expect(Math.abs(box.x - avatarX)).toBeLessThanOrEqual(1);
      expect(box.width).toBe(24);
    }
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
