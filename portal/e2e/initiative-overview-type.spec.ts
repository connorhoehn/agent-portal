import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The initiative Overview's type scale must match the surfaces the user holds
// up as right — the list-row sublines, the assessment team scorecard and
// the Initiatives list. On 2026-10-07 every Overview role read one step up
// (16px section headings, 15px rows/stats/cells, 13px lead-ins); the fix is
// ui-components 2.429.0 `size="sm"` on PageSection / DetailSection /
// ActionRowList / StatStrip. Each assertion compares a computed font-size and
// weight on the Overview with the same role measured live on a reference page,
// so drift on either side fails here.

type Type = { size: string; weight: string };

async function typeOf(locator: Locator): Promise<Type> {
  await expect(locator).toBeVisible();
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { size: cs.fontSize, weight: cs.fontWeight };
  });
}

async function open(browser: Browser, user: string, url: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1680, height: 940 }, baseURL: test.info().project.use.baseURL });
  await loginAs(context, user, test.info().project.use.baseURL);
  const page = await context.newPage();
  await page.goto(url);
  return page;
}

test('initiative Overview type matches the reference surfaces', async ({ browser }) => {
  test.setTimeout(120_000);

  // ── Reference surfaces ──
  const scorecard = await open(browser, 'u-asha', '/assessment/teams/TEAM-001?tab=certification');
  // The scorecard's dimension rail (2026-10-07: its coverage bar is gone; the rail is a GroupedList): a group heading and a row title.
  const refSectionHeading = await typeOf(scorecard.getByTestId('assessment-dimension-master-detail-rail').getByText(/^(Claims to verify|Verified)$/).first());
  const refRowTitle = await typeOf(scorecard.getByTestId('assessment-dimension-master-detail-rail').getByText('01 Continuous Integration (CI)', { exact: true }));
  const refTab = await typeOf(scorecard.getByRole('tab', { name: 'Stories' }).getByText('Stories', { exact: true }));
  await scorecard.context().close();

  // The list-row subline on the T scale (the Runbooks and Initiatives list rails): 12px regular.
  const refMeta = { size: '12px', weight: '400' };

  const list = await open(browser, 'u-vera', '/iq/projects?scope=all');
  const refBody = await typeOf(list.getByTestId('initiatives-pane-header').locator('p').first());
  await list.context().close();

  // The references themselves sit on the T scale: 14px semibold headings,
  // 14px medium row titles and tabs, 14px body, 12px meta.
  expect(refSectionHeading).toEqual({ size: '14px', weight: '600' });
  expect(refRowTitle).toEqual({ size: '14px', weight: '500' });
  expect(refTab).toEqual({ size: '14px', weight: '500' });
  expect(refBody).toEqual({ size: '14px', weight: '400' });
  expect(refMeta).toEqual({ size: '12px', weight: '400' });

  // ── The Overview ──
  const page = await open(browser, 'u-vera', '/iq/projects/p-observability?scope=all');
  const overview = page.getByTestId('initiative-overview');
  await expect(overview.getByTestId('overview-up-next')).toBeVisible();

  // Section headings: "Needs attention", "Up next".
  expect(await typeOf(overview.getByRole('heading', { name: /Needs attention/ }))).toEqual(refSectionHeading);
  expect(await typeOf(overview.getByRole('heading', { name: 'Up next' }))).toEqual(refSectionHeading);

  // The Discussion is the shell's right pane now (the library SidePane): its
  // title on the section-heading step, its subtitle on the meta step, its
  // messages on the body step.
  expect(await typeOf(page.getByTestId('page-conversation-pane-title'))).toEqual(refSectionHeading);
  expect(await typeOf(page.getByTestId('page-conversation-pane-subtitle'))).toEqual(refMeta);

  // Stat strip: values at heading weight, labels at body.
  const stats = overview.getByTestId('overview-stats');
  const cluster = stats.getByTestId('stat-strip-cluster').first();
  // A line cluster is <span cluster><span><value/><label/></span>…</span>.
  expect(await typeOf(cluster.locator(':scope > span > span').nth(0))).toEqual(refSectionHeading);
  expect(await typeOf(cluster.locator(':scope > span > span').nth(1))).toEqual(refBody);

  // Rows: titles like the scorecard's dimension rows, descriptions like
  // list-row sublines, cells like body text.
  const upNext = overview.getByTestId('overview-up-next');
  const firstRow = upNext.locator('[data-testid^="action-row-list-open-"]').first();
  // A columned row's title carries its full text as `title` and precedes the cells.
  expect(await typeOf(firstRow.locator('span[title]').first())).toEqual(refRowTitle);
  expect(await typeOf(upNext.getByTestId('action-row-cell-points').first())).toEqual(refBody);

  const attention = overview.getByTestId('overview-attention');
  if (await attention.isVisible()) {
    const row = attention.locator('[data-testid^="overview-attention-open-"]').first();
    expect(await typeOf(row.locator('span[title]').first())).toEqual(refRowTitle);
    expect(await typeOf(attention.getByTestId('action-row-description').first())).toEqual(refMeta);
  }

  // The Overview's own tab strip matches the scorecard's.
  expect(await typeOf(page.getByTestId('initiative-header-tab-overview').getByText('Overview', { exact: true }))).toEqual(refTab);

  await page.context().close();
});
