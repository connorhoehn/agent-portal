import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// Communication — the Social application plane inside orgiq, assessment and
// pipelines (docs/social-tenant-design.md §4.6 "Communication";
// docs/nav-server-tier-decisions.md, 2026-10-07). Against the shared Tilt stack
// (PARITY_BASE_URL, default http://127.0.0.1:5183). No mock reset: the walk
// creates one uniquely named public channel (u-mira's) and one message in it,
// and leaves them.
//
//   1. An org-leader (u-vera, holding social participant) finds Org ›
//      Communication in the rail, the trail and the palette; the plane is the
//      full chat rail (Activity, Mentions, Calls, Recordings; Active now, Teams,
//      Rooms, Direct messages, Channels); /iq/calls lands on its Calls
//      destination, which lists the orgiq page huddles (/api/calls/tenant).
//      The full rail is the plane's HOME; each sub-route shows Active now and
//      only its own section (…/calls none) — one section per route, 2026-10-13.
//   2. u-mira (Social, community-admin) creates a public channel; u-vera joins
//      it FROM the orgiq plane and posts; u-mira sees her join and the post.
//   3. An orgiq user with no Social grant (u-hr, hr-admin, no linked person) gets the library EmptyState
//      "Ask an admin for Social access" and the page makes ZERO /api/social
//      requests; the Calls destination still opens.
//   4. The assessment plane as u-asha (an assessor with social participant):
//      the full rail, Assess › Communication, and its groups section (My teams). The pipelines plane as u-tomas
//      (a pipelines author who also holds Social; u-kofi holds none): the denied
//      state, zero /api/social requests.

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
/** The /api/social allowlist: the only Social routes the plane may call (grant-gated, never the tenant router). */
const ALLOWED_SOCIAL_PREFIXES = ['plane/', 'embedded', 'dms', 'share-destinations', 'bindings'];
const ALLOWED_SOCIAL = { test: (path: string) => ALLOWED_SOCIAL_PREFIXES.some((p) => path.startsWith(`/api/social/${p}`)) };
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

type Person = { context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[]; social: string[] };

async function person(browser: Browser, userId: string): Promise<Person> {
  const { context, page, errors, social } = await openAs(browser, userId, { baseURL: BASE, viewport: { width: 1440, height: 900 }, captureSocial: true });
  return { context, page, errors, social };
}

const call = (page: Page, method: string, path: string, body?: unknown) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, credentials: 'include', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, { method, path, body });

