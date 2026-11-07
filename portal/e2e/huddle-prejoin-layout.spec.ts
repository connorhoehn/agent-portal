import { test, expect } from './cdpTest';
import { openAsClone } from './realSession';
import { PRE_JOIN_KEY } from './preJoin';
import { measureDOM } from './lib/ui-dom-audit/measure.mjs';

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } });

const cases = [
  { tenant: 'orgiq', user: 'u-vera', url: '/iq/projects/p-auth-migration' },
  { tenant: 'assessment', user: 'u-asha', url: '/assessment/teams/TEAM-005' },
  { tenant: 'social', user: 'u-sana', url: '/social/channels/general' },
  { tenant: 'pipelines', user: 'u-kofi', url: '/pipelines/runs' },
];

for (const entry of cases) test(`${entry.tenant}: shared pre-join layout, devices and effects`, async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const actor = await openAsClone(browser, entry.user, {
    baseURL, expectTenant: entry.tenant, url: entry.url, preJoin: 'show',
    viewport: { width: 1440, height: 1000 }, contextOptions: { permissions: ['camera', 'microphone'] },
    prepare: async context => context.addInitScript(key => {
      localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: true, remember: false }));
    }, PRE_JOIN_KEY),
  });
  const { page } = actor;
  page.setDefaultTimeout(10_000);
  const auditLayer = async (role: 'menu' | 'listbox') => {
    await page.getByRole(role).evaluate(node => node.setAttribute('data-audit-layer', ''));
    const report = await page.evaluate(measureDOM, { contract: { version: 1, rules: [
      { id: 'prejoin.layer', kind: 'layer' },
    ] }, selectors: {}, probe: { kind: 'layer', opened: true, role, trigger: 'device or effects control' } });
    expect(report.issues).toEqual([]);
    await page.getByRole(role).evaluate(node => node.removeAttribute('data-audit-layer'));
  };
  try {
    if (entry.tenant === 'pipelines') {
      const response = await page.request.get('/api/pipelines/runs?limit=1');
      expect(response.ok()).toBeTruthy();
      const run = (await response.json()).runs[0];
      await page.goto(`/pipelines/runs/${encodeURIComponent(run.id)}`);
    }
    const start = page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle', exact: true });
    await expect(start).toBeEnabled({ timeout: 20_000 });
    const mutations: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/(?:call|social\/calls)/.test(request.url())) mutations.push(request.url());
    });
    await start.click();
    const dialog = page.getByRole('dialog', { name: /Start a huddle|Join the huddle/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('prejoin-blur')).toBeVisible();
    await expect(dialog.getByTestId('settings-camera-select')).toBeEnabled({ timeout: 15_000 });
    await expect.poll(() => dialog.locator('video').evaluate(video => (video as HTMLVideoElement).videoWidth)).toBeGreaterThan(0);
    await expect(dialog.locator('select')).toHaveCount(0);
    const reports = [];
    for (const theme of ['light', 'dark']) for (const width of [1440, 900, 560]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; localStorage.setItem('theme', value); }, theme);
      const header = dialog.getByTestId('prejoin-header');
      const [heading, title] = await Promise.all([header.locator('h2').boundingBox(), header.getByTestId('prejoin-title').boundingBox()]);
      expect(title!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width);
      expect(Math.abs(title!.y + title!.height - heading!.y - heading!.height)).toBeLessThan(8);
      await expect(dialog.getByTestId('settings-test-mic')).not.toBeVisible();
      await expect(dialog.getByTestId('settings-test-sound')).not.toBeVisible();
      const report = await page.evaluate(measureDOM, { contract: { version: 1, tolerance: 1, rules: [
        { id: 'prejoin.fields-fit', kind: 'within', selector: '[data-layout="prejoin"] [role="combobox"]', anchor: 'section', ancestor: true },
        { id: 'prejoin.preview-fit', kind: 'within', selector: '[data-testid="settings-preview"]', anchor: '[data-layout="prejoin"]', ancestor: true },
        { id: 'prejoin.text-overlap', kind: 'text-overlap', selector: '[data-testid="prejoin-backdrop"]', tolerance: 1, maxPerPage: 20 },
        { id: 'prejoin.text-clipped', kind: 'text-clipped', selector: '[data-testid="prejoin-backdrop"]' },
      ] }, selectors: {} });
      reports.push({ theme, width, ...report });
      expect(report.issues, `${entry.tenant} ${theme} ${width}`).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`${entry.tenant}-${theme}-${width}.png`) });
      await dialog.getByTestId('settings-camera-select').click();
      await expect(page.getByRole('listbox')).toBeVisible();
      await auditLayer('listbox');
      const box = await page.getByRole('listbox').boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.getByRole('option').first().click();
      for (const label of ['Microphone test & settings', 'Speaker test & volume', 'Advanced settings']) {
        await dialog.getByText(label, { exact: true }).click();
      }
      const expanded = await page.evaluate(measureDOM, { contract: { version: 1, rules: [
        { id: 'prejoin.expanded-fields-fit', kind: 'within', selector: '[data-layout="prejoin"] [role="combobox"]', anchor: 'section', ancestor: true },
        { id: 'prejoin.expanded-controls-fit', kind: 'within', selector: '[data-layout="prejoin"] button', anchor: 'section', ancestor: true, axes: ['x'] },
      ] }, selectors: {} });
      expect(expanded.issues).toEqual([]);
      reports.push({ theme, width, state: 'expanded', ...expanded });
      await page.screenshot({ path: test.info().outputPath(`${entry.tenant}-${theme}-${width}-expanded.png`) });
      for (const label of ['Microphone test & settings', 'Speaker test & volume', 'Advanced settings']) {
        await dialog.getByText(label, { exact: true }).click();
      }
    }
    await test.info().attach('prejoin-dom-audit', { body: JSON.stringify(reports, null, 2), contentType: 'application/json' });
    await dialog.getByText('Microphone test & settings', { exact: true }).click();
    await expect(dialog.getByTestId('settings-test-mic')).toBeVisible();
    await dialog.getByText('Speaker test & volume', { exact: true }).click();
    await expect(dialog.getByTestId('settings-test-sound')).toBeVisible();
    await dialog.getByText('Advanced settings', { exact: true }).click();
    await expect(dialog.getByTestId('settings-quality')).toBeVisible();
    await dialog.getByTestId('prejoin-effects').click();
    await auditLayer('menu');
    await page.screenshot({ path: test.info().outputPath(`${entry.tenant}-effects-menu.png`) });
    await page.getByRole('menuitemcheckbox', { name: 'Warm', exact: true }).click();
    await expect.poll(() => dialog.locator('video').evaluate(video => {
      const stream = (video as HTMLVideoElement).srcObject as MediaStream;
      return stream?.getVideoTracks()[0]?.constructor.name;
    })).toBe('CanvasCaptureMediaStreamTrack');
    await dialog.getByTestId('prejoin-blur').click();
    await expect(dialog.getByTestId('prejoin-blur')).toHaveAttribute('aria-pressed', 'true');
    await page.screenshot({ path: test.info().outputPath(`${entry.tenant}-expanded-effects.png`) });
    await dialog.getByTestId('prejoin-cancel').click();
    await expect(dialog).toHaveCount(0);
    expect(mutations).toEqual([]);
    expect(actor.errors).toEqual([]);
  } finally { await actor.close(); }
});
