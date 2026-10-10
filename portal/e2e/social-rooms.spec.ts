import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs, signIn } from './realSession';

// The S2 walk (docs/social-tenant-goal.md phase S2; docs/social-tenant-design.md
// §4.2, §4.4, §4.5): rooms and recordings on the social tenant, one browser
// context per user, against the shared stack (PARITY_BASE_URL when not :5183).
//
//   1. u-mira (or, once platform-api's hourly create limit is spent for her,
//      the next ManageChannels holder) creates a room over REST — straight to platform-api with the
//      realtime token the BFF mints her (the `social` compose profile), or to
//      the BFF's own POST /api/social/rooms under plain dev:mock — and u-sana,
//      in her own browser, sees it on /social/rooms: the 404 the social-calls
//      plan warned about at step 7 (a room made outside the page, in the
//      tenant's partition, invisible to it) does not happen.
//   2. u-sana opens that room and joins its call: the lobby is
//      `social:room:<slug>` and the shell's call dock comes up.
//   3. u-mira's PRIVATE room is invisible to u-sana: not in her list, "not
//      available" on a deep link, and platform-api itself answers her 403
//      (62f9913: a private room admits its creator and members only).
//   4. The recordings list renders for a social session and the BFF refuses
//      an orgiq session with 403.
//
// Live rooms are archived afterwards (platform-api has no reset); the mock
// world is reset first and last.

test.use({
  viewport: { width: 1440, height: 900 },
  ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}),
  // The room call needs a camera and a microphone.
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['camera', 'microphone'],
});
test.describe.configure({ mode: 'serial' });

type Person = { context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[] };
type Token = { token: string; platformApiUrl?: string };

async function person(browser: Browser, baseURL: string | undefined, userId: string, path = '/'): Promise<Person> {
  const { context, page, errors } = await openAs(browser, userId, {
    baseURL, viewport: { width: 1440, height: 900 }, contextOptions: { permissions: ['camera', 'microphone'] },
    expectTenant: 'social', ...(path !== '/' ? { url: path } : {}),
  });
  return { context, page, errors };
}

const token = (page: Page): Promise<Token> => page.evaluate(async () => (await fetch('/api/session/realtime-token', { credentials: 'include' })).json());

/**
 * People who may open a room (ManageChannels). platform-api caps room
 * creation at 5 per rolling hour per user, in its own memory
 * (ROOM_CREATE_RATE_LIMIT_MAX), so a run that finds one creator spent tries
 * the next rather than failing on a quota it cannot reset.
 */
const CREATORS = ['u-mira', 'u-lena', 'u-operator'];

/** POST a room the way a script would: platform-api with the realtime token, else the BFF. */
async function createRoomOverRest(browser: Browser, baseURL: string | undefined, body: { name: string; visibility?: 'org' | 'private' }): Promise<{ slug: string; live: boolean; creator: string }> {
  for (const creator of CREATORS) {
    const p = await person(browser, baseURL, creator);
    const t = await token(p.page);
    const res = t.platformApiUrl
      ? await p.page.request.post(`${t.platformApiUrl}/api/rooms`, { headers: { Authorization: `Bearer ${t.token}` }, data: { ...body, tenant: 'social' } })
      : await p.page.request.post('/api/social/rooms', { data: body });
    const status = res.status();
    const json = status === 201 ? await res.json() : null;
    await p.context.close();
    if (status === 429) continue;
    expect(status, `${t.platformApiUrl ? 'platform-api POST /api/rooms' : 'BFF POST /api/social/rooms'} as ${creator}`).toBe(201);
    return { slug: json.room.slug, live: !!t.platformApiUrl, creator };
  }
  throw new Error(`every creator (${CREATORS.join(', ')}) has spent platform-api's hourly room-create limit`);
}

const created: Array<{ slug: string; creator: string }> = [];

