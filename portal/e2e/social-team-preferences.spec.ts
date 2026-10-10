import { test, expect, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { signIn } from './realSession';
import type { SocialTeam } from '../src/pages/social/socialPlatform.ts';

// Acceptance preparation for personal team preferences. Identity, team reads,
// membership setup, successful favorites and Leave use the ordinary offline
// APIs. Only the named failure/malformed/delayed transport paths are doubled.
// The mock world is never reset: prior personal flags and memberships are
// restored through their normal APIs when each isolated browser case ends.
// Discovery is not acceptance; these cases require an authorized local stack.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const COMMUNITY = 'mock-team-community';
const MODERATION = 'mock-team-moderation';
const SANA = 'u-sana';
const MIRA = 'u-mira';
const TREE = 'social-team-tree';
const PREFERENCE_UNAVAILABLE = 'Your personal team preference could not be saved. Try again.';
const preferencePath = (teamId: string) => `/api/social/teams/${encodeURIComponent(teamId)}/me`;
const memberPath = (teamId: string, userId: string) => `/api/social/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`;
const row = (page: Page, teamId: string) => page.getByTestId(`${TREE}-team-${teamId}`);
const marker = (page: Page, teamId: string) => page.getByTestId(`${TREE}-team-${teamId}-pinned`);
const pinItem = (page: Page, teamId: string) => page.getByTestId(`${TREE}-team-${teamId}-menu-pin`);
const preferenceError = (page: Page) => page.getByTestId('social-team-preference-error');
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
type Person = { context: BrowserContext; page: Page; errors: string[] };
type FavoriteWrite = { teamId: string; favorite: boolean; body: unknown };

async function person(browser: Browser, baseURL: string | undefined, userId: string): Promise<Person> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/');
    await signIn(page, userId, { expectTenant: 'social', ...(userId === SANA ? { expectRole: 'participant' } : {}) });
    await page.goto('/social/teams');
    await expect(page.getByTestId(TREE)).toBeVisible({ timeout: 20_000 });
    await expect(row(page, COMMUNITY)).toBeVisible();
    return { context, page, errors };
  } catch (error) { await context.close(); throw error; }
}

async function teams(page: Page): Promise<SocialTeam[]> {
  const response = await page.request.get('/api/social/teams');
  expect(response.status(), 'normal member-scoped team list').toBe(200);
  return ((await response.json()) as { teams: SocialTeam[] }).teams;
}
async function favorite(page: Page, teamId: string, value: boolean) {
  const response = await page.request.patch(preferencePath(teamId), { data: { favorite: value } });
  expect(response.status(), `store personal preference for ${teamId}`).toBe(200);
  const body = await response.json() as { member: { teamId: string; userId: string; favorite: boolean } };
  expect(body.member).toMatchObject({ teamId, userId: SANA, favorite: value });
  return body.member;
}
async function teamOrder(page: Page): Promise<string[]> {
  return page.getByTestId(TREE).locator('[role="treeitem"][aria-level="1"]').evaluateAll(elements =>
    elements.map(element => (element as HTMLElement).dataset.rowId!.slice('team:'.length)));
}
async function menu(page: Page, teamId: string, keyboard = false) {
  await row(page, teamId).focus();
  const trigger = page.getByTestId(`${TREE}-team-${teamId}-menu`);
  if (keyboard) { await trigger.focus(); await page.keyboard.press('Enter'); }
  else await trigger.click();
  await expect(page.getByTestId(`${TREE}-team-${teamId}-menu-panel`)).toBeVisible();
}
async function toggle(page: Page, teamId: string, current: boolean, keyboard = false) {
  await menu(page, teamId, keyboard);
  const item = pinItem(page, teamId);
  await expect(item).toHaveText(current ? 'Unpin' : 'Pin');
  if (keyboard) { await item.focus(); await page.keyboard.press('Enter'); }
  else await item.click();
}
async function navigateTeam(page: Page, teamId: string) {
  await menu(page, teamId);
  await page.getByTestId(`${TREE}-team-${teamId}-menu-manage`).click();
  await expect(page).toHaveURL(url => url.pathname === '/social/teams' && url.searchParams.get('team') === teamId);
}
async function spyPreferences(context: BrowserContext, writes: FavoriteWrite[], handler?: (route: Route, teamId: string) => Promise<void>) {
  await context.route(url => /^\/api\/social\/teams\/[^/]+\/me$/.test(url.pathname), async route => {
    expect(route.request().method()).toBe('PATCH');
    const teamId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4]!);
    const body = route.request().postDataJSON() as { favorite: boolean };
    expect(Object.keys(body)).toEqual(['favorite']);
    expect(typeof body.favorite).toBe('boolean');
    writes.push({ teamId, favorite: body.favorite, body });
    if (handler) await handler(route, teamId); else await route.continue();
  });
}

