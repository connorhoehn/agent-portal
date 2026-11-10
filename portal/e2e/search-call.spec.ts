// The tile shelf is the shell's one media sink, collapsed under the footer row
// (SocialFooter.tsx): the dock is read for text/phase, and the row holds Leave.
// A call started from the Search page (docs/social-calls-plan.md step 6),
// walked the way initiative-call.spec.ts walks the initiative call:
// two browser contexts, fake camera + microphone, against the middleware's own
// gateway (`/ws` on :3001), platform-api and the SFU.
//
// Cast: Vera Green (u-vera, person p-002) has Nora DaSilva (u-nora, p-004)
// selected on Search's connections tab and clicks Start call; Nora is on
// another /iq page (the Initiatives list) and gets the shell's toast.
//
//   1. ring → accept → both docks "2 people" → Vera leaves → both end
//   2. ring → decline → Vera's dock ends
//
// Needs a portal that knows platform-api (+ the SFU, for media): the realtime
// token's platformApiUrl / videoUrl, or a Vite started with
// VITE_PLATFORM_API_URL / VITE_VIDEO_ENDPOINT — by default the second Vite the
// first-call doc uses on :5184; override with SEARCH_CALL_PORTAL. Without
// platform-api, Start call is off ("Calls need …") and this spec skips, saying so.
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs } from './realSession';

const PORTAL = process.env.SEARCH_CALL_PORTAL ?? 'http://localhost:5183';
const SEARCH = '/iq/search?tab=connections&selection=person%3Ap-004';

test.describe.configure({ mode: 'serial' });

let browser: Browser;
test.beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
});
test.afterAll(async () => { await browser?.close(); });

async function signedIn(userId: string): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await openAs(browser, userId, { baseURL: PORTAL, contextOptions: { permissions: ['camera', 'microphone'] }, preJoin: 'remembered' });
  return { context, page };
}

/** Vera on Search with Nora selected, Start call enabled (or the spec skips with the reason). */
async function veraReadyToCall(page: Page) {
  await page.goto(SEARCH);
  const start = page.getByTestId('search-start-call');
  await expect(start).toBeVisible({ timeout: 20_000 });
  // Availability settles once the socket connects and the roster maps p-004.
  await expect.poll(async () => (await start.isEnabled()) || /Calls need/.test((await start.getAttribute('title')) ?? ''),
    { timeout: 20_000 }).toBe(true);
  const title = (await start.getAttribute('title')) ?? '';
  test.skip(/Calls need/.test(title), `${PORTAL} cannot place calls: ${title}`);
  await expect(start).toBeEnabled();
  expect(title).toContain('Call Nora DaSilva');
  return start;
}

async function noraElsewhere(page: Page) {
  await page.goto('/iq/projects');
  // The shell's socket must be up before the ring, or the invite has nobody to reach.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(1_500);
}

test('Search: ring → accept → both live → leave', async () => {
  test.setTimeout(120_000);
  const vera = await signedIn('u-vera');
  const nora = await signedIn('u-nora');
  try {
    await noraElsewhere(nora.page);
    const start = await veraReadyToCall(vera.page);

    await start.click();
    const veraDock = vera.page.getByTestId('search-call-dock');
    await expect(veraDock).toHaveCount(1, { timeout: 10_000 });

    const toast = nora.page.getByTestId('incoming-call-toast');
    await expect(toast).toContainText('Vera Green is calling', { timeout: 15_000 });
    await expect(vera.page.getByTestId('shell-call-dock')).toContainText('Calling Nora DaSilva', { timeout: 15_000 });

    await nora.page.getByTestId('incoming-call-accept').click();
    // Accept opens Search on the same people (the invite's channel) and answers there.
    await expect(nora.page).toHaveURL(/\/iq\/search\?.*selection=person%3Ap-004/, { timeout: 10_000 });
    for (const p of [vera, nora]) await expect(p.page.getByTestId('shell-call-dock')).toContainText('2 joined', { timeout: 20_000 });
    await expect(toast).toHaveCount(0);

    await vera.page.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    // In a two-person call one Leave ends it for both: "Call ended", then idle.
    for (const p of [vera, nora]) await expect(p.page.getByTestId('shell-call-dock')).toHaveCount(0, { timeout: 15_000 });
    await expect(vera.page.getByTestId('search-start-call')).toBeEnabled({ timeout: 15_000 });
  } finally {
    await vera.context.close();
    await nora.context.close();
  }
});

test('Search: ring → decline → the caller\'s dock ends', async () => {
  test.setTimeout(120_000);
  const vera = await signedIn('u-vera');
  const nora = await signedIn('u-nora');
  try {
    await noraElsewhere(nora.page);
    const start = await veraReadyToCall(vera.page);

    await start.click();
    await expect(vera.page.getByTestId('shell-call-dock')).toContainText('Calling Nora DaSilva', { timeout: 15_000 });
    await expect(nora.page.getByTestId('incoming-call-toast')).toBeVisible({ timeout: 15_000 });

    await nora.page.getByTestId('incoming-call-decline').click();
    await expect(nora.page.getByTestId('incoming-call-toast')).toHaveCount(0);
    await expect(nora.page).toHaveURL(/\/iq\/projects$/);
    // Declined: straight to "Call ended" (then idle) — never "2 people".
    await expect(vera.page.getByTestId('shell-call-dock')).toHaveCount(0, { timeout: 15_000 });
    await expect(vera.page.getByTestId('search-start-call')).toBeEnabled({ timeout: 15_000 });
  } finally {
    await vera.context.close();
    await nora.context.close();
  }
});
