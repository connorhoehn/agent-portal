// The footer's idle context group on pages with a realtime context
// (docs/audit-loop/realtime-parity.md gap 3): an assessment team page, an
// assessment document and a pipelines run name themselves in the footer,
// with Huddle and Message enabled for a reader; Message lands in the page's
// own conversation. An outsider (the orgiq façade of a run) gets Huddle
// disabled with the reason, and a direct socket attempt on the page lobbies
// is refused by the BFF gateway.
//
// Against the shared Tilt app (http://127.0.0.1:5183, middleware :3001 with
// the gateway on). No route fixtures. Logins are fresh contexts, never the
// user's own browser session. The two-session media test opts in with
// REAL_MEDIA_ACCEPTANCE=1 (local SFU :3902, platform-api :23002).
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const GATEWAY = process.env.GATEWAY_WS_URL ?? 'ws://127.0.0.1:3001/ws';
const TEAM = 'TEAM-005';
const TEAM_NAME = 'Notifications Service';
const DOC_URL = `/assessment/workspace?doc=${encodeURIComponent('page:100002')}`;

const test = base.extend<{}, { browser: Browser }>({
  browser: [async ({ playwright }, use) => {
    const browser = await playwright.chromium.launch({ channel: 'chrome', headless: true, args: [
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', '--disable-features=LocalNetworkAccessChecks',
    ] });
    try { await use(browser); } finally { await browser.close(); }
  }, { scope: 'worker' }],
});
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

async function signedIn(browser: Browser, userId: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, BASE, true);
  return { context, page: await context.newPage() };
}

const footer = (page: Page) => page.getByTestId('shell-footer-context');
const huddleButton = (page: Page) => footer(page).getByRole('button', { name: 'Huddle' });
const messageButton = (page: Page) => footer(page).getByRole('button', { name: 'Message' });

async function expectContext(page: Page, name: string | RegExp) {
  await expect(footer(page)).toContainText(name, { timeout: 20_000 });
  await expect(footer(page)).not.toContainText('No huddle here');
  await expect(huddleButton(page)).toBeEnabled({ timeout: 20_000 });
  await expect(messageButton(page)).toBeEnabled();
}

/** Message put the caret inside `scope` (the page's own conversation composer). */
async function expectFocusIn(page: Page, scope: string) {
  await expect.poll(() => page.evaluate(sel => !!document.activeElement?.closest(sel), scope), { timeout: 10_000 }).toBe(true);
}

async function firstPipelinesRun(page: Page): Promise<{ id: string; title: string }> {
  const response = await page.request.get('/api/pipelines/runs?limit=5');
  expect(response.status()).toBe(200);
  const run = (await response.json()).runs[0] as { id: string; context: { title: string } };
  return { id: run.id, title: run.context.title };
}

/** A raw socket with this context's own realtime token: what the gateway answers a call action. */
async function socketCallAnswers(context: BrowserContext, frames: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const { token } = await (await context.request.get('/api/session/realtime-token')).json() as { token: string };
  const ws = new WebSocket(GATEWAY, ['bearer-token-v1', token]);
  const received: Record<string, unknown>[] = [];
  ws.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
  await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('socket refused'))); });
  await expect.poll(() => received.some(frame => frame.type === 'session'), { timeout: 10_000 }).toBe(true);
  for (const frame of frames) ws.send(JSON.stringify(frame));
  await expect.poll(() => received.filter(frame => frame.type === 'error' && frame.service === 'call').length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(frames.length);
  ws.close();
  return received;
}

test('assessment team page: the footer names the team, Huddle and Message are enabled, Message opens its discussion', async ({ browser }) => {
  const { context, page } = await signedIn(browser, 'u-asha');
  try {
    await page.goto(`/assessment/teams/${TEAM}`);
    await expectContext(page, `${TEAM_NAME} huddle`);
    await messageButton(page).click();
    // The dimension composer under the scorecard answers Message (its Chat posts to this same Discussion).
    await expectFocusIn(page, '[data-testid="dimension-composer"]');
  } finally { await context.close(); }
});

test('assessment document: the footer names the document and Huddle no longer waits for someone else', async ({ browser }) => {
  const { context, page } = await signedIn(browser, 'u-jonas');
  try {
    await page.goto(DOC_URL);
    await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('page-composer-input')).toBeVisible({ timeout: 20_000 });
    await expect(footer(page)).not.toContainText('No huddle here', { timeout: 20_000 });
    await expect(huddleButton(page)).toBeEnabled({ timeout: 20_000 });
    await expect(messageButton(page)).toBeEnabled();
    await messageButton(page).click();
    await expectFocusIn(page, '[data-testid="page-composer-dock"]');
  } finally { await context.close(); }
});

test('pipelines run page: the footer names the run, Message focuses the run discussion', async ({ browser }) => {
  const { context, page } = await signedIn(browser, 'u-kofi');
  try {
    const run = await firstPipelinesRun(page);
    await page.goto(`/pipelines/runs/${encodeURIComponent(run.id)}`);
    await expectContext(page, `${run.title} huddle`);
    await messageButton(page).click();
    await expectFocusIn(page, '[data-testid="pipeline-discussion"]');
  } finally { await context.close(); }
});

