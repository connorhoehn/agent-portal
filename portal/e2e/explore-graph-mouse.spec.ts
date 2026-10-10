import { test, expect, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// "Click on nodes and explore them live and the view adjusted": a real mouse
// click (Playwright's actionability-checked `click()`, which fails when a node
// computes `pointer-events: none`) expands the graph, and the view stays at a
// readable zoom with the clicked node inside the canvas. Both graph types the
// Search › Connections tab draws (orgiq-journeys DEFECTS #22–23). Real BFF data.

/** The automatic fit's readable floor this spec holds both graphs to. */
const READABLE_ZOOM = 0.7;

async function insideCanvas(node: Locator, canvas: Locator) {
  const [n, c] = [await node.boundingBox(), await canvas.boundingBox()];
  expect(n && c, 'node and canvas are laid out').toBeTruthy();
  const cx = n!.x + n!.width / 2, cy = n!.y + n!.height / 2;
  expect(cx).toBeGreaterThanOrEqual(c!.x); expect(cx).toBeLessThanOrEqual(c!.x + c!.width);
  expect(cy).toBeGreaterThanOrEqual(c!.y); expect(cy).toBeLessThanOrEqual(c!.y + c!.height);
}

/** Scale from a CSS or SVG `... scale(z)` transform. */
const scaleOf = (transform: string | null) => Number(/scale\(([\d.]+)/.exec(transform ?? '')?.[1] ?? NaN);

const recordZoom = (page: Page) => page.locator('[data-testid="search-connections"] .react-flow__viewport').first()
  .evaluate(el => (el as HTMLElement).style.transform).then(scaleOf);
const orgZoom = (graph: Locator) => graph.locator('svg g[transform*="scale("]').first().getAttribute('transform').then(scaleOf);

test.beforeEach(async ({ context, baseURL }) => { await loginAs(context, 'u-theo', baseURL); });

test('all-types record graph: a mouse click on a node expands it and keeps it readable and in view', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/iq/explore');
  await expect(page).toHaveURL(/tab=connections/);
  const graph = page.getByTestId('search-connections');
  const nodes = graph.locator('.react-flow__node button');
  await nodes.first().waitFor();
  const before = await nodes.count();
  // The node takes the pointer: hit-testing its centre lands on the button,
  // not on the canvas pane behind it (#22).
  const node = nodes.nth(Math.min(3, before - 1));
  const label = (await node.getAttribute('aria-label'))!;
  await node.scrollIntoViewIfNeeded();
  expect(await node.evaluate(el => getComputedStyle(el).pointerEvents)).not.toBe('none');
  const hit = await node.evaluate(el => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!at && el.contains(at);
  });
  expect(hit, 'elementFromPoint over the node reaches the node').toBe(true);
  await node.hover();
  await node.click();
  await expect(page).toHaveURL(/selection=/);
  const clicked = graph.getByRole('button', { name: label, exact: true });
  await expect(clicked).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => nodes.count()).not.toBe(before);
  await page.waitForTimeout(600);
  expect(await recordZoom(page)).toBeGreaterThanOrEqual(READABLE_ZOOM);
  await insideCanvas(clicked, graph.locator('.react-flow').first());
  // The selected node prints its whole title.
  await expect(graph.getByTestId('record-graph-selected-title').first()).toBeVisible();
});

test('people org graph: successive mouse picks pan to the picked person at a readable zoom', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  await page.goto('/iq/search?type=person&tab=connections');
  const graph = page.getByTestId('search-org-graph');
  const people = graph.getByRole('button', { name: / · / });
  await people.first().waitFor();
  const picked: string[] = [];
  // Three picks, each a person not yet selected, the way the walk expanded the
  // graph from Nora to Theo to someone in another department (#23).
  for (let step = 0; step < 3; step++) {
    await page.waitForTimeout(800);
    const count = await people.count();
    let target: Locator | null = null;
    for (let i = count - 1; i >= 0; i--) {
      const candidate = people.nth(i);
      if ((await candidate.getAttribute('aria-pressed')) !== 'true') { target = candidate; break; }
    }
    expect(target, 'an unselected person to expand through').toBeTruthy();
    const name = (await target!.getAttribute('aria-label'))!.split(' · ')[0]!;
    await target!.click();
    picked.push(name);
    await expect(page).toHaveURL(new RegExp(`selection=([^&]*(%2C|,)){${step}}`));
    await page.waitForTimeout(1500);
    const zoom = await orgZoom(graph);
    expect(zoom, `zoom after picking ${name}`).toBeGreaterThanOrEqual(READABLE_ZOOM);
    await insideCanvas(graph.getByRole('button', { name: new RegExp(`^${name} · `) }).first(), graph);
  }
});
