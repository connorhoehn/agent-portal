import { loginAs } from './realSession';
import { test, expect } from './cdpTest';
import { writeFile } from 'node:fs/promises';

test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5261' });
const URL = '/iq/projects/p-auth-migration?tab=work&item=wi-auth-e2-b3';
const TITLE = 'Logout leaves the legacy shim cookie alive';

for (const { role, width, height, canEdit } of [
  { role: 'org-leader', width: 1440, height: 900, canEdit: true },
  { role: 'hr-admin', width: 1280, height: 720, canEdit: true },
  { role: 'program-owner', width: 1024, height: 768, canEdit: true },
  { role: 'sme', width: 1280, height: 720, canEdit: true },
  { role: 'member', width: 1280, height: 720, canEdit: false },
]) {
  test(`${role} keeps selected Work, rail navigation and permissions at ${width}×${height}`, async ({ browser, baseURL }, testInfo) => {
    const context = await browser.newContext({ baseURL, viewport: { width, height } });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      const userId = role === 'member' ? 'u-vera' : role === 'program-owner' ? 'u-mia' : role === 'sme' ? 'u-nora' : 'u-rachel';
      await loginAs(context, userId, baseURL);
      expect((await page.request.post('/api/session/role', { data: { role } })).status()).toBe(200);
      await page.goto(URL);
      const rail = page.getByTestId('initiative-work-rail');
      const detail = page.getByTestId('work-item-detail');
      await expect(rail).toBeVisible();
      await expect(detail.getByTestId('work-item-detail-title')).toHaveText(TITLE);
      // A focused item's header is only the initiative's action cluster (no title band).
      await expect(page.getByTestId('initiative-header').getByTestId('initiative-header-actions')).toBeVisible();
      await expect(page.getByTestId('initiative-header').getByRole('heading', { name: 'Auth Migration', exact: true })).toHaveCount(0);
      await expect(rail.getByText(TITLE, { exact: true })).toBeVisible();
      const checkboxCount = await rail.getByRole('checkbox').count();
      expect(canEdit ? checkboxCount > 0 : checkboxCount === 0).toBe(true);
      if (!canEdit) {
        expect((await page.request.patch('/api/graph/work-items/wi-auth-e2-b3', { data: { priority: 'high' } })).status()).toBe(403);
        await expect(page.getByTestId('work-document-links').getByRole('button', { name: 'Add link' })).toHaveCount(0);
      }
      const search = rail.getByPlaceholder('Find work…');
      await search.fill('Refresh loop');
      await expect(rail.getByText('Refresh loop when a grant is revoked mid-session', { exact: true })).toBeVisible();
      await expect(detail.getByTestId('work-item-detail-title')).toHaveText(TITLE);
      await rail.getByText('Refresh loop when a grant is revoked mid-session', { exact: true }).click();
      await expect(page).toHaveURL(/item=wi-auth-e1-b4/);
      await expect(detail.getByTestId('work-item-detail-title')).toHaveText('Refresh loop when a grant is revoked mid-session');
      await search.fill('');
      const sectionFont = await detail.getByText('Why this matters', { exact: true }).evaluate(element => getComputedStyle(element).fontSize);
      expect(sectionFont).toBe('16px');
      if (canEdit) {
        const actionFont = await detail.getByRole('button', { name: 'Add outcome', exact: true }).evaluate(element => getComputedStyle(element).fontSize);
        expect(actionFont).toBe('14px');
      }
      const geometry = await page.evaluate(() => {
        const rect = (id: string) => {
          const r = document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect();
          return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const title = document.querySelector('[data-testid="work-item-detail-title"]')!;
        return { viewportWidth: innerWidth, viewportHeight: innerHeight, documentWidth: document.documentElement.scrollWidth,
          rail: rect('initiative-work-rail'), detail: rect('work-item-detail'),
          // The composer lives in the shell's conversation pane (the fourth column), never in the content.
          composerInContent: !!document.querySelector('[data-testid="explorer-layout-pane"] [data-testid="initiative-composer"]'),
          composer: (() => { const e = document.querySelector('[data-testid="page-conversation-pane"] [data-testid="initiative-composer"]'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom }; })(),
          titleFont: getComputedStyle(title).fontSize, titleClipped: title.scrollWidth > title.clientWidth };
      });
      await page.screenshot({ path: testInfo.outputPath(`focused-work-${role}.png`) });
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.rail.right).toBeLessThanOrEqual(geometry.detail.x);
      expect(geometry.composerInContent).toBe(false);
      // Open (wide windows) it sits right of the item, inside the window; a narrow window collapses it to Message.
      if (geometry.composer) {
        expect(geometry.composer.x).toBeGreaterThanOrEqual(geometry.detail.right - 1);
        expect(geometry.composer.bottom).toBeLessThanOrEqual(height);
      }
      expect(geometry.titleFont).toBe('26px');
      expect(geometry.titleClipped).toBe(false);
      const geometryPath = testInfo.outputPath(`focused-work-${role}-geometry.json`);
      await writeFile(geometryPath, JSON.stringify(geometry, null, 2) + '\n');
      await testInfo.attach('focused-work-geometry', { path: geometryPath, contentType: 'application/json' });
      await page.getByTestId('initiative-all-work').click();
      await expect(page).not.toHaveURL(/item=/);
      await expect(page.getByTestId('initiative-work-list')).toBeVisible();
      await page.getByTestId('initiative-work-list').getByText(TITLE, { exact: true }).click();
      await page.getByTestId('focused-work-navigation').getByRole('tab', { name: 'Decisions', exact: true }).click();
      await expect(page).toHaveURL(/tab=decisions/);
      await expect(page.getByTestId('initiative-work-rail')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
}

test('changing initiative from focused Work drops the old item and keeps canonical navigation', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  try {
    await loginAs(context, 'u-rachel', baseURL);
    await page.goto(URL);
    const select = page.getByTestId('focused-work-navigation').getByRole('combobox', { name: 'Initiative', exact: true });
    await expect.poll(() => select.locator('option').count()).toBeGreaterThan(1);
    const next = await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)
      .find(value => value !== 'p-auth-migration'));
    expect(next).toBeTruthy();
    await select.selectOption(next!);
    await expect(page).toHaveURL(new RegExp(`/iq/projects/${next}\\?.*tab=work`));
    await expect(page).not.toHaveURL(/item=/);
    await expect(page.getByTestId('initiative-work-list')).toBeVisible();
    await expect(page.getByTestId('work-item-detail')).toHaveCount(0);
  } finally { await context.close(); }
});