test('social channel: the open conversation is the footer context and Message lands in its composer', async ({ browser }) => {
  const { context, page } = await signedIn(browser, 'u-mira');
  try {
    await page.goto('/social/channels/general');
    await expect(page.getByTestId('social-chat-composer-dock')).toBeVisible({ timeout: 20_000 });
    await expectContext(page, '#general');
    await messageButton(page).click();
    await expectFocusIn(page, '[data-testid="social-chat-composer-dock"]');
  } finally { await context.close(); }
});

test('an outsider: no huddle on the orgiq façade of a run, and the gateway refuses the page lobbies directly', async ({ browser }) => {
  const kofi = await signedIn(browser, 'u-kofi');
  const run = await firstPipelinesRun(kofi.page);
  await kofi.context.close();
  const { context, page } = await signedIn(browser, 'u-mia');
  try {
    await page.goto(`/iq/runs/${encodeURIComponent(run.id)}`);
    await expect(footer(page)).toContainText('No huddle here', { timeout: 20_000 });
    await expect(huddleButton(page)).toBeDisabled();
    await expect(huddleButton(page)).toHaveAttribute('title', /This page has no huddle/);
    const me = await (await context.request.get('/api/session/me')).json() as { sub: string };
    const answers = await socketCallAnswers(context, [
      { service: 'call', action: 'status', lobbyName: `assessment:team:${TEAM}` },
      { service: 'call', action: 'invite', callId: `outsider-${Date.now()}`, lobbyName: `pipelines:run:${run.id}`, callerId: me.sub, targetUserIds: ['u-kofi'] },
    ]);
    expect(answers.filter(frame => frame.type === 'error' && frame.service === 'call')).toHaveLength(2);
    expect(answers.some(frame => frame.type === 'call')).toBe(false);
  } finally { await context.close(); }
});

// ── One real two-session huddle from the team page ─────────────────────────

async function mediaStats(page: Page) {
  return page.evaluate(async () => {
    const peers = (window as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? [];
    const out = { connected: 0, audioSamples: 0, videoFrames: 0 };
    for (const pc of peers) {
      if (pc.connectionState === 'closed') continue;
      if (pc.connectionState === 'connected') out.connected++;
      (await pc.getStats()).forEach(row => {
        if (row.type !== 'inbound-rtp' || row.isRemote) return;
        if ((row.kind ?? row.mediaType) === 'audio') out.audioSamples += row.totalSamplesReceived ?? 0;
        else out.videoFrames += row.framesDecoded ?? 0;
      });
    }
    return out;
  });
}

test('real two-session huddle started from the team footer over the local SFU', async ({ browser }) => {
  test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires the local SFU and platform-api (REAL_MEDIA_ACCEPTANCE=1)');
  test.setTimeout(150_000);
  const people = [await signedIn(browser, 'u-asha'), await signedIn(browser, 'u-jonas')];
  const sessions = new Set<string>(); const failures: string[] = [];
  try {
    for (const { context, page } of people) {
      await context.addInitScript(() => {
        const pcs: RTCPeerConnection[] = [];
        (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs = pcs;
        window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, {
          construct(Target, args) { const pc = Reflect.construct(Target, args) as RTCPeerConnection; pcs.push(pc); return pc; },
        });
      });
      page.on('response', async response => {
        const url = new URL(response.url());
        if (response.status() >= 400 && /\/api\/video\//.test(url.pathname)) failures.push(`${response.request().method()} ${url.pathname} ${response.status()}`);
        if (response.request().method() === 'POST' && url.pathname === '/api/video/sessions' && response.ok()) {
          const body = await response.json().catch(() => null) as { sessionId?: string; lobbyName?: string } | null;
          if (body?.sessionId) sessions.add(body.sessionId);
        }
      });
    }
    const [asha, jonas] = people.map(p => p.page) as [Page, Page];
    await asha.goto(`/assessment/teams/${TEAM}`);
    await expectContext(asha, `${TEAM_NAME} huddle`);
    await huddleButton(asha).click();
    await expect(asha.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
    await expect(asha.getByTestId('shell-call-dock')).toContainText(`${TEAM_NAME} huddle`);
    // The second person opens the same page: the host discovers the huddle
    // that is on, and the footer's Huddle walks into it (no ring).
    await jonas.goto(`/assessment/teams/${TEAM}`);
    await expectContext(jonas, `${TEAM_NAME} huddle`);
    await huddleButton(jonas).click();
    await expect(jonas.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
    for (const page of [asha, jonas]) {
      await expect.poll(async () => (await mediaStats(page)).connected, { timeout: 45_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await mediaStats(page)).videoFrames, { timeout: 45_000 }).toBeGreaterThan(0);
      await expect.poll(async () => (await mediaStats(page)).audioSamples, { timeout: 45_000 }).toBeGreaterThan(0);
    }
    expect(sessions.size, 'both people share one media session for the team lobby').toBe(1);
    expect(failures).toEqual([]);
  } finally {
    for (const { page } of people) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
  }
});
