import { type Page } from '@playwright/test';
import { test, expect } from '../cdpTest';

test.use({ baseURL: 'http://127.0.0.1:5183' });
const initial = { sub: 'u-vera', name: 'Vera Green', role: 'org-leader', tenant: 'orgiq',
  grants: { orgiq: ['org-leader'], social: ['participant'] }, switchable: { orgiq: ['org-leader'], social: ['participant'] },
  availableRoles: ['org-leader'], availableTenants: ['orgiq', 'social'], masquerading: null };

async function fixture(page: Page) {
  let session = { ...initial };
  const errors: string[] = [];
  const people = [{ userId: 'u-vera', displayName: 'Vera Green' }, { userId: 'u-nora', displayName: 'Simone Chang' }];
  await page.route('**/api/session/me', route => route.fulfill({ json: session }));
  await page.route('**/api/auth/config', route => route.fulfill({ json: { ssoEnabled: false } }));
  await page.route('**/api/session/realtime-token', route => route.fulfill({ json: { token: 'fixture-token',
    expiresAt: '2099-01-01T00:00:00Z', platformApiUrl: 'http://fixture-platform.invalid', videoUrl: 'http://fixture-video.invalid' } }));
  await page.route('http://fixture-platform.invalid/**', route => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ json: path.endsWith('/join') ? { participantId: 'fixture-participant', token: 'malformed-media-token' }
      : path.endsWith('/sessions') ? { sessionId: 'fixture-session' } : {} });
  });
  await page.route('**/api/calls/*/page', route => {
    const callId = new URL(route.request().url()).pathname.split('/')[3];
    return route.fulfill({ json: { type: 'call-page', callId, revision: 0, page: null } });
  });
  // The resolver names the call's chat channel and roster; messages are
  // gateway chat, answered below by an in-page stand-in for the chat service.
  await page.route('**/api/calls/*/chat**', async route => {
    const callId = new URL(route.request().url()).pathname.split('/')[3]!, channel = `orgiq:huddle:${callId}`;
    return route.fulfill({ json: { callId, channel, revision: 1, participants: people, messages: [], canSend: true, historyFrom: '2026-10-03T10:00:00Z' } });
  });
  await page.route('**/iq/projects/p-auth-migration**', route => {
    if (!route.request().isNavigationRequest()) return route.continue();
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div>
      <script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;</script>
      <script type="module" src="/e2e/fixtures/huddle-chat.tsx"></script></body></html>` });
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/iq/projects/p-auth-migration?tab=work&item=wi-cookie');
  await expect(page.getByTestId('fixture-platform-endpoint')).toHaveText('http://fixture-platform.invalid');
  await page.getByRole('button', { name: 'Start fixture call' }).click();
  await expect(page.getByTestId('fixture-call-phase')).toHaveText('calling');
  const callId = (await page.getByTestId('fixture-call-id').textContent())!;
  await page.evaluate(callId => {
    (window as unknown as { callFixture: { receive(frame: unknown): void } }).callFixture.receive({
      type: 'call', action: 'accepted', data: { callId, lobbyName: 'orgiq:dm:u-vera:u-nora',
        callerId: 'u-nora', userId: 'u-nora', displayName: 'Simone Chang', targetUserIds: ['u-vera'] },
    });
  }, callId);
  await expect(page.getByTestId('shell-call-dock-chat')).toHaveCount(1);
  await page.waitForTimeout(1500);
  await page.setViewportSize({ width: 1680, height: 940 });
  const names = await page.getByTestId('shell-call-dock').locator('[data-testid]').evaluateAll(els => els.map(e => e.getAttribute('data-testid')));
  console.log(names.join(','));
  console.log((await page.getByTestId('shell-footer').innerText()).replace(/\n/g, ' | '));
  await page.screenshot({ path: '/private/tmp/claude-501/-Users-connorhoehn-Projects-aws-agentcore/7aad70e9-0960-4a75-a575-96e73121111d/scratchpad/footer-call.png' });
  return {};
}
test('call shot', async ({ page }) => { await fixture(page); });
