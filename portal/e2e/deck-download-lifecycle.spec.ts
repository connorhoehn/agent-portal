import { readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

// No live call or shared fixture reset. A real browser exercises the same
// download hook all four deck tenants use, including its native download event.
test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5183' });
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const FILE = '**/api/__deck_download_regression/file';

async function fixture(page: Page) {
  await page.route('**/__deck-download-regression', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/e2e/fixtures/deck-download.tsx"></script></body></html>` }));
  await page.addInitScript(() => {
    const proof = { events: [] as string[], created: [] as string[], revoked: [] as string[] };
    (window as unknown as { downloadProof: typeof proof }).downloadProof = proof;
    for (const name of ['beforeunload', 'pagehide']) window.addEventListener(name, () => proof.events.push(name));
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); proof.created.push(url); return url; };
    URL.revokeObjectURL = url => { proof.revoked.push(url); revoke(url); };
  });
  await page.goto('/__deck-download-regression');
  await expect(page.getByRole('button', { name: 'Download .pptx' })).toBeVisible();
}
const proof = (page: Page) => page.evaluate(() => (window as unknown as {
  downloadProof: { events: string[]; created: string[]; revoked: string[] };
}).downloadProof);

test('PPTX export retains the active document and sends its session cookie without any unload event', async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: 'download-fixture-session', value: 'authorized', url: baseURL!, httpOnly: true }]);
  let requests = 0;
  await page.route(FILE, route => {
    requests += 1;
    expect(route.request().isNavigationRequest()).toBe(false);
    expect(route.request().headers().cookie).toContain('download-fixture-session=authorized');
    return route.fulfill({ contentType: PPTX, headers: { 'Content-Disposition': 'attachment; filename="observability-v3.pptx"' }, body: Buffer.from('PK\x03\x04download-regression') });
  });
  await fixture(page);
  const url = page.url();
  await page.getByRole('textbox', { name: 'Document draft' }).fill('Preserve this draft and its call host');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .pptx' }).click()]);
  expect(download.suggestedFilename()).toBe('observability-v3.pptx');
  expect(readFileSync((await download.path())!).subarray(0, 4)).toEqual(Buffer.from('PK\x03\x04'));
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('textbox', { name: 'Document draft' })).toHaveValue('Preserve this draft and its call host');
  await expect.poll(async () => (await proof(page)).revoked).toHaveLength(1);
  expect(await proof(page)).toMatchObject({ events: [], created: [expect.stringMatching(/^blob:/)], revoked: [expect.stringMatching(/^blob:/)] });
  expect(requests).toBe(1);
  await expect(page.locator('a[download]')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a forbidden or malformed response surfaces an error and a later retry downloads normally', async ({ page }) => {
  let attempt = 0, downloads = 0;
  page.on('download', () => { downloads += 1; });
  await page.route(FILE, route => {
    attempt += 1;
    return route.fulfill(attempt === 1 ? { status: 403, json: { error: 'Forbidden' } }
      : attempt === 2 ? { contentType: 'text/html', body: '<html>Sign in</html>' }
        : { contentType: PPTX, body: Buffer.from('PK\x03\x04retry') });
  });
  await fixture(page);
  await page.getByRole('button', { name: 'Download .pptx' }).click();
  await expect(page.getByRole('alert')).toHaveText('You do not have permission to download this presentation.');
  expect((await proof(page)).created).toEqual([]);
  expect(downloads).toBe(0);
  await page.getByRole('button', { name: 'Download .pptx' }).click();
  await expect(page.getByRole('alert')).toHaveText('The server did not return a PowerPoint file. Try again.');
  expect((await proof(page)).created).toEqual([]);
  expect(downloads).toBe(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download .pptx' }).click()]);
  expect(download.suggestedFilename()).toBe('presentation-v3.pptx');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await proof(page)).events).toEqual([]);
  await expect(page.getByRole('textbox', { name: 'Document draft' })).toHaveValue('Keep my active document');
});

test('pending export is disabled and cannot issue a second attachment request', async ({ page }) => {
  let requests = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  await page.route(FILE, async route => {
    requests += 1; await ready;
    await route.fulfill({ contentType: PPTX, body: Buffer.from('PK\x03\x04pending') });
  });
  await fixture(page);
  await page.getByRole('button', { name: 'Download .pptx' }).click();
  await expect(page.getByRole('button', { name: 'Downloading…' })).toBeDisabled();
  expect(requests).toBe(1);
  const download = page.waitForEvent('download'); release(); await download;
  await expect(page.getByRole('button', { name: 'Download .pptx' })).toBeEnabled();
  expect(requests).toBe(1);
});
