import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs } from './realSession';

// The initiative call, end to end, with two real browsers: Vera Green
// (u-vera, org-leader) starts a call from Auth Migration and Nora DaSilva
// (u-nora, an SME on it) answers. What it proves, through the dock and the
// incoming toast only:
//   ring    Start call -> Vera's dock "Calling Nora DaSilva…"; Nora's toast
//           "Vera Green is calling" on a page that is NOT the initiative
//   accept  Accept -> Nora lands on the initiative; both docks read
//           "2 people" and carry a playing <video> (the fake camera, through
//           the SFU)
//   leave   one Leave ends a two-person call for BOTH ("Call ended")
//   decline Decline -> the toast goes, Vera's dock reads "Call ended", and
//           Start call works again
// Cast: Vera is p-002 and Nora is p-004 on
// p-auth-migration (initiativeCallModel.ts maps person -> user through
// GET /api/roster/users).
//
// Needs the offline social stack, and a portal built WITH calls configured:
//   - middleware `npm run dev:mock:social` on :3001, /api/health
//     realtime.gateway === 'on' (the /ws gateway)
//   - platform-api (`social-platform-api`, :23001) and the SFU (:3901)
//   - a portal with VITE_PLATFORM_API_URL and VITE_VIDEO_ENDPOINT set —
//     without them Start call is disabled ("Calls need platform-api…")
// Point CALL_BASE_URL at that portal when it is not :5183, e.g.
//   VITE_PLATFORM_API_URL=http://localhost:23001 VITE_VIDEO_ENDPOINT=http://localhost:3901 \
//     npx vite --port 5184 --strictPort   # then CALL_BASE_URL=http://localhost:5184
// Every prerequisite is probed first; a missing one SKIPS with its reason.
// Fake media is Chromium's own (`--use-fake-device-for-media-stream`).

const INITIATIVE = 'p-auth-migration';
const INITIATIVE_URL = `/iq/projects/${INITIATIVE}`;
const SFU_URL = process.env['CALL_SFU_URL'] ?? 'http://localhost:3901';

