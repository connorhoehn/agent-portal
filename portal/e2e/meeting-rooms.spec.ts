import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAsClone } from './realSession';
import { chooseOption } from './selectOption';

// Meeting rooms on an initiative huddle (docs/meeting-rooms-app-goal.md E1),
// with three clones on Auth Migration: Vera Green (org-leader, the call's
// caller and so its organizer, decision 3), Nora DaSilva (the participant)
// and Rachel Kowalski (a third seat: Rooms needs three people, decision 4).
// What it proves, through the library's meeting composites only:
//   hands     Nora raises her hand on the stage toolbar; Vera's People pane
//             lists it first with Lower, and Lower clears it on Nora's side
//   rooms     Vera creates two rooms, puts Nora in Room 1 and Rachel in
//             Room 2, and opens them
//   stage     Nora's stage header shows the Room 1 banner; on a page without
//             a call composer the banner sits under the page instead
//   chat      Nora's huddle chat says "Room 1 chat"; Vera's "To: All rooms"
//             announcement reaches it, marked as an announcement
//   end       Vera ends the rooms: no banner and no room chat line for anyone
// Once in light and once in dark.
//
// The BFF, its gateway (meeting, chat, the guards of M2) and the sign-ins are
// real; media is substituted the way huddle-chat-real.spec.ts does it (a fake
// platform-api answers session and join, so no WebRTC), because this is the
// fixture proof: the real-media move is huddle-breakout-real.spec.ts (E2).
//
// Needs: dev:mock with the /ws gateway on (GET /api/health realtime.gateway),
// clones (MOCK_AURORA), the BFF from M2 and a portal built with
// VITE_MEETING_ROOMS=true (lib/meetingRooms.ts) — export the same
// VITE_MEETING_ROOMS=true when running this spec; it is skipped otherwise,
// and skips again if the target's stage shows no meeting toolbar.

const INITIATIVE_URL = '/iq/projects/p-auth-migration';
const FAKE_PLATFORM = 'http://meeting-media.test';
const MEETING_ROOMS_ON = process.env.VITE_MEETING_ROOMS === 'true' || process.env.VITE_MEETING_ROOMS === '1';
// Unique per run: the gateway keeps a meeting's announcement history per lobby, past the call.
const ANNOUNCEMENT = `Five minutes left, then back to the main huddle (${Date.now().toString(36)})`;

test.use({
  ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}),
  viewport: { width: 1440, height: 900 },
});
test.describe.configure({ mode: 'serial' });
test.skip(!MEETING_ROOMS_ON, 'the target portal must be built with VITE_MEETING_ROOMS=true (export it for this run too)');

type Clone = Awaited<ReturnType<typeof openAsClone>>;

/** Media is signalling-only: one shared fake session, every join answered. */
async function fakeMedia(context: BrowserContext, label: string) {
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, platformApiUrl: FAKE_PLATFORM, videoUrl: null } });
  });
  await context.route(`${FAKE_PLATFORM}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: 200, json: path.endsWith('/join') ? { participantId: `participant-${label}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'meeting-signalling-only' } });
  });
}

// `baseURL` is passed through: openAsClone otherwise falls back to the CONFIG project's baseURL
// (test.info().project.use), which ignores this file's test.use and lands on the shared portal.
async function clone(browser: Browser, baseURL: string | undefined, persona: string, theme: 'light' | 'dark'): Promise<Clone> {
  return openAsClone(browser, persona, {
    ...(baseURL ? { baseURL } : {}), label: 'meeting-rooms-e1', preJoin: 'remembered', url: INITIATIVE_URL,
    contextOptions: { colorScheme: theme },
    prepare: context => fakeMedia(context, persona),
  });
}

async function gatewayOn(request: APIRequestContext): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    const body = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
    if (body) return body.realtime?.gateway === 'on';
    await new Promise(r => setTimeout(r, 1_500));
  }
  return false;
}

// ── Where things are (CallMeeting.tsx, SocialFooter.tsx, HuddleChat.tsx) ───
const huddle = (page: Page) => page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
/** The expanded stage's header (CallMediaOutlet header): banner + MeetingToolbar, above the initiative composer's call block. */
const stage = (page: Page) => page.getByTestId('huddle-meeting-stage');
const stageItem = (page: Page, id: string) => stage(page).getByTestId(`meeting-toolbar-${id}`);
/** The footer bar's meeting items, on a page whose dock is collapsed (HuddleBar `meetingItems`). */
const footerItem = (page: Page, id: string) => page.getByTestId(`shell-call-dock-meeting-${id}`);
const pane = (page: Page) => page.getByTestId('huddle-meeting-pane');
const rooms = (page: Page) => page.getByTestId('huddle-breakout-rooms');
const banner = (page: Page) => page.getByTestId('breakout-banner');
const chatPane = (page: Page) => page.getByTestId('huddle-chat-panel');