// Add Sana to the existing second team through its real owner's route. Preserve
// any prior membership/favorite; this does not invent a fixture team or actor.
async function pair(browser: Browser, baseURL: string | undefined) {
  const owner = await person(browser, baseURL, 'u-lena');
  let sana: Person | undefined; let added = false; const prior = new Map<string, boolean>();
  try {
    const detail = await owner.page.request.get(`/api/social/teams/${MODERATION}`);
    expect(detail.status()).toBe(200);
    const members = ((await detail.json()) as { members: Array<{ userId: string }> }).members;
    if (!members.some(member => member.userId === SANA)) {
      expect((await owner.page.request.post(`/api/social/teams/${MODERATION}/members`, { data: { userId: SANA } })).status()).toBe(201);
      added = true;
    }
    sana = await person(browser, baseURL, SANA);
    for (const team of await teams(sana.page)) if (team.teamId === COMMUNITY || team.teamId === MODERATION) prior.set(team.teamId, team.favorite);
    expect(prior.has(COMMUNITY)).toBe(true); expect(prior.has(MODERATION)).toBe(true);
    await favorite(sana.page, COMMUNITY, false); await favorite(sana.page, MODERATION, false);
    await sana.page.reload();
    await expect(row(sana.page, COMMUNITY)).toBeVisible(); await expect(row(sana.page, MODERATION)).toBeVisible();
    const current = sana;
    return { owner, sana: current, cleanup: async () => {
      try {
        // Identity-race cases can log a different member into this cookie jar.
        await signIn(current.page, SANA, { expectTenant: 'social', expectRole: 'participant' });
        const mine = await teams(current.page);
        for (const [id, value] of prior) if (mine.some(team => team.teamId === id)) await favorite(current.page, id, value);
        if (added) expect((await owner.page.request.delete(memberPath(MODERATION, SANA))).status()).toBe(204);
      } finally { await current.context.close(); await owner.context.close(); }
    } };
  } catch (error) {
    try { if (added) await owner.page.request.delete(memberPath(MODERATION, SANA)); }
    finally { await sana?.context.close(); await owner.context.close(); }
    throw error;
  }
}

test('a participant pins and unpins through the native menu, changing only their order and surviving reload', async ({ browser, baseURL }, testInfo) => {
  const people = await pair(browser, baseURL); const mira = await person(browser, baseURL, MIRA); const writes: FavoriteWrite[] = [];
  try {
    const before = await teamOrder(people.sana.page); expect(before).toContain(COMMUNITY); expect(before).toContain(MODERATION);
    const target = before[before.length - 1]!;
    const miraBefore = await teams(mira.page); const miraOrder = await teamOrder(mira.page);
    await spyPreferences(people.sana.context, writes);
    await toggle(people.sana.page, target, false);
    await expect(marker(people.sana.page, target)).toBeVisible();
    await expect.poll(() => teamOrder(people.sana.page)).toEqual([target, ...before.filter(id => id !== target)]);
    expect((await teams(people.sana.page)).find(team => team.teamId === target)?.favorite).toBe(true);
    await people.sana.page.reload();
    await expect(marker(people.sana.page, target)).toBeVisible();
    await expect.poll(() => teamOrder(people.sana.page)).toEqual([target, ...before.filter(id => id !== target)]);
    await mira.page.reload();
    expect(await teams(mira.page)).toEqual(miraBefore); expect(await teamOrder(mira.page)).toEqual(miraOrder);
    await people.sana.page.screenshot({ path: testInfo.outputPath('participant-personal-team-pin.png'), fullPage: true });
    await toggle(people.sana.page, target, true);
    await expect(marker(people.sana.page, target)).toHaveCount(0);
    await expect.poll(() => teamOrder(people.sana.page)).toEqual(before);
    await people.sana.page.reload();
    await expect(marker(people.sana.page, target)).toHaveCount(0);
    expect((await teams(people.sana.page)).find(team => team.teamId === target)?.favorite).toBe(false);
    expect(writes).toEqual([{ teamId: target, favorite: true, body: { favorite: true } }, { teamId: target, favorite: false, body: { favorite: false } }]);
    expect(people.sana.errors).toEqual([]); expect(mira.errors).toEqual([]);
  } finally { await mira.context.close(); await people.cleanup(); }
});

