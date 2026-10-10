import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs, signIn } from './realSession';

// Pointers over a page's shared work graph (realtime-parity "Cursors" row):
// two pipelines users on one run see each other's pointer over the graph,
// labelled from the token, and it vanishes on leave. The same overlay mounts on
// the orgiq initiative (ChannelActivity), the assessment team scorecard and
// the Social conversation graph. Skips when the :3001 gateway is off.

type Person = { page: Page; context: BrowserContext };
const CANVAS = '[data-testid="pipeline-run-activity"]';

async function open(browser: Browser, userId: string, url: string): Promise<Person> {
  const { context, page } = await openAs(browser, userId, { viewport: { width: 1672, height: 941 }, url });
  await expect(page.locator(CANVAS)).toBeVisible({ timeout: 20_000 });
  return { page, context };
}

test.describe('work graph cursors', () => {
  let ines: Person; let kofi: Person;
  test.beforeAll(async ({ browser, request }) => {
    const health = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
    test.skip(health?.realtime?.gateway !== 'on', 'the :3001 middleware is unreachable or REALTIME_GATEWAY is not on');
    const probe = await browser.newContext();
    await signIn(probe, 'u-ines');
    const runs = await (await probe.request.get('/api/pipelines/runs')).json() as { runs: Array<{ id: string }> };
    await probe.close();
    const url = `/pipelines/runs/${encodeURIComponent(runs.runs[0]!.id)}?tab=activity`;
    ines = await open(browser, 'u-ines', url);
    kofi = await open(browser, 'u-kofi', url);
  });
  test.afterAll(async () => { await ines?.context.close(); await kofi?.context.close(); });

  const pointers = (p: Person) => p.page.getByTestId('cursor-overlay-pointer');

  test('a peer pointer shows over the run graph, named from the token, and vanishes on leave', async () => {
    const graph = ines.page.locator(CANVAS).locator('.react-flow, [data-testid*="work-graph"]').first();
    await graph.scrollIntoViewIfNeeded();
    const box = (await graph.boundingBox())!;
    await expect(async () => {
      await ines.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 4 });
      await ines.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
      await expect(pointers(kofi)).toHaveCount(1, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(kofi.page.locator(CANVAS)).toContainText(/Ines|IM/);
    await ines.page.goto('/');
    await expect(pointers(kofi)).toHaveCount(0, { timeout: 15_000 });
  });
});
