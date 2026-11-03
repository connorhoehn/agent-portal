// One media sink follows the visible composer. Its compact preview and call
// controls share columns; all participants remain attached to the call.
// Uses real sessions and synthetic devices over the local SFU.
// Opt in with REAL_MEDIA_ACCEPTANCE=1.
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const INITIATIVE = process.env.GRID_INITIATIVE ?? 'p-auth-migration';
const TEAM = process.env.GRID_TEAM ?? 'TEAM-001';
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
test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires the local SFU and platform-api (REAL_MEDIA_ACCEPTANCE=1)');

async function signedIn(browser: Browser, userId: string, preJoin: 'remembered' | 'show' = 'remembered'): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, BASE, true, preJoin);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`${userId}: ${error.message}`));
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && /\/api\/(video|calls)\//.test(url.pathname)) errors.push(`${userId} ${response.request().method()} ${url.pathname} ${response.status()}`);
  });
  return { context, page, errors };
}

const huddleButton = (page: Page) => page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
/** The initiative's one composer, docked in the content column; its call block carries the huddle. */
const discussion = (page: Page) => page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
const grid = (page: Page) => discussion(page).getByTestId('composer-call-dock').getByTestId('call-dock-tile-row');

/**
 * Remote tiles drawing the other person's camera. A camera-off peer's <video>
 * stays mounted in the tile's 1px media sink so their audio keeps playing
 * (ui-components 694f8e05), and it still decodes black frames — so only a
 * tile drawn as `camera` counts.
 */
const playingRemoteTiles = (page: Page) => grid(page).locator('[data-is-local="false"][data-track-kind="camera"] video').evaluateAll(videos =>
  videos.filter(v => { const video = v as HTMLVideoElement; return !!video.srcObject && video.readyState >= 2 && video.videoWidth > 0; }).length);

async function expectPreview(page: Page, count: number) {
  const dock = discussion(page).getByTestId('composer-call-dock');
  await expect(dock).toHaveAttribute('data-holds-media', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('shell-call-media')).toHaveCount(1);
  await expect(dock.getByTestId('shell-call-media')).toHaveAttribute('data-layout', 'compact');
  // The composer holds the media, so the right pane offers no second video panel.
  await expect(page.getByTestId('huddle-media-panel')).toHaveCount(0);
  await expect(grid(page)).toHaveAttribute('data-variant', 'dock');
  await expect(grid(page)).toHaveAttribute('data-tile-count', String(count), { timeout: 45_000 });
  expect((await grid(page).boundingBox())!.height).toBeLessThanOrEqual(74);
}

test('two people in a huddle retain media in the compact composer preview', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-vera'), await signedIn(browser, 'u-nora')];
  const [vera, nora] = people.map(p => p.page) as [Page, Page];
  try {
    // Nora is somewhere else in the app; Vera's huddle on the initiative rings her.
    await nora.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(nora)).toBeEnabled({ timeout: 30_000 });
    await vera.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(vera)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(vera).click();
    await expect(vera.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
    // Ringing: the caller's composer already carries the bar with their own tile, and each invitee as a ringing placeholder.
    await expect(grid(vera).locator('[data-is-local="true"]')).toHaveCount(1, { timeout: 30_000 });
    await expect(grid(vera).locator('[data-peer-id="u-nora"]')).toHaveAttribute('data-ringing', 'true', { timeout: 30_000 });
    const invited = await grid(vera).locator('[data-ringing="true"]').count();
    await expect(grid(vera)).toHaveAttribute('data-tile-count', String(1 + invited));
    await nora.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    await expect(nora.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });

    for (const [page, other] of [[vera, 'Nora'], [nora, 'Vera']] as const) {
      await expectPreview(page, 2);
      const tiles = grid(page).locator('[data-peer-id]');
      await expect(tiles).toHaveCount(2);
      // The viewer first ("You"), then the other person by name, each with a mute state.
      await expect(tiles.first()).toHaveAttribute('data-is-local', 'true');
      await expect(tiles.first()).toContainText('You');
      await expect(tiles.nth(1)).toHaveAttribute('data-is-local', 'false');
      await expect(tiles.nth(1)).toContainText(other);
      await expect(tiles.nth(1)).toHaveAttribute('data-is-muted', /^(true|false)$/);
      await expect.poll(() => playingRemoteTiles(page), { timeout: 45_000 }).toBe(1);
      // The narrow bar keeps mic, camera, ⋯ and Leave; the footer is the status only (no second Leave).
      for (const id of ['call-dock-mic', 'call-dock-camera', 'call-dock-more', 'call-dock-leave']) await expect(discussion(page).getByTestId(id)).toBeVisible();
      await expect(page.getByTestId('shell-call-dock')).toBeVisible();
      await expect(page.getByTestId('shell-call-dock-leave')).toHaveCount(0);
      // No footer video toggle while a composer carries the tiles.
      await expect(page.getByTestId('shell-call-dock-media')).toHaveCount(0);
    }
    // Side by side: two columns of equal width.
    const boxes = await grid(vera).locator('[data-peer-id]').evaluateAll(tiles => tiles.map(t => t.getBoundingClientRect()).map(r => ({ x: r.x, y: r.y, w: r.width })));
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(2);
    expect(Math.abs(boxes[0]!.w - boxes[1]!.w)).toBeLessThan(2);
    await vera.screenshot({ path: test.info().outputPath('huddle-grid-two.png') });

    // Mute from the bar that owns the controls (here the composer's): its tile for the muted person says so (one call runtime).
    await vera.getByTestId(/^(shell-)?call-dock-mic$/).first().click();
    await expect(vera.getByTestId(/^(shell-)?call-dock-mic$/).first()).toHaveAttribute('aria-pressed', 'false');
    await expect(grid(vera).locator('[data-is-local="true"]')).toHaveAttribute('data-is-muted', 'true');
    await vera.getByTestId(/^(shell-)?call-dock-mic$/).first().click();

    // Nora leaves from the footer: the call is over for Vera too, and the panel goes with it.
    await nora.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    await expect(discussion(nora).getByTestId('composer-call-dock')).toHaveCount(0, { timeout: 20_000 });
    await expect(discussion(vera).getByTestId('composer-call-dock')).toHaveCount(0, { timeout: 20_000 });
    for (const person of people) expect(person.errors).toEqual([]);
  } finally {
    for (const page of [vera, nora]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
  }
});