/**
 * Another page, reached in-app so the call stays up: the breadcrumb's Initiatives (the rail is
 * folded three levels deep, so it offers no Settings link). The huddle chat opens in the right pane.
 */
async function toList(page: Page) {
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Initiatives', exact: true }).click();
  await expect(page).toHaveURL(/\/iq\/projects(\?|$)/);
  await expect(page.getByTestId('shell-call-dock')).toBeVisible();
}
async function openChat(page: Page) {
  if (!await chatPane(page).isVisible()) await page.getByTestId('shell-call-dock-chat').click();
  await expect(chatPane(page)).toBeVisible();
}
async function endLeftoverRooms(page: Page) {
  // Ending open rooms leaves them drafted (closed); Delete rooms returns the panel to Create.
  // Each step is a server round trip, so poll until Create shows.
  const create = rooms(page).getByTestId('breakout-create');
  await expect.poll(async () => {
    if (await create.isVisible()) return true;
    for (const id of ['breakout-end', 'breakout-delete']) {
      const control = rooms(page).getByTestId(id);
      if (await control.isVisible()) { await control.click(); break; }
    }
    return create.isVisible();
  }, { timeout: 20_000, intervals: [500, 1_000, 2_000] }).toBe(true);
}
async function leave(page: Page) {
  const button = page.getByTestId(/^(shell-)?call-dock-leave$/).first();
  if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
}

