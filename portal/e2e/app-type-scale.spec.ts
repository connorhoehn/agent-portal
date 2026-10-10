import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// One type scale across the app (companion to initiative-overview-type.spec.ts).
// ui-components 2.429.0 added `size="sm"` to StatStrip (line), PageSection,
// DetailSection (heading) — 14px semibold headings/stat values, 14px labels —
// the same body step as the 14px tab strips and rail rows. Every consumer
// outside pages/projects/** and pages/distillation/** opts in; this spec pins
// each role's computed px/weight on the pages that render them.

type Type = { size: string; weight: string };
const BODY: Type = { size: '14px', weight: '400' };
const HEADING: Type = { size: '14px', weight: '600' };
const PAGE_TITLE: Type = { size: '20px', weight: '600' };

async function typeOf(locator: Locator): Promise<Type> {
  await expect(locator).toBeVisible();
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight };
  });
}

async function open(browser: Browser, user: string, url: string): Promise<Page> {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ viewport: { width: 1680, height: 940 }, baseURL });
  await loginAs(context, user, baseURL);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

// A line cluster is <span cluster><span><value/><label/></span>…</span>.
async function expectLineStrip(strip: Locator) {
  const cluster = strip.getByTestId('stat-strip-cluster').first();
  expect(await typeOf(cluster.locator(':scope > span > span').nth(0))).toEqual(HEADING);
  expect(await typeOf(cluster.locator(':scope > span > span').nth(1))).toEqual(BODY);
}

test('Initiatives list: the rollup line is on the body step', async ({ browser }) => {
  const page = await open(browser, 'u-vera', '/iq/projects?scope=all');
  expect(await typeOf(page.getByTestId('initiatives-pane-header').getByRole('heading').first())).toEqual(PAGE_TITLE);
  await expectLineStrip(page.getByLabel('Program rollup'));
  await page.context().close();
});

// SprintsLens passes size="sm" on its rollup strip like the other orgiq lines.
test('Sprints lens: the rollup line is on the body step', async ({ browser }) => {
  const page = await open(browser, 'u-vera', '/iq/projects?scope=all&lens=sprints');
  const strip = page.getByTestId('stat-strip-cluster').first();
  await expectLineStrip(strip.locator('xpath=..'));
  await page.context().close();
});

test('Automate inbox: section headings are on the body step', async ({ browser }) => {
  const page = await open(browser, 'u-vera', '/iq/work');
  const inbox = page.getByTestId('automate-inbox');
  expect(await typeOf(inbox.getByRole('heading', { level: 1 }))).toEqual(PAGE_TITLE);
  // The "Needs your attention" / "Current queue" / "Recent runs" sections.
  const section = inbox.getByRole('heading', { name: /Needs your attention|Current queue|Recent runs/ }).first();
  if (await section.isVisible().catch(() => false)) expect(await typeOf(section)).toEqual(HEADING);
  await page.context().close();
});

test('pipelines run page: section labels stay on the quiet caption step', async ({ browser }) => {
  test.setTimeout(90_000);
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ viewport: { width: 1680, height: 940 }, baseURL });
  await loginAs(context, 'u-ines', baseURL, true);
  expect((await context.request.post('/api/session/tenant', { data: { tenant: 'pipelines' } })).status()).toBe(200);
  const list = await (await context.request.get('/api/pipelines/runs?limit=50')).json();
  const run = (list.runs as Array<{ id: string }>)[0];
  expect(run, 'a seeded run').toBeTruthy();
  const page = await context.newPage();
  await page.goto(`/pipelines/runs/${encodeURIComponent(run!.id)}`);
  const steps = page.getByTestId('pipeline-steps');
  await expect(steps).toBeVisible();
  const t = await typeOf(steps.getByText('Steps', { exact: true }).first());
  expect(Number.parseFloat(t.size), 'DetailSection label is a caption, not a 15-16px heading').toBeLessThanOrEqual(12);
  await page.context().close();
});

test('assessment dashboard: KPI tiles and rows match the scorecard scale', async ({ browser }) => {
  const page = await open(browser, 'u-asha', '/assessment/teams');
  const desk = page.getByTestId('shell-split-primary');
  expect(await typeOf(desk.getByRole('heading', { level: 1 }))).toEqual(PAGE_TITLE);
  expect(await typeOf(desk.locator('span', { hasText: /^\d+$/ }).first())).toEqual({ size: '17px', weight: '700' });
  expect(await typeOf(desk.locator('td').first())).toEqual(BODY);
  await page.context().close();
});

test('Social channel: nothing in the page reads at 15-16px semibold', async ({ browser }) => {
  const page = await open(browser, 'u-sana', '/social/channels');
  await expect(page.getByTestId('social-channels-page')).toBeVisible();
  const heavy = await page.getByTestId('social-channels-page').evaluate((root) => {
    const bad: string[] = [];
    root.querySelectorAll('*').forEach((el) => {
      if (el.children.length || (el.textContent?.trim().length ?? 0) < 2) return;
      const cs = getComputedStyle(el);
      const px = Number.parseFloat(cs.fontSize);
      if ((px === 15 || px === 16) && Number(cs.fontWeight) >= 600) bad.push(`${cs.fontSize}/${cs.fontWeight} ${el.textContent.trim().slice(0, 30)}`);
    });
    return bad;
  });
  expect(heavy).toEqual([]);
  await page.context().close();
});
