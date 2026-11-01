import { test, expect } from './cdpTest';

test.use({ baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5183', viewport: { width: 1280, height: 900 } });

test('camera and screen are separate bounded tiles in one composer card; stopping share retains camera', async ({ page }) => {
  await page.route('**/__composer-call-media', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/composer-call-media.tsx"></script></body></html>` }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/__composer-call-media');
  const composer = page.getByTestId('fixture-composer'), media = composer.getByTestId('shell-call-media');
  const tiles = media.locator('[data-dock-item="true"]');
  await expect(tiles).toHaveCount(2);
  const original = await tiles.locator('video').evaluateAll(elements => elements.map(element => (element as HTMLVideoElement).srcObject && ((element as HTMLVideoElement).srcObject as MediaStream).id));
  await page.getByRole('button', { name: 'Start screen sharing', exact: true }).click();
  await expect(tiles).toHaveCount(3);
  await expect(media.locator('[data-call-stream="screen"] video')).toHaveCount(1);
  const sizes = await tiles.evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; }));
  expect(sizes.every(size => size.height === 96 && size.width <= 240)).toBe(true);
  expect(await media.locator('[data-call-stream="screen"] video').evaluate(element => getComputedStyle(element).objectFit)).toBe('contain');
  // Stack retains its media controls; the grid-only layout is the one whose
  // host owns those controls elsewhere. Keep the visible header above tiles.
  await expect(media.locator('[data-testid$="-header"]')).toBeVisible();
  const attachment = await composer.locator('[data-testid$="-dock-slot"]').boundingBox();
  const card = await composer.locator('[data-testid$="-dock-slot"] + *').boundingBox();
  expect(attachment && card).toBeTruthy();
  expect(Math.abs(attachment!.y + attachment!.height - card!.y)).toBeLessThanOrEqual(1);
  expect(attachment!.height).toBeLessThanOrEqual(180);
  expect(await composer.locator('.uic-composer').evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('0px');
  await page.screenshot({ path: test.info().outputPath('camera-and-screen-composer.png') });
  await page.getByRole('button', { name: 'Toggle camera', exact: true }).click();
  await expect(media.locator('[data-call-stream="screen"] video')).toBeVisible();
  await page.getByRole('button', { name: 'Stop screen sharing', exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(media.locator('[data-call-stream="screen"]')).toHaveCount(0);
  const remaining = await tiles.locator('video').evaluateAll(elements => elements.map(element => ((element as HTMLVideoElement).srcObject as MediaStream).id));
  expect(remaining).toEqual(original);
  expect(await tiles.locator('video').evaluateAll(elements => elements.every(element => ((element as HTMLVideoElement).srcObject as MediaStream).getVideoTracks().every(track => track.readyState === 'live')))).toBe(true);
  expect(errors).toEqual([]);
});
