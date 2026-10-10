import { test, expect } from '@playwright/test';
import { LANDINGS, LANDING_LIST, LANDING_USERS, TENANTS } from './route-inventory';
import { signIn } from './realSession';

// Every section landing opens its first child's content: never a "Browse …/Explore …" placeholder.
// Runs against the running dev stack (never restarts anything). Login: one call per tenant user.
test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183' });

const PLACEHOLDER = /Browse (initiatives|designs|agent library)|Choose (All initiatives|a view from the menu)|to open (its list|its records)/i;

// The landings and who opens them live in the route inventory.
const SUITES = TENANTS.map((tenant) => ({ tenant, user: LANDING_USERS[tenant], paths: LANDINGS.filter(([t]) => t === tenant).map(([, p]) => p), list: LANDING_LIST }));

for (const { tenant, user, paths, list } of SUITES) {
  test(`${tenant}: section landings show real content`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await signIn(page, user);
    for (const path of paths) {
      await page.goto(path);
      await expect(page.locator('main').first()).toBeVisible({ timeout: 20_000 });
      const body = page.locator('body');
      await expect(body, path).not.toContainText(PLACEHOLDER);
      await expect.poll(async () => (await page.locator('main').first().innerText()).trim().length, { message: `${path} has content`, timeout: 15_000 }).toBeGreaterThan(40);
      if (path === list) {
        const active = page.getByRole('link', { name: 'All initiatives' }).first();
        await expect(active).toHaveAttribute('aria-current', 'page');
        const row = page.getByText('Observability Platform').first();
        await expect(row).toBeVisible({ timeout: 15_000 });
        const box = await row.boundingBox();
        expect(box!.y, 'first list row above the fold').toBeLessThanOrEqual(640);
      }
    }
  });
}
