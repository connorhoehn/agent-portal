// The shell footer (Huddle + Message) must exist exactly once on every route
// the nav/palette registry lists, in every tenant. The footer is mounted once
// in Layout, so no page layout can drop it; this sweep proves it.
import { test, expect } from '@playwright/test';
import { TENANTS, readRegistryPaths, tenantOf } from './route-inventory';
import { signIn } from './realSession';

const BASE = 'http://127.0.0.1:5183';
test.use({ baseURL: BASE, viewport: { width: 1680, height: 940 } });
test.describe.configure({ mode: 'serial' });

// The registry half of the route inventory: every concrete palette/rail path.
const routes = readRegistryPaths();

test('registry yields routes for every tenant', () => {
  for (const t of TENANTS) expect(routes.filter(p => tenantOf(p) === t).length, t).toBeGreaterThan(0);
});

for (const tenant of TENANTS) {
  test(`footer on every ${tenant} route`, async ({ page }) => {
    test.setTimeout(30 * 60_000);
    await signIn(page, 'u-operator', { tenant });
    // /settings is universal; check it once under orgiq.
    const mine = routes.filter(p => tenantOf(p) === tenant || (tenant === 'orgiq' && !/^\/(assessment|social|pipelines)/.test(p)));
    const failures: string[] = [];
    for (const route of mine) {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      const footer = page.getByTestId('shell-footer');
      try { await footer.first().waitFor({ timeout: 15_000 }); } catch { /* counted below */ }
      const count = await footer.count();
      const huddle = await footer.getByRole('button', { name: 'Huddle' }).count();
      const message = await footer.getByRole('button', { name: 'Message' }).count();
      const landed = new URL(page.url()).pathname;
      if (count !== 1 || huddle < 1 || message < 1) failures.push(`${route} -> ${landed}: footer=${count} huddle=${huddle} message=${message}`);
    }
    console.log(`${tenant}: swept ${mine.length} routes`);
    expect(failures, failures.join('\n')).toEqual([]);
  });
}
