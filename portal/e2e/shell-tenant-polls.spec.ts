// The assessment shell must never poll the orgiq-only APIs. Before
// components/shell/orgiqShellPolls.ts, a page that rendered the orgiq demo
// session and then signed in as an assessment user kept polling
// /api/bots/active-runs, /api/local-compute/nodes and /api/work/summary with
// the new cookie — three 403s (and three authz-audit DENYs) every 10–15 s.
//
// The same for a tab whose React session is stale: sign in as an assessment
// user in one tab and an orgiq tab used to keep polling with the shared cookie.
//
// Headless, against the running dev:mock middleware (:3001) and portal (:5183).
import { expect, test, type Page } from '@playwright/test';
import { signIn } from './realSession';

const ORGIQ_POLLS = /\/api\/(bots\/active-runs|local-compute\/nodes|work\/summary)(\?|$)/;
// Longer than the slowest shell poll (work/summary, 15 s), so a gated poll
// would have fired at least once more.
const SETTLE_MS = 17_000;

function recordOrgiqPolls(page: Page): Array<{ path: string; status: number; at: string }> {
  const seen: Array<{ path: string; status: number; at: string }> = [];
  page.on('response', (res) => {
    if (ORGIQ_POLLS.test(res.url())) seen.push({ path: new URL(res.url()).pathname, status: res.status(), at: page.url() });
  });
  return seen;
}

test.describe('shell polls follow the tenant', () => {
  test.setTimeout(120_000);

  test('an assessment user never polls the orgiq APIs', async ({ page }) => {
    await page.goto('/workspaces');
    await signIn(page, 'u-jonas');
    const seen = recordOrgiqPolls(page);
    await page.goto('/assessment');
    await page.waitForTimeout(SETTLE_MS / 2);
    await page.goto('/assessment/teams');
    await page.waitForTimeout(SETTLE_MS);
    expect(page.url()).toContain('/assessment');
    expect(seen).toEqual([]);
  });

  test('an orgiq tab stops polling once another tab signs in as an assessment user', async ({ context }) => {
    test.setTimeout(150_000);
    // The cookie is shared by every tab; the orgiq tab's React session is not.
    const orgiqTab = await context.newPage();
    await orgiqTab.goto('/workspaces');
    await signIn(orgiqTab, 'u-theo');
    await orgiqTab.goto('/iq/projects');
    const seen = recordOrgiqPolls(orgiqTab);
    await expect.poll(() => seen.length, { timeout: SETTLE_MS }).toBeGreaterThan(0);

    const otherTab = await context.newPage();
    await otherTab.goto('/workspaces');
    await signIn(otherTab, 'u-farah');
    await otherTab.close();

    // Two full rounds of the slowest poll. Each shell poll may be refused
    // once (that 403 is what tells the tab the tenant moved); none twice.
    await orgiqTab.waitForTimeout(2 * SETTLE_MS);
    const denied = seen.filter((s) => s.status === 403).map((s) => s.path);
    expect(denied.length).toBeLessThanOrEqual(3);
    expect(new Set(denied).size).toBe(denied.length);
  });

  test('an orgiq user still gets all three', async ({ page }) => {
    await page.goto('/workspaces');
    await signIn(page, 'u-theo');
    const seen = recordOrgiqPolls(page);
    await page.goto('/iq/projects');
    await expect.poll(() => new Set(seen.map((s) => s.path)).size, { timeout: SETTLE_MS }).toBe(3);
    expect(seen.every((s) => s.status === 200)).toBe(true);
  });
});