async function resetWorld(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/');
  const reset = await page.evaluate(async () => (await fetch('/api/__mock/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  expect(reset, 'mock reset').toBe(200);
  await context.close();
}

test.beforeAll(async ({ browser, baseURL }) => { await resetWorld(browser, baseURL); });
test.afterAll(async ({ browser, baseURL }) => {
  // Archive what this run made in platform-api (archive is the owner's).
  for (const { slug, creator } of created) {
    const owner = await person(browser, baseURL, creator);
    const t = await token(owner.page);
    if (t.platformApiUrl) await owner.page.request.post(`${t.platformApiUrl}/api/rooms/${slug}/archive`, { headers: { Authorization: `Bearer ${t.token}` } });
    await owner.context.close();
  }
  await resetWorld(browser, baseURL);
});

const roomRow = (page: Page, name: string) => page.getByTestId('social-rooms-list').getByRole('button', { name: `${name} room` });

let openRoom: { slug: string; name: string } | null = null;

test('a room created via REST is visible to a browser user in the tenant', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const name = `Standup ${Date.now()}`;
  const { slug, live, creator } = await createRoomOverRest(browser, baseURL, { name });
  if (live) created.push({ slug, creator });
  openRoom = { slug, name };

  const sana = await person(browser, baseURL, 'u-sana', '/social/rooms');
  await expect(sana.page.getByTestId('social-rooms-page')).toBeVisible({ timeout: 20_000 });
  await expect(roomRow(sana.page, name)).toBeVisible({ timeout: 10_000 });
  // Through the BFF too, in the tenant's partition, with its lobby.
  const listed = await sana.page.evaluate(async () => (await fetch('/api/social/rooms', { credentials: 'include' })).json());
  expect(listed.rooms.find((r: { slug: string }) => r.slug === slug)).toMatchObject({ orgId: 'social', lobbyName: `social:room:${slug}` });

  expect(sana.errors, 'page errors').toEqual([]);
  await sana.context.close();
});

test('u-sana joins the room\'s call on its social:room lobby', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  test.skip(!openRoom, 'the first test made no room');
  const sana = await person(browser, baseURL, 'u-sana', `/social/rooms?room=${openRoom!.slug}`);
  const t = await token(sana.page);
  test.skip(!t.platformApiUrl, 'no platform-api (plain dev:mock): a call needs the `social` compose profile');
  const detail = sana.page.getByTestId('social-room-detail');
  await expect(detail).toBeVisible({ timeout: 20_000 });
  await expect(detail.getByTestId('social-room-facts')).toContainText(`social:room:${openRoom!.slug}`);
  const join = detail.getByTestId('social-room-join');
  await expect(join).toBeEnabled({ timeout: 20_000 }); // enabled once the gateway is connected
  await join.click();
  await expect(sana.page.getByTestId('social-call-dock')).toBeVisible({ timeout: 20_000 });
  // Live: the SFU connected and the dock counts her in.
  await expect(sana.page.getByTestId('social-call-dock')).toContainText(/1 person/, { timeout: 30_000 });
  // platform-api opened (or reused) a session on exactly this lobby.
  const session = await sana.page.request.get(`${t.platformApiUrl}/api/video/sessions/by-lobby/${encodeURIComponent(`social:room:${openRoom!.slug}`)}`, {
    headers: { Authorization: `Bearer ${t.token}` },
  });
  expect(session.status()).toBe(200);
  await detail.getByTestId('social-room-leave').click();
  // The walk-in reached her call log (SocialLayout reports it; /social/calls reads it).
  await expect.poll(async () => {
    const log = await sana.page.evaluate(async () => (await fetch('/api/social/calls', { credentials: 'include' })).json());
    return log.calls.some((c: { lobbyName: string; direction: string }) => c.lobbyName === `social:room:${openRoom!.slug}` && c.direction === 'joined');
  }, { timeout: 10_000 }).toBe(true);
  await sana.page.goto('/social/calls');
  await expect(sana.page.getByTestId('social-call-log')).toContainText(openRoom!.name);
  expect(sana.errors, 'page errors').toEqual([]);
  await sana.context.close();
});

test('a private room is invisible to a non-member', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const name = `Moderators only ${Date.now()}`;
  const { slug, live, creator } = await createRoomOverRest(browser, baseURL, { name, visibility: 'private' });
  if (live) created.push({ slug, creator });

  // Its creator sees it.
  const owner = await person(browser, baseURL, creator, '/social/rooms');
  await expect(roomRow(owner.page, name)).toBeVisible({ timeout: 20_000 });

  // u-sana does not: not listed, and a deep link says it is not available.
  const sana = await person(browser, baseURL, 'u-sana', '/social/rooms');
  await expect(sana.page.getByTestId('social-rooms-page')).toBeVisible({ timeout: 20_000 });
  await expect(sana.page.getByTestId('social-rooms-list')).toBeVisible();
  await expect(roomRow(sana.page, name)).toHaveCount(0);
  const listed = await sana.page.evaluate(async () => (await fetch('/api/social/rooms', { credentials: 'include' })).json());
  expect(listed.rooms.map((r: { slug: string }) => r.slug)).not.toContain(slug);
  await sana.page.goto(`/social/rooms?room=${slug}`);
  await expect(sana.page.getByTestId('social-room-missing')).toBeVisible({ timeout: 20_000 });

  // And platform-api itself refuses her with the rooms route's 403.
  const t = await token(sana.page);
  if (t.platformApiUrl) {
    const direct = await sana.page.request.get(`${t.platformApiUrl}/api/rooms/${slug}`, { headers: { Authorization: `Bearer ${t.token}` } });
    expect(direct.status(), 'platform-api GET /api/rooms/:slug for a non-member').toBe(403);
  }

  for (const p of [owner, sana]) {
    expect(p.errors, 'page errors').toEqual([]);
    await p.context.close();
  }
});

test('the recordings list renders for the tenant', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const sana = await person(browser, baseURL, 'u-sana', '/social/recordings');
  await expect(sana.page.getByTestId('social-recordings-page')).toBeVisible({ timeout: 20_000 });
  const res = await sana.page.evaluate(async () => (await fetch('/api/social/recordings', { credentials: 'include' })).json());
  if (res.recordings.length) {
    await expect(sana.page.getByTestId('social-recording-list')).toBeVisible();
    // Only social: lobbies reach the page.
    expect(res.recordings.every((r: { lobbyName: string }) => r.lobbyName.startsWith('social:'))).toBe(true);
  } else {
    await expect(sana.page.getByTestId('social-empty-recordings')).toBeVisible();
  }
  expect(sana.errors, 'page errors').toEqual([]);
  await sana.context.close();

  // An orgiq session is refused at the tenant gate.
  const theo = await browser.newContext({ baseURL });
  const page = await theo.newPage();
  await page.goto('/');
  await signIn(page, 'u-nora');
  const me = await page.evaluate(async () => (await fetch('/api/session/me', { credentials: 'include' })).json());
  expect(me.tenant).not.toBe('social');
  expect(await page.evaluate(async () => (await fetch('/api/social/recordings', { credentials: 'include' })).status)).toBe(403);
  await theo.close();
});
