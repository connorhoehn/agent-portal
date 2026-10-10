// A page huddle's call history (docs/audit-loop/realtime-parity.md §4a item 8):
// two people walk into the assessment team's huddle over the real local SFU,
// stay a few seconds and leave; each then opens the team page's Calls view
// (beside Chat | Pinned | Files) and sees the call with its duration and the
// other person. The tenant's Calls page lists it with the same row. A person
// with no access to the team (an orgiq session, a social-only session) is
// refused by the BFF, never shown rows.
//
// Against the shared Tilt app (http://127.0.0.1:5183; middleware :3001 with the
// gateway, gateway :28080, platform-api :23001, SFU :3902). Opt in with
// REAL_MEDIA_ACCEPTANCE=1. Fake devices; the pre-join choice is seeded
// (e2e/preJoin.ts). Logins are fresh contexts, never the user's own session.
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const TEAM = 'TEAM-005';
const LOBBY = `assessment:team:${TEAM}`;
const TEAM_NAME = 'Notifications Service';

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
const callsTab = (page: Page) => page.locator('[data-testid$="-tab-calls"]').first();

test('a team huddle between two sessions is listed in both Calls views with duration and participants; an outsider is refused', async ({ browser }) => {
  test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires the local SFU and platform-api (REAL_MEDIA_ACCEPTANCE=1)');
  test.setTimeout(240_000);
  const asha = await signedIn(browser, 'u-asha');
  const jonas = await signedIn(browser, 'u-jonas');
  const outsiders = [await signedIn(browser, 'u-mia'), await signedIn(browser, 'u-mira')];
  try {
    await asha.page.goto(`/assessment/teams/${TEAM}`);
    await expect(footer(asha.page)).toContainText(`${TEAM_NAME} huddle`, { timeout: 20_000 });
    await expect(huddleButton(asha.page)).toBeEnabled({ timeout: 20_000 });
    await huddleButton(asha.page).click();
    await expect(asha.page.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });

    await jonas.page.goto(`/assessment/teams/${TEAM}`);
    await expect(huddleButton(jonas.page)).toBeEnabled({ timeout: 20_000 });
    await huddleButton(jonas.page).click();
    await expect(jonas.page.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });

    // The live huddle is a card in the Calls view of anyone not in it; here both are in, so it names who is.
    await jonas.page.waitForTimeout(8_000);
    for (const { page } of [jonas, asha]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      await leave.click();
      await expect(page.getByTestId('shell-call-dock')).toBeHidden({ timeout: 20_000 });
    }

    // Each person's own history: the call, how long it ran, and who else was there.
    for (const [me, other] of [[jonas, 'Asha Nair'], [asha, 'Jonas Lindqvist']] as const) {
      await me.page.goto(`/assessment/teams/${TEAM}`);
      await me.page.getByRole('tab', { name: /Discussion/ }).first().click();
      await expect(callsTab(me.page)).toBeVisible({ timeout: 30_000 });
      await callsTab(me.page).click();
      const row = me.page.locator('[data-testid$="-calls-row"]').first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(other);
      await expect(row).toContainText(/\d+\s?(s|sec|m|min)/i);
    }

    // The same call on the tenant's Calls page, through the same rows.
    await jonas.page.goto('/assessment/calls');
    await expect(jonas.page.getByTestId('tenant-call-log')).toBeVisible({ timeout: 30_000 });
    await expect(jonas.page.getByTestId('tenant-call-log')).toContainText(`Team ${TEAM}`);
    await expect(jonas.page.getByTestId('tenant-call-log')).toContainText('Asha Nair');

    // Outsiders: the BFF refuses the lobby's history (another tenant's lobby does not exist from there).
    for (const { context } of outsiders) {
      expect((await context.request.get(`/api/calls?lobby=${encodeURIComponent(LOBBY)}`)).status()).toBe(404);
    }
    const mia = outsiders[0]!;
    await mia.page.goto('/assessment/calls');
    await expect(mia.page.getByTestId('tenant-call-log')).toBeHidden();
  } finally {
    await Promise.all([asha, jonas, ...outsiders].map(p => p.context.close()));
  }
});
