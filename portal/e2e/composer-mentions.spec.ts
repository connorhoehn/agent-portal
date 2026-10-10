import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 }, actionTimeout: 5000, navigationTimeout: 15000 });

test('Assessment central and provider-free composers insert authenticated mentions without altering the send contract', async ({ page }) => {
  test.setTimeout(60000);
  await page.route('**/__composer-mentions', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module" src="/e2e/fixtures/composer-mentions.tsx"></script></body></html>` }));
  await page.goto('/');
  const principal = await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
  const apiWrites: string[] = [], errors: string[] = [], directoryReads: { status: number; tenant: string; me: string; people: string[] }[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && path.startsWith('/api/')) apiWrites.push(path);
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/people/shared') return;
    const body = await response.json();
    directoryReads.push({ status: response.status(), tenant: body.tenant, me: body.me?.userId,
      people: (body.people ?? []).map((person: { userId: string }) => person.userId) });
  });

  // Exercise the actual central Assessment input at the reported page. Insert
  // only: a notification/send assertion belongs to the isolated fixture below.
  await page.goto('/assessment/teams/TEAM-005');
  const central = page.getByTestId('dimension-composer');
  await expect(central).toBeVisible({ timeout: 20000 });
  await central.getByRole('button', { name: 'Composer mode: Agent', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chat', exact: true }).click();
  const centralInput = central.getByTestId('rich-chat-composer-input');
  await centralInput.pressSequentially('@Jon');
  const jonas = page.getByTestId('mention-option').filter({ hasText: 'Jonas Lindqvist' });
  await expect(jonas).toBeVisible();
  await jonas.click();
  await expect(centralInput.locator('[data-type="mention"]')).toHaveAttribute('data-id', 'u-jonas');
  await expect(centralInput).toContainText('@Jonas Lindqvist');
  await centralInput.fill('');

  const beforeFixture = directoryReads.length;
  await page.goto('/__composer-mentions');
  const fixture = page.getByTestId('mention-fixture-composer');
  const input = fixture.getByTestId('rich-chat-composer-input');
  await expect(input).toBeVisible();
  expect(directoryReads.length, 'a provider-free composer does not eagerly request a directory').toBe(beforeFixture);
  await input.pressSequentially('@Jon');
  await expect(jonas).toBeVisible();
  await jonas.click();
  await expect(input.locator('[data-type="mention"]')).toHaveAttribute('data-id', 'u-jonas');
  await input.pressSequentially('please review');
  await fixture.getByTestId('rich-chat-composer-send').click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __composerMentions: { sends: unknown[] } }).__composerMentions.sends.length)).toBe(1);
  const send = await page.evaluate(() => (window as typeof window & { __composerMentions: {
    sends: { text: string; html: string; files: unknown[]; metadata: Record<string, unknown>; reference: unknown }[];
    replyClears: number; overrideQueries: string[];
  } }).__composerMentions);
  expect(send.sends[0]).toMatchObject({ text: '@Jonas Lindqvist please review', files: [], metadata: {
    displayName: 'Asha Nair', pageReference: { kind: 'assessment-team', id: 'TEAM-005' },
    replyTo: { messageId: 'fixture-quote', author: 'Fixture sender', text: 'Earlier fixture note' },
  } });
  expect(send.sends[0].html).toContain('data-id="u-jonas"');
  expect(send.replyClears).toBe(1);
  const beforeOverride = directoryReads.length;
  await page.getByRole('button', { name: 'Use explicit mention lookup', exact: true }).click();
  await input.pressSequentially('@Fi');
  const explicit = page.getByTestId('mention-option').filter({ hasText: 'Fixture Person' });
  await expect(explicit).toBeVisible();
  await explicit.click();
  await expect(input.locator('[data-type="mention"]')).toHaveAttribute('data-id', 'fixture-person');
  expect(directoryReads.length, 'explicit member lookup is respected without another roster fetch').toBe(beforeOverride);
  const overrideQueries = await page.evaluate(() => (window as typeof window & { __composerMentions: { overrideQueries: string[] } }).__composerMentions.overrideQueries);
  expect(overrideQueries.length).toBeGreaterThan(0);
  expect(directoryReads.length).toBeGreaterThan(beforeFixture);
  expect(directoryReads.every(read => read.status === 200 && read.tenant === 'assessment' && read.me === 'u-asha'
    && read.people.includes('u-jonas') && !read.people.includes('u-asha') && !read.people.includes('u-vera'))).toBe(true);
  // Team reference-presence publication can use GET/SSE, but no chat/agent or
  // tenant/role mutation is needed for this insertion/send rendering test.
  expect(apiWrites).toEqual([]);
  expect(errors).toEqual([]);
  const path = test.info().outputPath('composer-mentions-proof.json');
  await writeFile(path, JSON.stringify({ observedAt: new Date().toISOString(), principal, directoryReads,
    send, overrideQueries, apiWrites, errors,
    scope: 'Real Asha home Assessment session and actual TEAM-005 central menu/insertion; provider-free shared composer fixture uses the real authenticated directory and captures native recipient-send args in memory. No thread messages, notifications, agent invocation, call, reset, or role/tenant switch.' }, null, 2));
  await test.info().attach('composer-mentions-proof', { path, contentType: 'application/json' });
});