test.use({
  ...(process.env['CALL_BASE_URL'] ? { baseURL: process.env['CALL_BASE_URL'] } : {}),
  viewport: { width: 1440, height: 900 },
  permissions: ['camera', 'microphone'],
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

type Person = { page: Page; context: BrowserContext };

async function person(browser: Browser, userId: string, path: string): Promise<Person> {
  const { page, context } = await openAs(browser, userId, {
    viewport: { width: 1440, height: 900 },
    contextOptions: { permissions: ['camera', 'microphone'] },
    ...(process.env['CALL_BASE_URL'] ? { baseURL: process.env['CALL_BASE_URL'] } : {}),
    preJoin: 'remembered',
    url: path,
  });
  return { page, context };
}

/** GET /api/health with a few retries: a `tsx watch` restart of the middleware is a gap of a second or two, not an outage. */
async function gatewayHealth(request: APIRequestContext): Promise<{ realtime?: { gateway?: string } } | null> {
  for (let i = 0; i < 5; i++) {
    const body = await request.get('/api/health').then((r) => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
    if (body) return body;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

const startButton = (p: Person) => p.page.getByTestId('initiative-start-call');
// The tile shelf is the shell's one media sink; collapsed under the footer row
// (SocialFooter.tsx), so it is read for text/media, and the row holds Leave.
const dock = (p: Person) => p.page.getByTestId('initiative-call-dock');
const toast = (p: Person) => p.page.getByTestId('incoming-call-toast');

test.describe('initiative call', () => {
  let skipReason: string | null = null;

  test.beforeAll(async ({ request, browser }) => {
    const health = await gatewayHealth(request);
    if (!health || health.realtime?.gateway !== 'on') {
      skipReason = 'the :3001 middleware is unreachable or its /ws gateway is off (GET /api/health realtime.gateway) — start `npm run dev:mock:social`';
      return;
    }
    const sfu = await fetch(SFU_URL, { signal: AbortSignal.timeout(3_000) }).then(() => true).catch(() => false);
    if (!sfu) {
      skipReason = `the SFU is not reachable at ${SFU_URL} (set CALL_SFU_URL if it lives elsewhere)`;
      return;
    }
    // Calls need platform-api in the BROWSER's build: the Start button says why it is off.
    const vera = await person(browser, 'u-vera', INITIATIVE_URL);
    try {
      await expect(startButton(vera)).toBeVisible({ timeout: 20_000 });
      await expect(startButton(vera)).toBeEnabled({ timeout: 15_000 }).catch(() => undefined);
      if (await startButton(vera).isDisabled()) {
        const why = (await startButton(vera).getAttribute('title')) ?? 'no reason given';
        skipReason = `Start call is disabled at ${test.info().project.use.baseURL ?? 'the portal'}: "${why}" — point CALL_BASE_URL at a portal built with VITE_PLATFORM_API_URL and VITE_VIDEO_ENDPOINT`;
      }
      if (skipReason) return;
      // …and platform-api must be able to open a session (it calls the SFU): ring once and
      // watch the dock leave "connecting". `data-phase="error"` ("Lost the call") is a 502
      // from platform-api — typically its VIDEO_API_URL names an SFU that is not running.
      await startButton(vera).click();
      await expect(dock(vera)).toHaveCount(1, { timeout: 10_000 });
      await expect.poll(async () => dock(vera).getAttribute('data-phase'), { timeout: 15_000 }).not.toBe('connecting').catch(() => undefined);
      if ((await dock(vera).getAttribute('data-phase')) === 'error') {
        skipReason = 'platform-api answered the session request with an error, so the dock read "Lost the call" — it cannot reach its SFU (check VIDEO_API_URL on the platform-api container against the SFU you are running)';
      } else {
        await vera.page.getByTestId(/^(shell-)?call-dock-leave$/).first().click().catch(() => undefined);
        await vera.page.waitForTimeout(1_000);
      }
    } finally { await vera.context.close(); }
  });

  test.beforeEach(() => {
    // The list reporter does not print skip reasons, so say it once on the console too.
    if (skipReason) console.warn(`[initiative-call] skipped: ${skipReason}`);
    test.skip(skipReason !== null, skipReason ?? '');
  });

  /** Vera on the initiative, Nora somewhere else in the /iq shell; both gateway-connected. */
  async function ready(browser: Browser): Promise<{ vera: Person; nora: Person }> {
    const vera = await person(browser, 'u-vera', INITIATIVE_URL);
    const nora = await person(browser, 'u-nora', '/iq/projects');
    await expect(startButton(vera)).toBeEnabled({ timeout: 20_000 });
    // Nora's socket must be up before Vera rings, or the invite reaches nobody.
    await expect(nora.page.getByRole('heading').first()).toBeVisible({ timeout: 20_000 });
    await nora.page.waitForTimeout(1_500);
    return { vera, nora };
  }

  test('ring, accept, both live, leave ends it for both', async ({ browser }) => {
    test.setTimeout(120_000);
    const { vera, nora } = await ready(browser);
    const errors: string[] = [];
    for (const p of [vera, nora]) p.page.on('pageerror', (e) => errors.push(e.message));
    try {
      await expect(dock(vera)).toHaveCount(0);
      await startButton(vera).click();

      // Ring: the caller waits, the callee is told — on a page that is not the initiative.
      await expect(dock(vera)).toContainText(/Calling Nora DaSilva/, { timeout: 15_000 });
      await expect(toast(nora)).toBeVisible({ timeout: 10_000 });
      await expect(toast(nora)).toContainText('Vera Green is calling');
      await expect(toast(nora)).toContainText('Video call');
      expect(new URL(nora.page.url()).pathname).toBe('/iq/projects');

      // Accept: the toast goes, Nora is taken to the initiative, both are in.
      await nora.page.getByTestId('incoming-call-accept').click();
      await expect(toast(nora)).toHaveCount(0);
      await expect(nora.page).toHaveURL(new RegExp(`${INITIATIVE_URL}$`), { timeout: 15_000 });
      for (const p of [vera, nora]) await expect(dock(p)).toContainText(/2 people/, { timeout: 30_000 });
      await expect(dock(vera)).not.toContainText(/Calling Nora/);

      // Fake media: each side has a playing <video> in its dock.
      for (const p of [vera, nora]) {
        await expect.poll(() => dock(p).locator('video').evaluateAll((els) =>
          (els as HTMLVideoElement[]).filter((v) => v.readyState >= 2 && !v.paused && v.videoWidth > 0).length), { timeout: 30_000 }).toBeGreaterThan(0);
      }

      // Leave: one click ends a two-person call for both.
      await vera.page.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
      for (const p of [vera, nora]) await expect(dock(p)).toContainText(/Call ended/, { timeout: 15_000 });
      for (const p of [vera, nora]) await expect(dock(p)).toHaveCount(0, { timeout: 15_000 });
      // …and Vera can ring again.
      await expect(startButton(vera)).toBeEnabled();
      expect(errors, 'page errors').toEqual([]);
    } finally {
      await vera.context.close();
      await nora.context.close();
    }
  });

  test('decline: the toast goes, the caller sees the call end, and can ring again', async ({ browser }) => {
    test.setTimeout(90_000);
    const { vera, nora } = await ready(browser);
    try {
      await startButton(vera).click();
      await expect(dock(vera)).toContainText(/Calling Nora DaSilva/, { timeout: 15_000 });
      await expect(toast(nora)).toContainText('Vera Green is calling', { timeout: 10_000 });

      await nora.page.getByTestId('incoming-call-decline').click();
      await expect(toast(nora)).toHaveCount(0);
      // Declining does not take Nora anywhere, and she is not in a call.
      expect(new URL(nora.page.url()).pathname).toBe('/iq/projects');
      await expect(dock(vera)).toContainText(/Call ended/, { timeout: 15_000 });
      await expect(dock(vera)).not.toContainText(/2 people/);
      await expect(dock(vera)).toHaveCount(0, { timeout: 15_000 });
      await expect(startButton(vera)).toBeEnabled();
    } finally {
      await vera.context.close();
      await nora.context.close();
    }
  });
});
