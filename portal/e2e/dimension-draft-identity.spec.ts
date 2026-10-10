import { writeFile } from 'node:fs/promises';
import { test, expect } from './cdpTest';
import { signIn } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1280, height: 900 }, actionTimeout: 5000 });

test('Assessment Agent draft survives late chat runtime and reconnect under the signed actor', async ({ page }) => {
  const principal = await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
  await page.route('**/__dimension-draft-identity', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/dimension-draft-identity.tsx"></script></body></html>` }));
  const writes: string[] = [], errors: string[] = [];
  page.on('request', request => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) writes.push(new URL(request.url()).pathname);
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/__dimension-draft-identity');
  await expect(page.getByTestId('fixture-signed-actor')).toHaveText('u-asha');
  const composer = page.getByTestId('dimension-composer');
  const input = composer.getByTestId('rich-chat-composer-input');
  await expect(input).toBeVisible();
  const question = 'Explain the CI evidence gap; keep this unsent draft.';
  await input.fill(question);
  const original = await input.elementHandle();
  await page.getByRole('button', { name: 'Publish delayed chat runtime', exact: true }).click();
  await expect(input).toHaveText(question);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await page.getByRole('button', { name: 'Toggle runtime connection', exact: true }).click();
  await expect(input).toHaveText(question);
  await page.getByRole('button', { name: 'Toggle runtime connection', exact: true }).click();
  await expect(input).toHaveText(question);
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  const beforeReload = await page.evaluate(() => ({
    proof: (window as typeof window & { __dimensionDraftIdentity: { published: number; sends: number } }).__dimensionDraftIdentity,
    drafts: Object.entries(localStorage).filter(([key]) => key.includes('assessment-dimension:TEAM-005:1')),
  }));
  expect(beforeReload.drafts.length).toBe(1);
  expect(beforeReload.drafts[0][0]).toContain('u-asha');
  expect(beforeReload.drafts[0][1]).toContain(question);
  expect(beforeReload.proof).toEqual({ published: 1, sends: 0 });
  await page.reload();
  await expect(input).toHaveText(question);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('dimension-draft-signed-actor.png') });
  await writeFile(test.info().outputPath('verification.json'), JSON.stringify({ principal, beforeReload, writes, errors,
    actualAssessmentHost: true, actualNativeComposer: true, editorNodeRetained: true, sameActorReloadRetained: true,
    simulation: 'Only delayed chat runtime publication and connection state; no gateway/chat send, agent command, job, call, or reset.' }, null, 2));
});
