import { test, expect } from '@playwright/test';
import { openAsClone } from './realSession';

// Read-only coverage of the related list surface, including both membership
// states. A pre-join screen alone cannot verify the Shared work list.
for (const width of [1440, 900]) for (const theme of ['light', 'dark']) {
  test(`shared-work heading and overview stripes: ${theme}/${width}`, async ({ browser }) => {
    test.setTimeout(90_000);
    for (const persona of ['u-operator', 'u-theo']) {
      const person = await openAsClone(browser, persona, {
        tenant: 'orgiq', landing: null, viewport: { width, height: 1000 },
        prepare: context => context.addInitScript(theme => {
          localStorage.setItem('orgiq:preferences:v1', JSON.stringify({ theme }));
          localStorage.setItem('shell.conversation-pane.open', '0');
        }, theme),
      });
      try {
        const { page } = person;
        const writes: string[] = [];
        await page.route('**/api/**', route => {
          const request = route.request();
          // A socket token is read authority. Block every business mutation.
          if (['GET', 'HEAD', 'OPTIONS'].includes(request.method()) || /\/realtime\/token$/.test(new URL(request.url()).pathname)) return route.continue();
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
          return route.abort();
        });
        await page.goto('/iq/communication/channels/general?view=shared');
        const title = page.getByRole('heading', { level: 1, name: '#general', exact: true });
        await expect(title).toBeVisible();
        await expect(title).toHaveCSS('font-size', '20px');
        await expect(page.locator('[data-shell-nav] h1')).toHaveCount(1);
        if (persona === 'u-operator') {
          await expect(page.getByTestId('social-channel-not-joined')).toBeVisible();
        } else {
          const shared = page.getByTestId('social-shared-work');
          await expect(shared).toBeVisible();
          const items = shared.getByTestId('social-shared-items');
          await expect(items).toHaveAttribute('data-size', 'sm');
          await expect(items).not.toContainText('Loading…');
          // The live fixture may have no shares. Verify that honest state,
          // then populate only this browser's GET response to exercise rows.
          if (await items.locator('li').count() === 0) await expect(items).toContainText('Nothing has been shared');
          await page.route('**/conversations/*/shared-work', async route => {
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            const body = await response.json();
            await route.fulfill({ response, json: { ...body, items: [
              { kind: 'initiative', id: 'p-observability', title: 'Observability Platform', status: 'available', href: '/iq/projects/p-observability',
                sharedBy: { userId: 'u-theo', displayName: 'Theo Chang' }, sharedInto: { kind: 'conversation', id: body.conversation, title: '#general' },
                at: '2026-11-02T12:00:00Z', authority: 'membership', provenance: 'reference', ref: { messageId: 'layout-fixture' } },
            ] } });
          });
          await page.reload();
          const rows = items.locator('li');
          await expect(rows).toHaveCount(1);
          await expect(rows.getByText('Observability Platform', { exact: true })).toHaveCSS('font-size', '14px');
          await expect(shared.getByTestId('work-activity-canvas')).toBeVisible();
          const inset = await shared.getByRole('heading', { name: 'Shared here' }).boundingBox();
          const content = await shared.boundingBox();
          expect(inset!.x - content!.x).toBe(24);
          expect(inset!.x + inset!.width).toBeLessThanOrEqual(width - 24);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: test.info().outputPath(`${persona}-${theme}-${width}.png`) });

        if (persona === 'u-operator') {
          await page.goto('/iq/projects/p-observability?scope=all&tab=overview');
          for (const list of [page.getByTestId('overview-up-next').locator('[data-striped]'), page.getByTestId('overview-recent-activity-list')]) {
            await expect(list).toHaveAttribute('data-striped', 'true');
            const rows = list.locator('li');
            await expect(rows.nth(1)).toBeVisible();
            const fills = await rows.evaluateAll(nodes => nodes.slice(0, 2).map(node => getComputedStyle(node).backgroundColor));
            expect(fills[0]).not.toBe(fills[1]);
            expect(fills).not.toContain('rgba(0, 0, 0, 0)');
          }
          await page.screenshot({ path: test.info().outputPath(`overview-${theme}-${width}.png`) });
        }
        expect(writes).toEqual([]);
        expect(person.errors).toEqual([]);
      } finally { await person.close(); }
    }
  });
}