// A page huddle keeps whoever is in it, so people walk in and out: on the
// assessment team page the dimension composer's call bar carries the tiles,
// 1 → 2 → 3 → 2 as people join and leave.
async function assessor(browser: Browser, userId: string) {
  const person = await signedIn(browser, userId);
  expect((await person.context.request.post('/api/session/tenant', { data: { tenant: 'assessment' } })).status(), 'tenant switch').toBe(200);
  return person;
}
const blockDock = (page: Page) => page.getByTestId('dimension-composer-block').getByTestId('composer-call-dock');
const blockGrid = (page: Page) => blockDock(page).getByTestId('call-dock-tile-row');
async function expectBlockGrid(page: Page, count: number) {
  await expect(blockDock(page)).toHaveAttribute('data-holds-media', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('shell-call-media')).toHaveCount(1);
  // The preview stays compact when the adjacent discussion pane opens.
  await expect(blockDock(page).getByTestId('shell-call-media')).toHaveAttribute('data-layout', 'compact');
  // The composer holds the media, so the right pane offers no second panel.
  await expect(page.getByTestId('huddle-media-panel')).toHaveCount(0);
  await expect(blockGrid(page)).toHaveAttribute('data-tile-count', String(count), { timeout: 45_000 });
}

const playingBlockRemotes = (page: Page) => blockGrid(page).locator('[data-is-local="false"] video').evaluateAll(videos =>
  videos.filter(v => { const video = v as HTMLVideoElement; return !!video.srcObject && video.readyState >= 2 && video.videoWidth > 0; }).length);

async function threeInTeamHuddle(browser: Browser) {
  const people = [await assessor(browser, 'u-asha'), await assessor(browser, 'u-jonas'), await assessor(browser, 'u-farah')];
  const pages = people.map(p => p.page) as [Page, Page, Page];
  const [asha, jonas, farah] = pages;
  for (const page of pages) await page.goto(`/assessment/teams/${TEAM}`);
  await expect(huddleButton(asha)).toBeEnabled({ timeout: 30_000 });
  await huddleButton(asha).click();
  await expectBlockGrid(asha, 1);
  await expect(huddleButton(jonas)).toBeEnabled({ timeout: 30_000 });
  await huddleButton(jonas).click();
  for (const page of [asha, jonas]) await expectBlockGrid(page, 2);
  await expect(huddleButton(farah)).toBeEnabled({ timeout: 30_000 });
  await huddleButton(farah).click();
  for (const page of pages) await expectBlockGrid(page, 3);
  return { people, pages };
}
async function leaveAll(people: Array<{ context: BrowserContext; page: Page }>) {
  for (const { page } of people) {
    const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
    if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
  }
  await Promise.all(people.map(p => p.context.close()));
}