async function composerReady(page: Page) {
  const input = page.getByTestId('social-chat-composer-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('social-chat-panel').getByText('The realtime gateway is not connected')).toHaveCount(0, { timeout: 15_000 });
  return input;
}
const message = (page: Page, text: string) => page.getByTestId('social-chat-panel').getByTestId('chat-message').filter({ hasText: text });

// The plane's HOME (/<tenant>/communication, no sub-route) keeps every section; each sub-route shows only its own
// (one section per route, the user 2026-10-13 — docs/social-tenant-design.md §4.5/§4.6).
const SECTION_CAPTIONS = ['Teams', 'Rooms', 'Direct messages', 'Channels', 'My initiatives', 'My org teams', 'My teams', 'My pipelines'];
/** On a sub-route: the shelf, Active now and only `own` (or no section at all on Calls/Recordings). */
async function oneSectionRail(page: Page, own: string | null) {
  const rail = page.getByTestId('social-chat-rail');
  await expect(rail).toBeVisible({ timeout: 20_000 });
  await expect(rail).toContainText('Active now', { timeout: 15_000 });
  const shown = () => rail.evaluate((el, captions) => {
    const heads = [...el.querySelectorAll('h2, h3, [role="heading"], button, span')].map((e) => (e.textContent ?? '').trim().toLowerCase());
    return captions.filter((c) => heads.some((h) => new RegExp(`^${c.toLowerCase()}\\s*\\d*$`).test(h)));
  }, SECTION_CAPTIONS);
  await expect.poll(shown, { timeout: 15_000 }).toEqual(own ? [own] : []);
}
// The library draws a conversation section only when it has rows (u-asha has no DMs yet), as in the Social tenant.
async function fullRail(page: Page, sections = ['Direct messages', 'Channels']) {
  const rail = page.getByTestId('social-chat-rail');
  await expect(rail).toBeVisible({ timeout: 20_000 });
  // The shelf is one icon row now (its names are screen-reader text); the sections keep their captions.
  for (const label of ['Activity', 'Mentions', 'Calls', 'Recordings', 'Active now', 'Teams', 'Rooms', ...sections]) {
    await expect(rail, `rail shows ${label}`).toContainText(label, { timeout: 15_000 });
  }
}

test('an org-leader finds Communication in rail, trail and palette — the full Social plane, with the orgiq call log under Calls', async ({ browser }) => {
  test.setTimeout(120_000);
  const vera = await person(browser, 'u-vera');
  const { page } = vera;
  expect((await call(page, 'GET', '/api/session/me')).body.tenant).toBe('orgiq');

  await page.goto('/iq/calls');
  await expect(page).toHaveURL(/\/iq\/communication\/calls$/, { timeout: 15_000 });
  await expect(page.getByTestId('communication-page')).toHaveAttribute('data-access', 'social');
  const nav = page.locator('[data-shell-nav]');
  await expect(nav.getByRole('link', { name: /^Communication/ })).toBeVisible();
  await expect(nav.getByRole('link', { name: /^Calls$/ })).toHaveCount(0);
  const crumbs = page.getByTestId('section-crumbs');
  // The trail is the section's (Engage › Communication, b02f3d85); the tenant is in the header switcher, not the trail.
  await expect(crumbs).toContainText('Engage'); await expect(crumbs).toContainText('Communication');
  // …/calls is a shelf destination: Active now and no section (one section per route).
  await oneSectionRail(page, null);
  // Calls: this tenant's page huddles (the former Calls page), then the Social call log.
  const calls = page.getByTestId('communication-calls');
  await expect(calls).toBeVisible();
  const tenantCalls = await call(page, 'GET', '/api/calls/tenant');
  expect(tenantCalls.status).toBe(200);
  await expect(calls.getByTestId((tenantCalls.body.calls as unknown[]).length ? 'tenant-call-log' : 'tenant-calls-empty')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('communication-open-social')).toBeVisible(); // the secondary link only

  // The cascade: rail flush at the content top, trail first at the 24px gutter right of it.
  const frame = await page.evaluate(() => {
    const r = document.querySelector('[data-testid="social-chat-rail"]')!.getBoundingClientRect();
    const band = document.querySelector('[data-testid="section-crumbs"]')!;
    const c = (band.querySelector('nav[aria-label*="readcrumb"]') ?? band).getBoundingClientRect();
    const m = document.querySelector('[data-shell-nav] main')!.getBoundingClientRect();
    return { railTop: Math.round(r.top), railRight: Math.round(r.right), mainTop: Math.round(m.top), crumbLeft: Math.round(c.left), crumbTop: Math.round(c.top) };
  });
  expect(Math.abs(frame.railTop - frame.mainTop)).toBeLessThanOrEqual(2);
  expect(Math.abs(frame.crumbLeft - frame.railRight - 24)).toBeLessThanOrEqual(2);
  expect(frame.crumbTop - frame.mainTop).toBeLessThanOrEqual(24);

  // The plane's home keeps the full rail: the org context (docs/communication-plane-goal.md §1.3–1.4), her
  // initiatives and her org teams between Active now and Teams, then Rooms, Direct messages, Channels.
  // The bare path opens her default conversation (the landing, b5aa9239); the home with a view named keeps the full rail.
  await page.goto('/iq/communication?group=initiative%3Ap-auth-migration');
  await fullRail(page, ['My initiatives', 'My org teams', 'Direct messages', 'Channels']);
  const sectionOrder = await page.getByTestId('social-chat-rail').evaluate((r) => ['Active now', 'My initiatives', 'My org teams', 'Teams']
    .map((label) => [...r.querySelectorAll('[data-testid="rail-section-header"], button[aria-expanded]')].findIndex((b) => (b.textContent ?? '').trim().startsWith(label))));
  expect(sectionOrder.every((i, n) => i >= 0 && (n === 0 || i > sectionOrder[n - 1]!)), `rail order ${sectionOrder}`).toBe(true);
  await expect(page.getByTestId('plane-groups').getByTestId('conversation-row').filter({ hasText: 'Auth Migration' })).toContainText('#auth-migration', { timeout: 15_000 });
  // Each sub-route: its own section only.
  for (const [route, own] of [['channels', 'Channels'], ['dms', 'Direct messages'], ['teams', 'Teams'], ['rooms', 'Rooms'], ['recordings', null]] as const) {
    await page.goto(`/iq/communication/${route}`);
    await oneSectionRail(page, own);
  }

  // Palette jump.
  await page.goto('/iq/search');
  await page.getByRole('button', { name: 'Open command palette' }).click();
  await page.keyboard.type('Communication');
  await page.getByRole('option', { name: /^Communication/ }).first().click();
  await expect(page).toHaveURL(/\/iq\/communication$/, { timeout: 10_000 });
  await expect(page.getByTestId('social-chat-rail')).toBeVisible({ timeout: 15_000 });

  expect(vera.errors, 'page errors').toEqual([]);
  await vera.context.close();
});

test('the org-leader joins a public channel from the orgiq plane and posts; u-mira, in Social, sees the join and the post', async ({ browser }) => {
  test.setTimeout(150_000);
  const mira = await person(browser, 'u-mira');
  expect((await call(mira.page, 'GET', '/api/session/me')).body.tenant).toBe('social');
  const name = `plane-walk-${Date.now().toString(36)}`;
  const created = await call(mira.page, 'POST', '/api/social/channels', { name, privacy: 'public' });
  expect(created.status, 'u-mira creates a public channel in Social').toBe(201);
  const slug = created.body.channel.slug as string;
  await mira.page.goto(`/social/channels/${slug}`);
  await composerReady(mira.page);

  const vera = await person(browser, 'u-vera');
  await vera.page.goto(`/iq/communication/channels/${slug}`);
  await expect(vera.page).toHaveURL(new RegExp(`/iq/communication/channels/${slug}$`));
  const join = vera.page.getByTestId('social-join-channel');
  await expect(join).toBeVisible({ timeout: 20_000 });
  await join.click();
  const input = await composerReady(vera.page);
  const text = `Joined from Org Communication ${Date.now()}`;
  await input.click();
  await vera.page.keyboard.type(text);
  await vera.page.keyboard.press('Enter');
  await expect(message(vera.page, text)).toHaveCount(1, { timeout: 10_000 });
  await expect(message(mira.page, text)).toHaveCount(1, { timeout: 5_000 });
  // The join, as Social sees it: u-vera is a member of u-mira's channel.
  const detail = await call(mira.page, 'GET', `/api/social/channels/${slug}`);
  expect(detail.body.members.map((m: { userId: string }) => m.userId)).toEqual(expect.arrayContaining(['u-mira', 'u-vera']));
  // Every Social call the plane made went to the grant-gated routes; the session never left orgiq.
  expect(vera.social.filter((p) => !ALLOWED_SOCIAL.test(p))).toEqual([]);
  expect((await call(vera.page, 'GET', '/api/session/me')).body.tenant).toBe('orgiq');

  for (const p of [vera, mira]) { expect(p.errors, 'page errors').toEqual([]); await p.context.close(); }
});

test('an orgiq user without a Social grant gets the denied state and makes zero /api/social requests', async ({ browser }) => {
  test.setTimeout(90_000);
  const eli = await person(browser, 'u-hr');
  const { page } = eli;
  expect((await call(page, 'GET', '/api/session/me')).body.grants.social ?? []).toEqual([]);
  eli.social.length = 0;
  await page.goto('/iq/communication');
  await expect(page.getByTestId('communication-page')).toHaveAttribute('data-access', 'no-grant');
  const denied = page.getByTestId('communication-no-social');
  await expect(denied).toBeVisible({ timeout: 15_000 });
  await expect(denied).toContainText('Ask an admin for Social access');
  await expect(page.getByTestId('section-crumbs')).toContainText('Communication');
  await denied.getByRole('button', { name: 'Open Calls' }).click();
  await expect(page).toHaveURL(/\/iq\/communication\/calls$/);
  await expect(page.getByTestId('tenant-calls-empty').or(page.getByTestId('tenant-call-log'))).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(2_000);
  expect(eli.social, 'no /api/social request from a session without a Social grant').toEqual([]);
  expect(eli.errors, 'page errors').toEqual([]);
  await eli.context.close();
});

test('the assessment plane as u-asha, the pipelines plane as u-tomas (granted) and u-kofi (no grant), with their real grants', async ({ browser }) => {
  test.setTimeout(120_000);
  const asha = await person(browser, 'u-asha');
  expect((await call(asha.page, 'GET', '/api/session/me')).body.tenant).toBe('assessment');
  await asha.page.goto('/assessment/calls');
  await expect(asha.page).toHaveURL(/\/assessment\/communication\/calls$/, { timeout: 15_000 });
  await expect(asha.page.getByTestId('communication-page')).toHaveAttribute('data-access', 'social');
  await expect(asha.page.locator('[data-shell-nav]').getByRole('link', { name: /^Communication/ })).toBeVisible();
  const crumbs = asha.page.getByTestId('section-crumbs');
  await expect(crumbs).toContainText('Assess'); await expect(crumbs).toContainText('Communication');
  await oneSectionRail(asha.page, null);
  // The plane's home: the full rail with the assessment groups section, which lists the teams the assessor is on
  // (GET /api/me/groups?kind=assessment-team), not every team.
  await asha.page.goto('/assessment/communication');
  await fullRail(asha.page, ['My teams', 'Channels']);
  await expect(asha.page.getByTestId('plane-groups-section').getByRole('button', { name: /^My teams/ })).toBeVisible();
  await expect(asha.page.getByTestId('plane-groups').locator('[data-testid="conversation-row"]').first()).toBeVisible({ timeout: 20_000 });
  await expect(asha.page.getByTestId('plane-org-teams-section')).toHaveCount(0);
  await asha.page.goto('/assessment/communication/channels');
  await expect(asha.page.getByTestId('social-chat-rail').locator('[data-testid="conversation-row"]').first()).toBeVisible({ timeout: 20_000 });
  await oneSectionRail(asha.page, 'Channels');
  expect(asha.errors, 'assessment page errors').toEqual([]);
  await asha.context.close();

  // u-tomas (pipelines author) holds a Social grant since 2026-10-07, so the pipelines plane opens for him;
  // u-kofi (operator) still holds none and walks the denied state.
  const tomas = await person(browser, 'u-tomas');
  // His home tenant is pipelines (the home-tenant rule in lib/session.ts mintSession), so no tenant switch is needed.
  const me = (await call(tomas.page, 'GET', '/api/session/me')).body;
  expect(me.tenant).toBe('pipelines');
  expect(me.grants.social ?? [], 'the seeded u-tomas (pipelines author) holds a Social grant').toEqual(['participant']);
  await tomas.page.goto('/pipelines/communication');
  await expect(tomas.page.getByTestId('communication-page')).toHaveAttribute('data-access', 'social', { timeout: 15_000 });
  const pCrumbs = tomas.page.getByTestId('section-crumbs');
  await expect(pCrumbs).toContainText('Runs'); await expect(pCrumbs).toContainText('Communication');
  await expect(tomas.page.locator('[data-shell-nav]').getByRole('link', { name: /^Communication/ })).toBeVisible();
  await expect(tomas.page.getByTestId('plane-groups-section').getByRole('button', { name: /^My pipelines/ })).toBeVisible({ timeout: 15_000 });
  // My pipelines: the definitions u-tomas owns or last edited (GET /api/me/groups?kind=pipeline).
  await expect(tomas.page.getByTestId('plane-groups').locator('[data-testid="conversation-row"]').first()).toBeVisible({ timeout: 20_000 });
  expect(tomas.errors, 'pipelines page errors').toEqual([]);
  await tomas.context.close();

  const kofi = await person(browser, 'u-kofi');
  const kofiMe = (await call(kofi.page, 'GET', '/api/session/me')).body;
  expect(kofiMe.tenant).toBe('pipelines');
  expect(kofiMe.grants.social ?? [], 'the seeded pipelines operator holds no Social grant').toEqual([]);
  kofi.social.length = 0;
  await kofi.page.goto('/pipelines/communication');
  await expect(kofi.page.getByTestId('communication-page')).toHaveAttribute('data-access', 'no-grant');
  await expect(kofi.page.getByTestId('communication-no-social')).toContainText('Ask an admin for Social access', { timeout: 15_000 });
  await kofi.page.waitForTimeout(2_000);
  expect(kofi.social, 'no /api/social request from the pipelines operator').toEqual([]);
  expect(kofi.errors, 'pipelines page errors').toEqual([]);
  await kofi.context.close();
});
