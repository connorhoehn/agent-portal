// The call bar and participant tiles sit directly ABOVE the conversation
// composer on every surface whose conversation holds the shell's call (the
// user's accepted mockup, docs/design/initiative-huddle-shell-plan.md "2026-10-07 composer huddle
// block"): title · people · clock, mic/camera, Share, People, settings,
// Leave, then the tiles ("You" first), then the input. The footer keeps the
// compact HuddleBar status at the same time; both read the one call runtime
// (the library useCallBlock claims the shell’s single media sink).
//
// Phases per surface: the caller's ring ("Calling …", the caller's own tile),
// in-call with both tiles once the callee accepts, and Leave removing it.
// Two real sessions on the shared Tilt app with Chrome's fake devices over
// the local SFU (:3902) — no route fixtures. Opt in with REAL_MEDIA_ACCEPTANCE=1.
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const DM = 'social:dm:u-farah:u-sana';
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
test.describe.configure({ mode: 'serial' });
test.skip(process.env.REAL_MEDIA_ACCEPTANCE !== '1', 'Requires the local SFU and platform-api (REAL_MEDIA_ACCEPTANCE=1)');

interface Person { context: BrowserContext; page: Page; errors: string[] }
async function signedIn(browser: Browser, userId: string, tenant?: string): Promise<Person> {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, BASE, true);
  if (tenant) expect((await context.request.post('/api/session/tenant', { data: { tenant } })).status(), 'tenant switch').toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`${userId}: ${error.message}`));
  if (process.env.HUDDLE_DEBUG) page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${userId} ${m.type()}] ${m.text().slice(0, 400)}`); });
  return { context, page, errors };
}
async function close(people: Person[]) {
  for (const { page } of people) {
    for (const id of ['call-dock-leave', 'shell-call-dock-leave']) {
      const leave = page.getByTestId(id).first();
      if (await leave.isVisible().catch(() => false)) await leave.click().catch(() => undefined);
    }
  }
  await Promise.all(people.map(p => p.context.close()));
}

const huddleButton = (page: Page) => page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
/** The composer's call block: the slot that holds the shell's one media sink. */
const composerDock = (scope: Page | Locator) => scope.getByTestId('composer-call-dock');
const tiles = (scope: Page | Locator) => composerDock(scope).getByTestId('call-dock-tile-row');

/** The bar and tiles are in `composer`, directly above its input, and the footer shows the compact status. */
/**
 * `shelf`: the full bar (mic ▾, camera ▾, Share, People, settings, Leave) over large tiles in a row.
 * `stack` (a side pane): mic ▾, camera ▾, ⋯ and Leave on the bar, the tiles two to a row.
 */
async function expectComposerBar(page: Page, composer: Locator, phase: string, tileCount: number, expected: 'shelf' | 'stack' | 'auto' = 'shelf', ringing?: number) {
  const dock = composerDock(composer);
  await expect(dock).toHaveAttribute('data-holds-media', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('shell-call-media')).toHaveCount(1);
  await expect(dock.getByTestId('shell-call-media')).toHaveAttribute('data-placement', 'composer');
  // `auto`: a composer squeezed below 640px (the huddle chat split open beside it) takes the narrow form.
  await expect(dock.getByTestId('shell-call-media')).toHaveAttribute('data-layout', expected === 'auto' ? /^(shelf|stack)$/ : expected);
  const layout = expected === 'auto'
    ? (await dock.getByTestId('shell-call-media').getAttribute('data-layout')) as 'shelf' | 'stack'
    : expected;
  await expect(dock.locator('[data-phase]').first()).toHaveAttribute('data-phase', phase, { timeout: 45_000 });
  const controls = layout === 'shelf'
    ? ['call-dock-title', 'call-dock-mic', 'call-dock-camera', 'call-dock-share', 'call-dock-people', 'call-dock-settings', 'call-dock-leave']
    : ['call-dock-title', 'call-dock-mic', 'call-dock-camera', 'call-dock-more', 'call-dock-leave'];
  for (const control of controls) await expect(dock.getByTestId(control)).toBeVisible();
  await expect(tiles(composer)).toHaveAttribute('data-tile-count', String(tileCount), { timeout: 45_000 });
  if (layout === 'stack') {
    await expect(tiles(composer)).toHaveAttribute('data-variant', 'grid');
    expect(Number(await tiles(composer).getAttribute('data-columns'))).toBeLessThanOrEqual(2);
  } else {
    await expect(dock.locator('[data-tile-size]').first()).toHaveAttribute('data-tile-size', 'lg');
  }
  await expect(tiles(composer).locator('[data-peer-id]').first()).toHaveAttribute('data-is-local', 'true');
  // Invitees still being rung are placeholder tiles after the people in the call (ui-components 2.436.0).
  if (ringing !== undefined) await expect(tiles(composer).locator('[data-ringing="true"]')).toHaveCount(ringing, { timeout: 45_000 });
  // Directly above the input: the composer's dock slot, then the editor card right under it.
  const order = await dock.evaluate(element => {
    const slot = element.closest('[data-testid$="-dock-slot"]');
    const input = slot?.nextElementSibling;
    if (!slot || !input) return null;
    return { slotBottom: slot.getBoundingClientRect().bottom, inputTop: input.getBoundingClientRect().top };
  });
  expect(order, 'the call block sits in the composer\'s dock slot').not.toBeNull();
  expect(order!.slotBottom).toBeLessThanOrEqual(order!.inputTop + 1);
  // The footer's compact status at the same time, without a second mic, camera or Leave/Cancel; no second video panel.
  await expect(page.getByTestId('shell-call-dock')).toBeVisible();
  for (const id of ['shell-call-dock-leave', 'shell-call-dock-mic', 'shell-call-dock-camera']) await expect(page.getByTestId(id)).toHaveCount(0);
  await expect(page.getByTestId('huddle-media-panel')).toHaveCount(0);
}

/** No tile is cut off at the row's right edge. */
async function expectRowFits(row: Locator) {
  const overflow = await row.evaluate(element => {
    const right = element.getBoundingClientRect().right;
    return [...element.children].map(child => child.getBoundingClientRect().right - right).filter(px => px > 1);
  });
  expect(overflow, 'tiles clipped at the row edge').toEqual([]);
}

async function leaveFromComposer(page: Page, composer: Locator, others: Page[]) {
  await composerDock(composer).getByTestId('call-dock-leave').click();
  for (const p of [page, ...others]) await expect(composerDock(p.locator('body'))).toHaveCount(0, { timeout: 20_000 });
}

test('Social DM: ringing, in-call and Leave above the "Message Farah Osei" composer', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-sana', 'social'), await signedIn(browser, 'u-farah', 'social')];
  const [sana, farah] = people.map(p => p.page) as [Page, Page];
  try {
    for (const page of [farah, sana]) await page.goto(`/social/dms/${encodeURIComponent(DM)}`);
    const composer = (page: Page) => page.getByTestId('social-chat-composer-dock');
    await expect(composer(sana)).toBeVisible({ timeout: 30_000 });
    await expect(composerDock(composer(sana))).toHaveCount(0);
    const start = sana.getByTestId('social-chat-panel-video-call').or(sana.getByTestId('social-chat-panel-call')).first();
    await expect(start).toBeEnabled({ timeout: 30_000 });
    await start.click();
    // Ringing: the caller's bar says who is rung, with their own tile.
    // Sana's own tile plus Farah's ringing placeholder.
    await expectComposerBar(sana, composer(sana), 'calling', 2, 'shelf', 1);
    await expect(tiles(composer(sana)).locator('[data-ringing="true"]')).toHaveAttribute('data-peer-id', 'u-farah');
    await expect(composerDock(composer(sana))).toContainText(/Calling Farah Osei/);
    await expect(sana.getByTestId('shell-call-dock')).toContainText(/Calling/);
    await sana.screenshot({ path: test.info().outputPath('dm-ringing.png') });

    await farah.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    for (const page of [sana, farah]) await expectComposerBar(page, composer(page), 'active', 2, 'shelf', 0);
    await sana.screenshot({ path: test.info().outputPath('dm-in-call.png') });

    await leaveFromComposer(sana, composer(sana), [farah]);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

test('Initiative: the composer in the content column carries the compact bar and tiles', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, process.env.INITIATIVE_CALLER ?? 'u-vera'), await signedIn(browser, process.env.INITIATIVE_CALLEE ?? 'u-nora')];
  const [caller, callee] = people.map(p => p.page) as [Page, Page];
  try {
    for (const page of [callee, caller]) await page.goto(`/iq/projects/${INITIATIVE}`);
    // The initiative's one composer, docked in the content column (its call block is the compact one).
    const pane = (page: Page) => page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await expect(huddleButton(caller)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(caller).click();
    // The caller's own tile plus the callee's ringing placeholder (more if the initiative rings others).
    await expect(tiles(pane(caller)).locator(`[data-peer-id="${process.env.INITIATIVE_CALLEE ?? 'u-nora'}"]`)).toHaveAttribute('data-ringing', 'true', { timeout: 30_000 });
    const invited = await tiles(pane(caller)).locator('[data-ringing="true"]').count();
    await expectComposerBar(caller, pane(caller), 'calling', 1 + invited, 'stack', invited);
    await expect(composerDock(pane(caller))).toHaveAttribute('data-compact', 'true');
    await callee.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    for (const page of [caller, callee]) await expectComposerBar(page, pane(page), 'active', 2, 'stack');
    await caller.screenshot({ path: test.info().outputPath('initiative-in-call.png') });
    await leaveFromComposer(caller, pane(caller), [callee]);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

test('Assessment team scorecard: the dimension composer carries the bar and tiles as people walk in', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-asha', 'assessment'), await signedIn(browser, 'u-jonas', 'assessment')];
  const [asha, jonas] = people.map(p => p.page) as [Page, Page];
  try {
    for (const page of [asha, jonas]) await page.goto(`/assessment/teams/${TEAM}`);
    const composer = (page: Page) => page.getByTestId('dimension-composer-block');
    await expect(huddleButton(asha)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(asha).click();
    await expectComposerBar(asha, composer(asha), 'active', 1, 'auto');
    await expect(huddleButton(jonas)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(jonas).click();
    for (const page of [asha, jonas]) await expectComposerBar(page, composer(page), 'active', 2, 'auto');
    await asha.screenshot({ path: test.info().outputPath('scorecard-in-call.png') });
    await composerDock(composer(jonas)).getByTestId('call-dock-leave').click();
    await expect(composerDock(composer(jonas))).toHaveCount(0, { timeout: 20_000 });
    await expectComposerBar(asha, composer(asha), 'active', 1, 'auto');
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

test('Pipelines run: the run Discussion composer carries the bar and tiles', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-kofi', 'pipelines'), await signedIn(browser, 'u-ines', 'pipelines')];
  const [kofi, ines] = people.map(p => p.page) as [Page, Page];
  try {
    const runs = await kofi.request.get('/api/pipelines/runs?limit=5');
    expect(runs.status()).toBe(200);
    const runId = ((await runs.json()).runs[0] as { id: string }).id;
    for (const page of [kofi, ines]) await page.goto(`/pipelines/runs/${encodeURIComponent(runId)}`);
    const composer = (page: Page) => page.getByTestId('pipeline-discussion');
    await expect(huddleButton(kofi)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(kofi).click();
    await expectComposerBar(kofi, composer(kofi), 'active', 1);
    await expect(huddleButton(ines)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(ines).click();
    for (const page of [kofi, ines]) await expectComposerBar(page, composer(page), 'active', 2);
    await kofi.screenshot({ path: test.info().outputPath('run-in-call.png') });
    await leaveFromComposer(ines, composer(ines), []);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

test('Assessment document: the page composer carries the bar and tiles', async ({ browser }) => {
  test.setTimeout(180_000);
  const DOC_URL = `/assessment/workspace?doc=${encodeURIComponent(process.env.HUDDLE_DOC ?? 'page:100002')}`;
  const people = [await signedIn(browser, 'u-asha', 'assessment'), await signedIn(browser, 'u-jonas', 'assessment')];
  const [asha, jonas] = people.map(p => p.page) as [Page, Page];
  try {
    for (const page of [asha, jonas]) await page.goto(DOC_URL);
    const composer = (page: Page) => page.getByTestId('page-composer-dock');
    await expect(composer(asha)).toBeVisible({ timeout: 30_000 });
    await expect(huddleButton(asha)).toBeEnabled({ timeout: 30_000 });
    await huddleButton(asha).click();
    // With Jonas on the page the document rings him (useDocumentCall); without, it opens alone.
    const accept = jonas.getByRole('button', { name: 'Accept', exact: true });
    if (await accept.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await expectComposerBar(asha, composer(asha), 'calling', 1);
      await accept.click();
    } else {
      await expect(huddleButton(jonas)).toBeEnabled({ timeout: 30_000 });
      await huddleButton(jonas).click();
    }
    for (const page of [asha, jonas]) await expectComposerBar(page, composer(page), 'active', 2);
    // The bar names the document (chips show from a 1240px-wide bar; the name is in the DOM either way).
    await expect(composerDock(composer(asha)).locator('[data-testid^="call-dock-document-"]')).toHaveCount(1);
    await asha.screenshot({ path: test.info().outputPath('document-in-call.png') });
    await leaveFromComposer(asha, composer(asha), []);
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

// The user's second report (/iq/projects/p-observability, Overview): "I've
// joined a call but do not see anything" while the footer read "Calling … ·
// 1 joined · 3 ringing". The self tile must show within 2 s of Huddle, before
// anyone answers: above the Discussion composer while the right pane is open,
// and in the content column's call block once the pane is collapsed.
test('Initiative Overview: the self tile shows within 2 s of Huddle, pane open and pane closed', async ({ browser }) => {
  test.setTimeout(120_000);
  const people = [await signedIn(browser, 'u-rachel')];
  const [rachel] = people.map(p => p.page) as [Page];
  try {
    await rachel.goto('/iq/projects/p-observability');
    // The page's one composer is docked in the content column (2.438.3): the call rides above it,
    // whether the Discussion pane is open or collapsed.
    const composer = rachel.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await expect(rachel.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 30_000 });
    await expect(huddleButton(rachel)).toBeEnabled({ timeout: 30_000 });
    const started = Date.now();
    await huddleButton(rachel).click();
    const selfTile = (scope: Locator) => scope.getByTestId('call-dock-tile-row').locator('[data-is-local="true"]');
    await expect(selfTile(composerDock(composer))).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_500);
    await expect(composerDock(composer).locator('[data-phase]').first()).toHaveAttribute('data-phase', 'calling');
    await expect(rachel.getByTestId('shell-call-dock')).toContainText(/Calling/);
    await rachel.screenshot({ path: test.info().outputPath('overview-ringing-pane-open.png') });

    // Collapse the pane: the composer keeps the call, still showing the self tile.
    await rachel.getByTestId('page-conversation-pane').getByRole('button', { name: /^Collapse/ }).click();
    const block = composerDock(composer);
    await expect(block).toHaveAttribute('data-holds-media', 'true', { timeout: 2_000 });
    await expect(selfTile(block)).toBeVisible({ timeout: 2_000 });
    await expect(block.getByTestId('call-dock-leave')).toBeVisible();
    await rachel.screenshot({ path: test.info().outputPath('overview-ringing-pane-closed.png') });

    // Started with the pane closed: the composer shows the self tile within 2 s too.
    await block.getByTestId('call-dock-leave').click();
    await expect(rachel.getByTestId('shell-call-media')).toHaveCount(0, { timeout: 20_000 });
    await expect(huddleButton(rachel)).toBeEnabled({ timeout: 30_000 });
    const again = Date.now();
    await huddleButton(rachel).click();
    await expect(selfTile(composerDock(composer))).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - again).toBeLessThan(2_500);
    await composerDock(composer).getByTestId('call-dock-leave').click();
    await expect(composerDock(composer)).toHaveCount(0, { timeout: 20_000 });
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});

// The same report with the person being rung on the page too (u-rachel calls,
// u-nora answers): from the first ring Rachel sees her own tile and the
// invitees as ringing placeholders above the content column's composer —
// pane open or collapsed — next to the footer's compact status; Nora's Accept
// turns her placeholder into her tile; Leave removes the block.
test('Initiative Overview: ringing placeholders, then both tiles after Accept, with the pane closed', async ({ browser }) => {
  test.setTimeout(180_000);
  const people = [await signedIn(browser, 'u-rachel'), await signedIn(browser, 'u-nora')];
  const [rachel, nora] = people.map(p => p.page) as [Page, Page];
  try {
    for (const page of [nora, rachel]) await page.goto('/iq/projects/p-observability');
    const discussion = rachel.getByTestId('initiative-workspace').getByTestId('initiative-composer');
    await expect(rachel.getByTestId('initiative-live-discussion')).toBeVisible({ timeout: 30_000 });
    await expect(huddleButton(rachel)).toBeEnabled({ timeout: 30_000 });
    const started = Date.now();
    await huddleButton(rachel).click();
    const row = (scope: Locator) => scope.getByTestId('call-dock-tile-row');
    await expect(row(composerDock(discussion)).locator('[data-is-local="true"]')).toBeVisible({ timeout: 2_000 });
    expect(Date.now() - started).toBeLessThan(2_500);
    // The invitees ring as placeholder tiles, while the footer keeps its compact "Calling … · N ringing" status.
    await expect(row(composerDock(discussion)).locator('[data-ringing="true"]').first()).toBeVisible({ timeout: 10_000 });
    const rung = await row(composerDock(discussion)).locator('[data-ringing="true"]').count();
    await expect(rachel.getByTestId('shell-call-dock')).toContainText(/Calling/);
    await expect(rachel.getByTestId('shell-call-dock')).toContainText(new RegExp(`${rung} ringing`));
    await rachel.screenshot({ path: test.info().outputPath('overview-two-ringing-pane-open.png') });

    // Pane collapsed: the composer's block carries the same tiles.
    await rachel.getByTestId('page-conversation-pane').getByRole('button', { name: /^Collapse/ }).click();
    const block = composerDock(discussion);
    await expect(block).toHaveAttribute('data-holds-media', 'true', { timeout: 2_000 });
    await expect(row(block).locator('[data-is-local="true"]')).toBeVisible({ timeout: 2_000 });
    // Every invitee is a tile (the row folds what does not fit its width into +N, never clipping one at the edge).
    await expect(row(block)).toHaveAttribute('data-tile-count', String(1 + rung));
    await expectRowFits(row(block));
    await expect(rachel.getByTestId('shell-call-dock')).toBeVisible();

    // Nora answers: her placeholder becomes her tile on Rachel's side.
    await nora.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
    const join = nora.getByTestId('prejoin-join');
    if (await join.isVisible({ timeout: 3_000 }).catch(() => false)) await join.click();
    await expect(row(block).locator('[data-peer-id="u-nora"]')).toBeVisible({ timeout: 45_000 });
    await expect(row(block).locator('[data-peer-id="u-nora"]')).not.toHaveAttribute('data-ringing', 'true', { timeout: 45_000 });
    await expect(block.locator('[data-phase]').first()).toHaveAttribute('data-phase', 'active', { timeout: 45_000 });
    await expect(row(block)).toHaveAttribute('data-tile-count', String(1 + rung));
    await expectRowFits(row(block));
    await expect(rachel.getByTestId('shell-call-dock')).toBeVisible();
    await rachel.screenshot({ path: test.info().outputPath('overview-two-in-call-pane-closed.png') });

    await block.getByTestId('call-dock-leave').click();
    await expect(block).toHaveCount(0, { timeout: 20_000 });
    await expect(rachel.getByTestId('shell-call-media')).toHaveCount(0, { timeout: 20_000 });
    for (const person of people) expect(person.errors).toEqual([]);
  } finally { await close(people); }
});
