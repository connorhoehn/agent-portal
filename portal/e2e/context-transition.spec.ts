import { test, expect, type Page } from '@playwright/test';
import { TENANT_HOME } from '../src/lib/tenantHome';

const initial = { sub: 'fixture-reviewer', name: 'Fixture Reviewer', role: 'member', tenant: 'orgiq',
  grants: { orgiq: ['member'], assessment: ['assessor'] },
  switchable: { orgiq: ['member'], assessment: ['assessor', 'lead-assessor'] },
  availableRoles: ['member'], availableTenants: ['orgiq', 'assessment'], masquerading: null };
const canonical = { ...initial, tenant: 'assessment', role: 'assessor', availableRoles: ['assessor'] };
type Options = { holdCanonical?: boolean; earlierRead?: boolean; lookupFailure?: number;
  tenantRefused?: boolean; roleAccepted?: boolean; roleNetworkFailure?: boolean };

async function fixture(page: Page, options: Options = {}) {
  const writes: { path: string; body: unknown }[] = [], unexpected: string[] = [], errors: string[] = [];
  let meReads = 0, changed = false, canonicalReadStarted = false;
  let releaseCanonical!: () => void, releaseEarlier!: () => void;
  const canonicalGate = new Promise<void>(resolve => { releaseCanonical = resolve; });
  const earlierGate = new Promise<void>(resolve => { releaseEarlier = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === 'POST') writes.push({ path, body: request.postDataJSON() as unknown });
    if (path === '/api/auth/config') return route.fulfill({ json: { ssoEnabled: false } });
    if (path === '/api/session/realtime-token') return route.fulfill({ json: { token: 'synthetic-earlier-workspace-token', expiresAt: '2099-01-01T00:00:00Z' } });
    if (path === '/api/session/me') {
      meReads++;
      if (options.earlierRead && meReads === 2) {
        await earlierGate;
        return route.fulfill({ json: initial });
      }
      if (changed) {
        canonicalReadStarted = true;
        if (options.holdCanonical) await canonicalGate;
        if (options.lookupFailure) return route.fulfill({ status: options.lookupFailure, json: { error: 'Fixture canonical lookup unavailable' } });
        return route.fulfill({ json: canonical });
      }
      return route.fulfill({ json: initial });
    }
    if (path === '/api/session/tenant' && request.method() === 'POST') {
      if (options.tenantRefused) return route.fulfill({ status: 403, json: { error: 'Tenant no longer held' } });
      changed = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/session/role' && request.method() === 'POST') {
      if (options.roleNetworkFailure) return route.abort();
      return route.fulfill(options.roleAccepted ? { json: { ok: true } }
        : { status: 403, json: { error: 'Requested role no longer held' } });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.abort();
  });
  await page.route('**/__context_transition', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/e2e/fixtures/context-transition.tsx"></script></body></html>' }));
  await page.route(`**${TENANT_HOME.assessment}`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture Assessment destination</h1>' }));
  await page.goto('/__context_transition');
  await expect(page.getByTestId('session-state')).toContainText('"sessionStatus":"ready"');
  await page.getByRole('button', { name: 'Seed fixture caches', exact: true }).click();
  await expect(page.getByTestId('cache-state')).toContainText('synthetic-earlier-workspace-token');
  return { writes, unexpected, errors, releaseCanonical, releaseEarlier,
    reads: () => meReads, canonicalStarted: () => canonicalReadStarted };
}
async function assertScrubbed(page: Page) {
  await expect(page.getByTestId('cache-state')).toHaveText(JSON.stringify({ judge: null, conversation: null,
    inbox: null, ownSave: null, token: null, preference: 'device preference' }));
}

test('role refusal after tenant success clears prior state before canonical refresh and remains a failure', async ({ page }) => {
  const probe = await fixture(page, { holdCanonical: true });
  try {
    await page.getByRole('button', { name: 'Choose tenant and role', exact: true }).click();
    await expect.poll(probe.canonicalStarted).toBe(true);
    await expect(page.getByTestId('session-state')).toHaveText('{"session":null,"sessionStatus":"loading","isLoading":true}');
    await assertScrubbed(page);
    await expect(page.getByTestId('transition-result')).toHaveText('pending');
    probe.releaseCanonical();
    await expect(page.getByTestId('session-state')).toContainText('"tenant":"assessment"');
    await expect(page.getByTestId('session-state')).toContainText('"role":"assessor"');
    await expect(page.getByTestId('session-state')).toContainText('"sessionStatus":"ready"');
    await expect(page.getByTestId('transition-result')).toHaveText('Requested role no longer held');
    await expect(page).toHaveURL(/__context_transition$/);
    expect(probe.reads()).toBe(2);
    expect(probe.writes).toEqual([{ path: '/api/session/tenant', body: { tenant: 'assessment' } },
      { path: '/api/session/role', body: { role: 'lead-assessor' } }]);
    expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
  } finally { probe.releaseCanonical(); }
});

test('unavailable canonical lookup denies access instead of restoring the earlier workspace', async ({ page }) => {
  const probe = await fixture(page, { lookupFailure: 503 });
  await page.getByRole('button', { name: 'Choose tenant and role', exact: true }).click();
  await expect(page.getByTestId('transition-result')).toHaveText('Requested role no longer held');
  await expect(page.getByTestId('session-state')).toContainText('"sessionStatus":"unavailable"');
  await expect(page.getByTestId('session-state')).toContainText('"grants":{}');
  await expect(page.getByTestId('session-state')).not.toContainText('fixture-reviewer');
  await assertScrubbed(page);
  expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
});

test('network failure of the role request also revalidates the already changed tenant', async ({ page }) => {
  const probe = await fixture(page, { roleNetworkFailure: true });
  await page.getByRole('button', { name: 'Choose tenant and role', exact: true }).click();
  await expect(page.getByTestId('transition-result')).toContainText('fetch');
  await expect(page.getByTestId('session-state')).toContainText('"tenant":"assessment"');
  await expect(page.getByTestId('session-state')).toContainText('"role":"assessor"');
  await assertScrubbed(page);
  expect(probe.reads()).toBe(2);
  expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
});

test('late session read from before the tenant write cannot restore the earlier tenant', async ({ page }) => {
  const probe = await fixture(page, { earlierRead: true });
  try {
    await page.getByRole('button', { name: 'Begin earlier session refresh', exact: true }).click();
    await expect.poll(probe.reads).toBe(2);
    await page.getByRole('button', { name: 'Choose tenant and role', exact: true }).click();
    await expect(page.getByTestId('transition-result')).toHaveText('Requested role no longer held');
    await expect(page.getByTestId('session-state')).toContainText('"tenant":"assessment"');
    probe.releaseEarlier();
    await expect.poll(probe.reads).toBe(3);
    await expect(page.getByTestId('earlier-read-result')).toHaveText('done');
    await expect(page.getByTestId('session-state')).toContainText('"tenant":"assessment"');
    await assertScrubbed(page);
    expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
  } finally { probe.releaseEarlier(); }
});

test('refused tenant does not attempt a role change or clear unchanged tenant caches', async ({ page }) => {
  const probe = await fixture(page, { tenantRefused: true });
  await page.getByRole('button', { name: 'Choose tenant and role', exact: true }).click();
  await expect(page.getByTestId('transition-result')).toHaveText('Tenant no longer held');
  await expect(page.getByTestId('session-state')).toContainText('"tenant":"orgiq"');
  await expect(page.getByTestId('cache-state')).toContainText('earlier workspace data');
  expect(probe.reads()).toBe(1);
  expect(probe.writes).toEqual([{ path: '/api/session/tenant', body: { tenant: 'assessment' } }]);
  expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
});

for (const mode of ['tenant only', 'tenant and role']) test(`successful ${mode} selection retains existing redirect semantics`, async ({ page }) => {
  const probe = await fixture(page, { roleAccepted: true });
  await page.getByRole('button', { name: `Choose ${mode}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture Assessment destination', exact: true })).toBeVisible();
  expect(probe.writes).toEqual([{ path: '/api/session/tenant', body: { tenant: 'assessment' } },
    ...(mode === 'tenant and role' ? [{ path: '/api/session/role', body: { role: 'lead-assessor' } }] : [])]);
  expect(await page.evaluate(() => localStorage.getItem('iq-judge-config'))).toBeNull();
  expect(probe.unexpected).toEqual([]); expect(probe.errors).toEqual([]);
});