for (const theme of ['light', 'dark'] as const) {
  test(`meeting rooms on an initiative huddle: hands, rooms, room chat, announcement, end (${theme})`, async ({ browser, request, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    test.skip(!await gatewayOn(request), 'the middleware is unreachable or its /ws gateway is off (GET /api/health realtime.gateway)');
    const people: Clone[] = [];
    try {
      const vera = await clone(browser, baseURL, 'u-vera', theme); people.push(vera);
      const nora = await clone(browser, baseURL, 'u-nora', theme); people.push(nora);
      const rachel = await clone(browser, baseURL, 'u-rachel', theme); people.push(rachel);
      if (theme === 'dark') for (const p of people) await expect(p.page.locator('html')).toHaveAttribute('data-theme', 'dark');

      // Vera starts the page huddle (she is its caller, so its organizer); the others join it.
      // Each joiner reloads first so the lobby's `status` discovery already names Vera's call:
      // a Huddle pressed before discovery answers starts a second call in the same lobby.
      for (const [i, p] of [vera, nora, rachel].entries()) {
        if (i > 0) await p.page.reload();
        await expect(huddle(p.page)).toBeEnabled({ timeout: 30_000 });
        await huddle(p.page).click();
        await expect(p.page.getByTestId('shell-call-dock')).toBeVisible({ timeout: 30_000 });
      }
      const probe = await stage(vera.page).waitFor({ timeout: 20_000 }).then(() => true).catch(() => false);
      test.skip(!probe, 'the stage shows no meeting toolbar: the target portal was built without VITE_MEETING_ROOMS');
      for (const p of people) await expect(stageItem(p.page, 'raise')).toBeVisible();
      // Three people in the call: Rooms is offered (decision 4).
      await expect(stageItem(vera.page, 'rooms')).toBeVisible({ timeout: 15_000 });

      // ── hands ─────────────────────────────────────────────────────────────
      await stageItem(nora.page, 'raise').click();
      await expect(stageItem(nora.page, 'raise')).toHaveAttribute('aria-pressed', 'true');
      await stageItem(vera.page, 'people').click();
      await expect(pane(vera.page)).toHaveAttribute('data-pane', 'people');
      const noraRow = pane(vera.page).locator(`[data-testid="roster-row"][data-user-id="${nora.cloneId}"]`);
      await expect(noraRow.getByTestId('roster-raised-hand')).toBeVisible({ timeout: 15_000 });
      await expect(pane(vera.page).getByTestId('roster-row').first()).toHaveAttribute('data-user-id', nora.cloneId);
      await noraRow.getByTestId('roster-lower-hand').click();
      await expect(stageItem(nora.page, 'raise')).toHaveAttribute('aria-pressed', 'false', { timeout: 15_000 });
      await expect(noraRow.getByTestId('roster-raised-hand')).toHaveCount(0);

      // ── rooms: create two, assign, open ───────────────────────────────────
      await stageItem(vera.page, 'rooms').click();
      await expect(rooms(vera.page)).toBeVisible();
      // The gateway keeps a meeting's rooms per lobby, past the call that made them: a run that
      // stopped mid-way leaves them open for the next call here. End them so this run starts clean.
      await endLeftoverRooms(vera.page);
      await rooms(vera.page).getByTestId('breakout-create-count').fill('2');
      await rooms(vera.page).getByTestId('breakout-create-submit').click();
      await expect(rooms(vera.page).getByTestId('breakout-room')).toHaveCount(2, { timeout: 15_000 });
      const unassigned = (id: string) => rooms(vera.page).locator(`[data-testid="breakout-unassigned-person"][data-user-id="${id}"]`);
      await chooseOption(unassigned(nora.cloneId).getByTestId('breakout-move'), { label: 'Room 1' });
      await chooseOption(unassigned(rachel.cloneId).getByTestId('breakout-move'), { label: 'Room 2' });
      for (const id of [nora.cloneId, rachel.cloneId]) await expect(unassigned(id)).toHaveCount(0);
      await rooms(vera.page).getByTestId('breakout-open-all').click();
      await expect(rooms(vera.page)).toHaveAttribute('data-phase', 'open', { timeout: 15_000 });

      // ── the participant's stage moves ─────────────────────────────────────
      await expect(stage(nora.page).getByTestId('breakout-banner')).toContainText('Room 1', { timeout: 20_000 });
      await expect(stage(rachel.page).getByTestId('breakout-banner')).toContainText('Room 2', { timeout: 20_000 });
      await expect(banner(vera.page)).toHaveCount(0); // the organizer stays in the main meeting
      await testInfo.attach(`stage-in-room-${theme}`, { body: await nora.page.screenshot(), contentType: 'image/png' });

      // Away from the initiative the banner follows: in the stage where a page holds the dock,
      // else under the page — exactly once either way.
      await toList(nora.page);
      await expect(banner(nora.page)).toHaveCount(1);
      await expect(banner(nora.page)).toContainText('Room 1');
      await openChat(nora.page);
      await expect(chatPane(nora.page).getByTestId('meeting-chat-context')).toContainText('Room 1 chat', { timeout: 15_000 });

      // ── the organizer announces to every room from the initiative composer ─
      // Vera stays on the initiative page, whose composer claims the huddle: the "To" switch is in
      // the huddle thread beside it, and the composer's send must announce, not post to the chat.
      const target = vera.page.getByTestId('meeting-chat-target');
      await expect(target).toBeVisible({ timeout: 15_000 });
      await target.getByText('All rooms', { exact: true }).click();
      const composer = vera.page.getByTestId('initiative-workspace').getByTestId('initiative-composer');
      await expect(composer.getByRole('combobox', { name: 'Chat recipient' })).toHaveAttribute('data-value', /^huddle:/);
      await composer.getByRole('textbox', { name: 'Message' }).fill(ANNOUNCEMENT);
      await composer.getByRole('button', { name: /^Send/ }).click();
      // Vera's own thread shows it once, as the marked announcement — no ordinary chat copy.
      const veraThread = vera.page.getByTestId('huddle-thread');
      await expect(veraThread.getByText(ANNOUNCEMENT, { exact: true })).toHaveCount(1, { timeout: 20_000 });
      await expect(veraThread.getByTestId('meeting-chat-announcement-note')).toHaveCount(1);
      // Nora's room chat carries it, marked; her banner shows it too.
      const announced = chatPane(nora.page).getByText(ANNOUNCEMENT, { exact: true });
      await expect(announced).toBeVisible({ timeout: 20_000 });
      await expect(chatPane(nora.page).getByTestId('meeting-chat-announcement-note')).toContainText('Announcement to every room');
      await expect(banner(nora.page).getByTestId('breakout-banner-announcement')).toContainText(ANNOUNCEMENT);
      await testInfo.attach(`room-chat-announcement-${theme}`, { body: await nora.page.screenshot(), contentType: 'image/png' });

      // ── the organizer ends the rooms; everyone is back ────────────────────
      // Rooms is still open in the right column; else reopen it from whichever bar carries it here.
      if (!await rooms(vera.page).isVisible()) await stageItem(vera.page, 'rooms').or(footerItem(vera.page, 'rooms')).first().click();
      await expect(rooms(vera.page)).toBeVisible();
      await rooms(vera.page).getByTestId('breakout-end').click();
      for (const p of [nora, rachel]) await expect(banner(p.page)).toHaveCount(0, { timeout: 20_000 });
      await expect(chatPane(nora.page).getByTestId('meeting-chat-context')).toHaveCount(0);
      await nora.page.goBack();
      await expect(stage(nora.page)).toBeVisible();
      await expect(stage(nora.page).getByTestId('breakout-banner')).toHaveCount(0);
      for (const p of people) expect(p.errors, `${p.cloneId} page errors`).toEqual([]);
    } finally {
      // Best effort: never leave rooms open on the shared lobby for the next run.
      const organizer = people[0];
      if (organizer && await rooms(organizer.page).isVisible().catch(() => false)) await endLeftoverRooms(organizer.page).catch(() => undefined);
      for (const p of people) await leave(p.page);
      await Promise.all(people.map(p => p.close()));
    }
  });
}