test('a participant can open the native team menu and pin with the keyboard', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = [];
  try {
    await spyPreferences(people.sana.context, writes);
    // Intentionally unskipped: installed TeamChannelTree currently handles
    // Enter on its nested menu trigger as a team-row expansion. This case
    // independently exposes that upstream keyboard defect when executed.
    await toggle(people.sana.page, COMMUNITY, false, true);
    await expect(marker(people.sana.page, COMMUNITY)).toBeVisible();
    expect((await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)?.favorite).toBe(true);
    expect(writes).toEqual([{ teamId: COMMUNITY, favorite: true, body: { favorite: true } }]);
    expect(people.sana.errors).toEqual([]);
  } finally { await people.cleanup(); }
});

for (const initial of [false, true]) {
  test(`a failed ${initial ? 'Unpin' : 'Pin'} preserves the previous personal preference and its explanation`, async ({ browser, baseURL }, testInfo) => {
    const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = [];
    try {
      await favorite(people.sana.page, COMMUNITY, initial); await people.sana.page.reload();
      const before = await teamOrder(people.sana.page);
      await spyPreferences(people.sana.context, writes, route => json(route, 503, { error: PREFERENCE_UNAVAILABLE }));
      await toggle(people.sana.page, COMMUNITY, initial);
      await expect(preferenceError(people.sana.page)).toContainText(PREFERENCE_UNAVAILABLE);
      await expect(marker(people.sana.page, COMMUNITY)).toHaveCount(initial ? 1 : 0);
      expect(await teamOrder(people.sana.page)).toEqual(before);
      expect((await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)?.favorite).toBe(initial);
      await menu(people.sana.page, COMMUNITY); await expect(pinItem(people.sana.page, COMMUNITY)).toHaveText(initial ? 'Unpin' : 'Pin');
      await people.sana.page.keyboard.press('Escape');
      await people.sana.page.screenshot({ path: testInfo.outputPath(`team-${initial ? 'unpin' : 'pin'}-failure.png`), fullPage: true });
      await people.sana.page.reload(); await expect(marker(people.sana.page, COMMUNITY)).toHaveCount(initial ? 1 : 0);
      expect(writes).toHaveLength(1); expect(people.sana.errors).toEqual([]);
    } finally { await people.cleanup(); }
  });
}

for (const mismatch of ['team', 'identity'] as const) {
  test(`a successful response naming another ${mismatch} cannot pin either team`, async ({ browser, baseURL }) => {
    const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = [];
    try {
      const before = await teamOrder(people.sana.page);
      await spyPreferences(people.sana.context, writes, route => json(route, 200, { member: {
        teamId: mismatch === 'team' ? MODERATION : COMMUNITY, userId: mismatch === 'identity' ? MIRA : SANA,
        role: 'member', favorite: true, addedAt: '2026-10-03T12:00:00.000Z', addedBy: MIRA,
      } }));
      await toggle(people.sana.page, COMMUNITY, false);
      await expect(preferenceError(people.sana.page)).toBeVisible();
      await expect(marker(people.sana.page, COMMUNITY)).toHaveCount(0); await expect(marker(people.sana.page, MODERATION)).toHaveCount(0);
      expect(await teamOrder(people.sana.page)).toEqual(before);
      expect((await teams(people.sana.page)).filter(team => team.favorite)).toEqual([]);
      expect(writes).toHaveLength(1); expect(people.sana.errors).toEqual([]);
    } finally { await people.cleanup(); }
  });
}

test('a late preference failure cannot attach its explanation to a different team pane', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = [];
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let completed = false;
  try {
    await navigateTeam(people.sana.page, COMMUNITY);
    await spyPreferences(people.sana.context, writes, async route => {
      await held; await json(route, 503, { error: PREFERENCE_UNAVAILABLE }); completed = true;
    });
    await toggle(people.sana.page, COMMUNITY, false); await expect.poll(() => writes.length).toBe(1);
    await navigateTeam(people.sana.page, MODERATION);
    release(); await expect.poll(() => completed).toBe(true);
    await expect(preferenceError(people.sana.page)).toHaveCount(0);
    await expect(people.sana.page).toHaveURL(url => url.searchParams.get('team') === MODERATION);
    await expect(marker(people.sana.page, COMMUNITY)).toHaveCount(0); await expect(marker(people.sana.page, MODERATION)).toHaveCount(0);
    expect(people.sana.errors).toEqual([]);
  } finally { release(); await people.cleanup(); }
});

