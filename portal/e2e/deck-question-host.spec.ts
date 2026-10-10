import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1024, height: 768 }, actionTimeout: 5000, navigationTimeout: 10000 });

test('unsupported deck hosts retain their edit handler despite a Search-capable Work session', async ({ page }) => {
  test.setTimeout(45000);
  await page.route('**/__deck-question-host?*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/deck-question-host.tsx"></script></body></html>` }));
  await page.goto('/');
  await signIn(page, 'u-theo', { expectTenant: 'orgiq', expectRole: 'member' });
  const apiWrites: string[] = [], errors: string[] = [], hosts: unknown[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/')) apiWrites.push(path);
  });
  page.on('pageerror', error => errors.push(error.message));
  for (const host of ['assessment', 'pipelines', 'social'] as const) {
    await page.goto(`/__deck-question-host?host=${host}`);
    const fixture = page.getByTestId('fixture-question-host');
    await expect(fixture).toHaveAttribute('data-ready', 'true');
    await expect(fixture).toHaveAttribute('data-search', 'true');
    await expect(page.getByTestId('fixture-question-principal')).toHaveText('u-theo / orgiq / member');
    const dock = page.getByTestId('deck-composer-dock');
    const message = dock.getByRole('textbox', { name: 'Presentation message', exact: true });
    await expect(message).toBeEditable();
    await message.focus();
    await expect(page.getByRole('button', { name: 'Presentation agent action', exact: true })).toHaveCount(0);
    await expect(dock).toContainText('Edit');
    await expect(message.locator('[data-placeholder]')).toHaveAttribute('data-placeholder', 'Tell the agent what to change on slide 1…');
    await message.fill('Tighten the summary bullets.');
    await dock.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByTestId('deck-composer-status')).toContainText('Fixture edit retained');
    const proof = await page.evaluate(() => (window as typeof window & { __deckQuestionHost: {
      host: string; principal: { sub: string; tenant: string; role: string }; capabilityReady: boolean; searchAllowed: boolean;
      revisions: { kind: string; deckId: string; input: { instruction: string; slideId: string; baseRevisionId: string; requestId?: string } }[];
      runReads: string[]; reloads: number; openedRevision: string | null; markedSlideIds: string[];
    } }).__deckQuestionHost);
    expect(proof.revisions).toHaveLength(1);
    expect(proof.revisions[0]).toMatchObject({ kind: host === 'social' ? 'inline' : 'run', deckId: `fixture-${host}`,
      input: { instruction: 'Tighten the summary bullets.', slideId: 'summary', baseRevisionId: 'fixture-v1' } });
    expect(proof.runReads).toEqual(host === 'social' ? [] : [`fixture-${host}-run`]);
    expect(proof.reloads).toBe(1);
    expect(proof.openedRevision).toBe('fixture-v2');
    expect(proof.markedSlideIds).toEqual(['summary']);
    if (host === 'social') expect(proof.revisions[0].input.requestId).toMatch(/^req-/);
    hosts.push(proof);
  }
  expect(apiWrites).toEqual([]);
  expect(errors).toEqual([]);
  const proofPath = test.info().outputPath('unsupported-deck-host-question-proof.json');
  await writeFile(proofPath, JSON.stringify({ kind: 'shared-deck-question-host-rendering-regression',
    observedAt: new Date().toISOString(), hosts, apiWrites, errors,
    scope: 'Real u-theo Work session and Search capability; shared hook/composer rendered with cloned documents and in-memory tenant-specific revise/run handlers. Assistant output is not mounted. No native deck writes, supervisor invocation, gateway, call, reset or role/tenant switch.' }, null, 2));
  await test.info().attach('unsupported-deck-host-question-proof', { path: proofPath, contentType: 'application/json' });
});
