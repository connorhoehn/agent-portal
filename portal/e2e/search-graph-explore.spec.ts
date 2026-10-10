import { test, expect, type Locator } from '@playwright/test';
import { loginAs } from './realSession';

// Live exploration in the Search workspace's People graph (the old /iq/explore
// behaviour): click a person -> their neighbourhood is drawn and the view keeps
// them in frame; click a neighbour -> the neighbourhood widens. Real BFF data.
const peopleCount = async (panel: Locator) => {
  const text = await panel.getByTestId('search-people-count').innerText();
  const m = text.replace(/ /g, ' ').match(/^(\d+)(?: \/ (\d+))? people/);
  expect(m, text).toBeTruthy();
  return Number(m![1]);
};
async function insideCanvas(node: Locator, canvas: Locator) {
  const [n, c] = [await node.boundingBox(), await canvas.boundingBox()];
  expect(n && c).toBeTruthy();
  expect(n!.x).toBeGreaterThanOrEqual(c!.x - 1); expect(n!.y).toBeGreaterThanOrEqual(c!.y - 1);
  expect(n!.x + n!.width).toBeLessThanOrEqual(c!.x + c!.width + 1); expect(n!.y + n!.height).toBeLessThanOrEqual(c!.y + c!.height + 1);
}

test.beforeEach(async ({ context, baseURL }) => { await loginAs(context, 'u-theo', baseURL); });

test('clicking a person explores their neighbourhood and keeps them in view; clicking a neighbour widens it', async ({ page }) => {
  await page.goto('/iq/search?type=person&tab=connections');
  const panel = page.getByTestId('search-people-graph');
  const graph = page.getByTestId('search-org-graph');
  await graph.getByRole('button').first().waitFor();
  const whole = await peopleCount(panel);
  const first = graph.getByRole('button').first();
  const firstName = (await first.getAttribute('aria-label'))!.split(' · ')[0];
  await first.click();
  await expect(page).toHaveURL(/selection=person%3Ap-\d+/);
  await expect(page).toHaveURL(/detail=p-\d+/);
  await expect.poll(() => peopleCount(panel)).toBeLessThan(whole);
  const afterFirst = await peopleCount(panel);
  await page.waitForTimeout(800);
  await insideCanvas(graph.getByRole('button', { name: new RegExp(`^${firstName}`) }), graph);
  // Expand through a neighbour that is not yet selected.
  const people = graph.getByRole('button', { name: / · / });
  const neighbour = people.nth(2);
  await neighbour.click();
  await expect(page).toHaveURL(/selection=person%3Ap-\d+(%2C|,)person%3Ap-\d+/);
  await expect.poll(() => peopleCount(panel)).toBeGreaterThanOrEqual(afterFirst);
  await page.waitForTimeout(800);
  await insideCanvas(neighbour, graph);
  // Two selected people: the connection path strip appears.
  await expect(panel.getByText(/path|hop|connected/i).first()).toBeVisible();
  // Third click keeps exploring.
  const third = people.nth(4);
  await third.click();
  await expect(page).toHaveURL(/selection=([^&]*(%2C|,)){2}/);
});

test('Explore keeps relationship lens, capped-aware count and detail without presenting generated daily status as presence', async ({ page }) => {
  await page.goto('/iq/search?type=person&tab=connections&detail=p-002&selection=person:p-002');
  const panel = page.getByTestId('search-people-graph');
  await expect(page.getByTestId('search-person-card')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Filter by presence' })).toHaveCount(0);
  await panel.getByRole('radio', { name: 'Hierarchy' }).click();
  await expect(page).toHaveURL(/entities=hierarchy/);
  await expect(panel.getByTestId('search-people-count')).toContainText(/hierarchy edges/);
  await panel.getByRole('radio', { name: 'All' }).click();
  await expect(page).not.toHaveURL(/entities=/);
});

test('legacy /iq/explore links keep their lens and selection', async ({ page }) => {
  await page.goto('/iq/explore?selected=p-002&entities=hierarchy&layout=radial');
  await expect(page).toHaveURL(/\/iq\/search\?.*tab=connections/);
  await expect(page).toHaveURL(/entities=hierarchy/);
  await expect(page.getByTestId('search-people-graph')).toBeVisible();
});