test('a delayed successful pin stays scoped to its original team and does not navigate the new pane', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = [];
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let completed = false;
  try {
    await navigateTeam(people.sana.page, COMMUNITY);
    await spyPreferences(people.sana.context, writes, async route => {
      // The real middleware stores the caller preference before only its
      // response delivery is delayed. No successful mutation is fabricated.
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await held; await route.fulfill({ response }); completed = true;
    });
    await toggle(people.sana.page, COMMUNITY, false); await expect.poll(() => writes.length).toBe(1);
    await navigateTeam(people.sana.page, MODERATION);
    release(); await expect.poll(() => completed).toBe(true);
    await expect(people.sana.page).toHaveURL(url => url.searchParams.get('team') === MODERATION);
    await expect(marker(people.sana.page, MODERATION)).toHaveCount(0);
    expect((await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)?.favorite).toBe(true);
    await people.sana.page.reload(); await expect(marker(people.sana.page, COMMUNITY)).toBeVisible();
    await expect(marker(people.sana.page, MODERATION)).toHaveCount(0);
    expect(people.sana.errors).toEqual([]);
  } finally { release(); await people.cleanup(); }
});

test('a delayed preference response cannot carry Sana’s flag into a different signed-in identity', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL); const mira = await person(browser, baseURL, MIRA); const writes: FavoriteWrite[] = [];
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let completed = false;
  try {
    const miraBefore = await teams(mira.page);
    await spyPreferences(people.sana.context, writes, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200);
      await held;
      try { await route.fulfill({ response }); } catch { /* The real identity boundary hard-remounts and cancels this response. */ }
      completed = true;
    });
    await toggle(people.sana.page, COMMUNITY, false); await expect.poll(() => writes.length).toBe(1);
    await signIn(people.sana.page, MIRA);
    await people.sana.page.goto('/social/teams');
    await expect(row(people.sana.page, COMMUNITY)).toBeVisible();
    release(); await expect.poll(() => completed).toBe(true);
    const session = await (await people.sana.page.request.get('/api/session/me')).json(); expect(session.sub).toBe(MIRA);
    expect(await teams(people.sana.page)).toEqual(miraBefore);
    await expect(marker(people.sana.page, COMMUNITY)).toHaveCount(miraBefore.find(team => team.teamId === COMMUNITY)!.favorite ? 1 : 0);
    await expect(preferenceError(people.sana.page)).toHaveCount(0);
    expect(people.sana.errors).toEqual([]);
  } finally { release(); await mira.context.close(); await people.cleanup(); }
});

test('an older team-list response cannot undo a successfully saved personal pin', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL);
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let captured = false; let completed = false;
  try {
    // Explicitly simulate a read transport that ignores cancellation, so the
    // request-generation guard must reject the old response after the write.
    // All other endpoints keep their native fetch behavior.
    await people.sana.page.evaluate(() => {
      // Headless tabs can report hidden. This single deterministic poll test
      // explicitly enters the visible branch before dispatching its event.
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.href, location.href);
        return nativeFetch(input, url.pathname === '/api/social/teams' && (!init?.method || init.method === 'GET')
          ? { ...init, signal: undefined } : init);
      };
    });
    await people.sana.context.route(url => url.pathname === '/api/social/teams', async route => {
      if (route.request().method() !== 'GET' || captured) { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(200);
      const old = await response.json() as { teams: SocialTeam[] };
      expect(old.teams.find(team => team.teamId === COMMUNITY)?.favorite).toBe(false);
      captured = true; await held; await route.fulfill({ response }); completed = true;
    });
    await people.sana.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => captured).toBe(true);
    await toggle(people.sana.page, COMMUNITY, false);
    await expect(marker(people.sana.page, COMMUNITY)).toBeVisible();
    release(); await expect.poll(() => completed).toBe(true);
    await people.sana.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(marker(people.sana.page, COMMUNITY)).toBeVisible();
    expect((await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)?.favorite).toBe(true);
    await expect(preferenceError(people.sana.page)).toHaveCount(0);
    expect(people.sana.errors).toEqual([]);
  } finally { release(); await people.cleanup(); }
});