test('narrow Work keeps the full title and composer usable with keyboard-accessible list navigation', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await loginAs(context, 'u-rachel', baseURL);
    expect((await page.request.post('/api/session/role', { data: { role: 'hr-admin' } })).status()).toBe(200);
    await page.goto(URL);
    const detail = page.getByTestId('work-item-detail');
    await expect(detail.getByTestId('work-item-detail-title')).toHaveText(TITLE);
    await expect(page.getByTestId('initiative-work-rail')).toHaveCount(0);
    const showList = page.getByRole('button', { name: 'Show work items', exact: true });
    await expect(showList).toBeVisible();
    const geometry = await page.evaluate(() => {
      const title = document.querySelector('[data-testid="work-item-detail-title"]')!;
      const detail = document.querySelector('[data-testid="work-item-detail"]')!.getBoundingClientRect();
      const inContent = !!document.querySelector('[data-testid="explorer-layout-pane"] [data-testid="initiative-composer"]');
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth,
        titleClipped: title.scrollWidth > title.clientWidth, detailBottom: detail.bottom, inContent,
        paneShown: !!document.querySelector('[data-testid="page-conversation-pane"]') };
    });
    await page.screenshot({ path: testInfo.outputPath('focused-work-narrow.png') });
    expect(geometry.documentWidth).toBeLessThanOrEqual(390);
    expect(geometry.titleClipped).toBe(false);
    // A phone-width window collapses the conversation pane to the footer's Message; the content draws no composer.
    expect(geometry.inContent).toBe(false);
    expect(geometry.paneShown).toBe(false);
    expect(geometry.detailBottom).toBeLessThanOrEqual(844);
    const geometryPath = testInfo.outputPath('focused-work-narrow-geometry.json');
    await writeFile(geometryPath, JSON.stringify(geometry, null, 2) + '\n');
    await testInfo.attach('focused-work-geometry', { path: geometryPath, contentType: 'application/json' });
    await showList.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Work items', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(showList).toBeFocused();
    await showList.click();
    await dialog.getByPlaceholder('Find work…').fill('Refresh loop');
    await dialog.getByText('Refresh loop when a grant is revoked mid-session', { exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/item=wi-auth-e1-b4/);
    await expect(detail.getByTestId('work-item-detail-title')).toHaveText('Refresh loop when a grant is revoked mid-session');
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