test('a team page huddle\'s tiles grow 1 → 2 → 3 above the composer as people walk in', async ({ browser }) => {
  test.setTimeout(240_000);
  let people: Awaited<ReturnType<typeof threeInTeamHuddle>>['people'] = [];
  try {
    const three = await threeInTeamHuddle(browser);
    people = three.people;
    const [asha] = three.pages;
    // Three equal tiles, the viewer first, every one fully inside the block — none cut at its edge or hidden
    // (at ~460px beside the huddle chat the full bar's row used to clip the second tile and hide the third).
    const { boxes, row } = await blockGrid(asha).evaluate(element => ({
      row: (({ left, right, top, bottom }) => ({ left, right, top, bottom }))(element.getBoundingClientRect()),
      boxes: [...element.querySelectorAll('[data-peer-id]')].map(t => ({ local: t.getAttribute('data-is-local'), ...(({ left, right, top, bottom, width }) => ({ left, right, top, bottom, width }))(t.getBoundingClientRect()) })),
    }));
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.local).toBe('true');
    for (const box of boxes) {
      expect(box.left).toBeGreaterThanOrEqual(row.left - 1);
      expect(box.right).toBeLessThanOrEqual(row.right + 1);
      expect(box.bottom).toBeLessThanOrEqual(row.bottom + 1);
      expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(2);
    }
    await asha.screenshot({ path: test.info().outputPath('team-huddle-grid-three.png') });
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await leaveAll(people); }
});

// One person leaving a page huddle releases only their seat (realtime-modules
// 0.113: join adopts the lobby's live call, `ended` aimed at yourself is the
// leave), so the other two keep their media and the grid reflows 3 → 2.
test('a person leaving a three-person team huddle leaves the other two in a two-pane grid', async ({ browser }) => {
  test.setTimeout(240_000);
  let people: Awaited<ReturnType<typeof threeInTeamHuddle>>['people'] = [];
  try {
    const three = await threeInTeamHuddle(browser);
    people = three.people;
    const [asha, jonas, farah] = three.pages;
    for (const page of three.pages) await expect.poll(() => playingBlockRemotes(page), { timeout: 45_000, message: 'before leave' }).toBe(2);
    await farah.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    await expect(blockDock(farah)).toHaveCount(0, { timeout: 20_000 });
    for (const page of [asha, jonas]) {
      await expectBlockGrid(page, 2);
      await expect.poll(() => playingBlockRemotes(page), { timeout: 45_000 }).toBe(1);
    }
    // The call's chat followed the seats: still two people in it.
    await asha.waitForTimeout(3_000);
    for (const page of [asha, jonas]) await expectBlockGrid(page, 2);
  } finally { await leaveAll(people); }
});

// The one pre-join step: the device check shows before the caller starts and
// before a ring is answered (with a 10 s "join as last time" countdown), the
// choices apply to the joined tracks, and Remember skips it next time.
test('the pre-join device check precedes start and accept, applies its choices and is skipped once remembered', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-vera', 'show'), await signedIn(browser, 'u-nora', 'show')];
  const [vera, nora] = people.map(p => p.page) as [Page, Page];
  try {
    await nora.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(nora)).toBeEnabled({ timeout: 30_000 });
    await vera.goto(`/iq/projects/${INITIATIVE}`);
    await expect(huddleButton(vera)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(vera).click();
    await expect(vera.getByTestId('prejoin-dialog')).toBeVisible();
    await expect(vera.getByTestId('prejoin-devices')).toBeVisible();
    await expect(vera.getByTestId('shell-call-dock')).toHaveCount(0);
    // Vera joins with the camera off and remembers the choice.
    await vera.getByTestId('prejoin-camera').click();
    await vera.getByTestId('prejoin-remember').click();
    await vera.getByTestId('prejoin-join').click();
    await expect(vera.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
    await expect(vera.getByTestId(/^(shell-)?call-dock-camera$/).first()).toHaveAttribute('aria-pressed', 'false', { timeout: 30_000 });

    // Nora's Accept offers the check too, counting down into "join as last time".
    await nora.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    await expect(nora.getByTestId('prejoin-dialog')).toBeVisible();
    await expect(nora.getByTestId('prejoin-join')).toContainText(/Join as last time \(\d+\)/);
    await expect(nora.getByTestId('shell-call-dock')).toBeVisible({ timeout: 20_000 });
    await expect(nora.getByTestId('prejoin-dialog')).toHaveCount(0);

    await expectPreview(vera, 2);
    await expectPreview(nora, 2);
    // Vera's camera stayed off: Nora decodes no remote video, and only one media sink exists on each side.
    await expect.poll(() => playingRemoteTiles(nora), { timeout: 20_000 }).toBe(0);
    for (const page of [vera, nora]) await expect(page.getByTestId('shell-call-media')).toHaveCount(1);

    // Remembered: after Leave, the next Huddle goes straight in.
    await vera.getByTestId(/^(shell-)?call-dock-leave$/).first().click();
    await expect(discussion(vera).getByTestId('composer-call-dock')).toHaveCount(0, { timeout: 20_000 });
    await expect(huddleButton(vera)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(vera).click();
    await expect(vera.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
    await expect(vera.getByTestId('prejoin-dialog')).toHaveCount(0);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally {
    for (const page of [vera, nora]) {
      const leave = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
      if (await leave.count().catch(() => 0)) await leave.click().catch(() => undefined);
    }
    await Promise.all(people.map(p => p.context.close()));
  }
});