test('a pending pin prevents a duplicate pin and Leave on that same team from racing its membership', async ({ browser, baseURL }) => {
  const people = await pair(browser, baseURL); const writes: FavoriteWrite[] = []; let deletes = 0;
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; }); let completed = false;
  people.sana.context.on('request', request => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === memberPath(COMMUNITY, SANA)) deletes += 1;
  });
  try {
    await spyPreferences(people.sana.context, writes, async route => {
      try {
        await held; const response = await route.fetch(); expect(response.status()).toBe(200); await route.fulfill({ response });
      } finally { completed = true; }
    });
    await toggle(people.sana.page, COMMUNITY, false); await expect.poll(() => writes.length).toBe(1);
    await toggle(people.sana.page, COMMUNITY, false);
    await menu(people.sana.page, COMMUNITY);
    await people.sana.page.getByTestId(`${TREE}-team-${COMMUNITY}-menu-leave`).click();
    await people.sana.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(writes).toHaveLength(1); expect(deletes).toBe(0);
    await expect(row(people.sana.page, COMMUNITY)).toBeVisible();
    expect((await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)?.favorite).toBe(false);
    release(); await expect.poll(() => completed).toBe(true);
    await expect(marker(people.sana.page, COMMUNITY)).toBeVisible();
    expect(writes).toHaveLength(1); expect(deletes).toBe(0);
    expect(people.sana.errors).toEqual([]);
  } finally {
    release();
    try { if (writes.length) await expect.poll(() => completed).toBe(true); }
    finally { await people.cleanup(); }
  }
});

test('a participant can Leave their team through its menu while removing another member remains forbidden', async ({ browser, baseURL }, testInfo) => {
  const people = await pair(browser, baseURL); const mira = await person(browser, baseURL, MIRA); let left = false;
  try {
    const before = await (await mira.page.request.get(`/api/social/teams/${COMMUNITY}`)).json() as { members: Array<{ userId: string }> };
    expect((await people.sana.page.request.delete(memberPath(COMMUNITY, 'u-lena'))).status()).toBe(403);
    const afterRefusal = await (await mira.page.request.get(`/api/social/teams/${COMMUNITY}`)).json() as { members: Array<{ userId: string }> };
    expect(afterRefusal.members).toEqual(before.members);
    expect((await people.sana.page.request.patch(preferencePath(COMMUNITY), { data: { favorite: true, userId: MIRA } })).status()).toBe(400);
    await favorite(people.sana.page, COMMUNITY, true); await people.sana.page.reload();
    const community = (await teams(people.sana.page)).find(team => team.teamId === COMMUNITY)!;
    const general = community.channels.find(channel => channel.name === 'General')!;
    expect(general, 'the genuine team response supplies its General channel').toBeDefined();
    const communityChannel = `social:team:${community.slug}:${general.slug}`;
    await people.sana.page.getByTestId(`${TREE}-channel-${communityChannel}`).click();
    await expect(people.sana.page).toHaveURL(url => url.searchParams.get('channel') === communityChannel);
    await menu(people.sana.page, COMMUNITY);
    const deleted = people.sana.page.waitForResponse(response => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === memberPath(COMMUNITY, SANA));
    await people.sana.page.getByTestId(`${TREE}-team-${COMMUNITY}-menu-leave`).click();
    expect((await deleted).status()).toBe(204); left = true;
    await expect(row(people.sana.page, COMMUNITY)).toHaveCount(0);
    await expect(people.sana.page).toHaveURL(url => url.pathname === '/social/teams' && !url.searchParams.has('channel') && !url.searchParams.has('team'));
    expect((await teams(people.sana.page)).some(team => team.teamId === COMMUNITY)).toBe(false);
    expect((await people.sana.page.request.patch(preferencePath(COMMUNITY), { data: { favorite: true } })).status()).toBe(403);
    const remaining = await (await mira.page.request.get(`/api/social/teams/${COMMUNITY}`)).json() as { members: Array<{ userId: string }> };
    expect(remaining.members.map(member => member.userId).sort()).toEqual(before.members.map(member => member.userId).filter(id => id !== SANA).sort());
    await people.sana.page.reload(); await expect(row(people.sana.page, COMMUNITY)).toHaveCount(0);
    await people.sana.page.screenshot({ path: testInfo.outputPath('participant-team-leave.png'), fullPage: true });
    expect(people.sana.errors).toEqual([]);
  } finally {
    try { if (left) expect((await mira.page.request.post(`/api/social/teams/${COMMUNITY}/members`, { data: { userId: SANA } })).status()).toBe(201); }
    finally { await mira.context.close(); await people.cleanup(); }
  }
});
