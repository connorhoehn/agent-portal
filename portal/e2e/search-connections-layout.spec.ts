import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

const selected = '/iq/search?tab=connections&selection=person%3Ap-042';

for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
  test(`Connections inspector and controls ${width} ${theme}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const reader = await openAsClone(browser, 'u-theo', { tenant: 'orgiq', landing: null, preJoin: 'remembered', label: 'connections-layout' });
    const { page } = reader;
    const writes: string[] = [];
    await page.route('**/api/**', route => {
      const request = route.request();
      if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /\/(token|ticket)$/.test(new URL(request.url()).pathname)) return route.continue();
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      return route.abort();
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(selected);
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const graph = page.getByTestId('search-org-graph');
      await expect(graph).toBeVisible();
      await page.getByRole('button', { name: 'View person', exact: true }).click();
      const pane = page.getByTestId('search-pane-record');
      await expect(pane).toContainText('Katya Petrov');
      await expect(pane.getByText('Staff ML Engineer · ML / AI', { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('search-person-expand')).toHaveCount(0);
      await expect(page.getByTestId('search-person-card')).toHaveCount(0);
      await expect(page.getByTestId('search-call-row')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Ask about selection', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Ask about Katya', exact: true })).toHaveCount(1);
      await expect(page.getByRole('slider')).toHaveCount(0);
      await expect(page.getByRole('radio', { name: 'Hierarchy', exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Relationship lens' })).toBeVisible();
      await expect(page.getByRole('radiogroup', { name: 'Organization graph layout' })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const canvas = await page.getByTestId('search-people-canvas').boundingBox();
      const right = await page.getByTestId('page-conversation-pane').boundingBox();
      expect(canvas!.width).toBeGreaterThan(300);
      expect(canvas!.height).toBeGreaterThan(240);
      const toolbar=await page.getByTestId('search-people-toolbar').boundingBox();
      expect(toolbar!.height).toBeLessThanOrEqual(width===1440?52:96);
      await expect.poll(()=>graph.locator('[data-person-id]').evaluateAll(nodes=>{
        const bounds=nodes[0]?.closest('[data-testid="search-org-graph"]')?.getBoundingClientRect();
        if(!bounds||nodes.length<2)return -1;
        return nodes.filter(node=>{const box=node.getBoundingClientRect();return box.left<bounds.left-1||box.right>bounds.right+1||box.top<bounds.top-1||box.bottom>bounds.bottom+1;}).length;
      }),{timeout:15000}).toBe(0);
      expect(right!.x).toBeGreaterThanOrEqual(canvas!.x + canvas!.width - 1);
      expect(right!.width).toBeLessThanOrEqual(382);
      await page.screenshot({ path: test.info().outputPath('connections.png') });
      await page.getByRole('button', { name: 'Graph settings', exact: true }).click();
      const count = page.getByRole('slider', { name: 'Connections per person' });
      await expect(count).toBeVisible();
      await count.focus(); await page.keyboard.press('ArrowRight');
      await expect(count).toHaveValue('5');
      await page.screenshot({ path: test.info().outputPath('settings.png') });
      await page.keyboard.press('Escape');
      await expect(count).toHaveCount(0);
      const lens = page.getByRole('combobox', { name: 'Relationship lens' });
      await lens.click(); await page.getByRole('option', { name: 'Hierarchy', exact: true }).click();
      await expect(page).toHaveURL(/entities=hierarchy/);
      await page.getByRole('radio', { name: 'Radial', exact: true }).click();
      await expect(page).toHaveURL(/layout=radial/);
      await page.getByRole('button', { name: 'Close details panel', exact: true }).click();
      await expect(pane).not.toBeVisible();
      await page.reload();
      await expect(graph).toBeVisible();
      await expect(pane).not.toBeVisible();
      await page.getByRole('button', { name: 'View person', exact: true }).click();
      await expect(pane).toContainText('Katya Petrov');
      await pane.getByRole('button', { name: 'Ask about Katya' }).click();
      const transcript = page.getByTestId('search-pane-transcript');
      await expect(transcript).toContainText('Ask about Katya Petrov');
      await expect(page.getByTestId('search-composer-dock')).toContainText('Tell me about this record.');
      await expect(graph).toBeVisible();
      await expect(page.locator('[contenteditable="true"]:visible')).toHaveCount(1);
      expect(new URL(page.url()).searchParams.get('context')).toBe('person:p-042');
      expect(writes).toEqual([]);
      expect(reader.errors).toEqual([]);
    } finally { await reader.close(); }
  });
}
