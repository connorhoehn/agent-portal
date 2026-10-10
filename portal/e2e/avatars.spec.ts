import { test, expect, type Browser, type Page } from '@playwright/test';
import { openAs } from './realSession';

// Avatars end to end — people.avatar_url / app_users.avatar_url, served in the
// mock world as the procedural SVGs scripts/avatars/generate-local.mjs checks
// in under portal/public/avatars (middleware/src/mock/avatars.ts). Against the
// shared Tilt stack (PARITY_BASE_URL, default http://127.0.0.1:5183); read-only,
// no mock reset, no scenario switch — the no-avatar case is a response
// intercept, so no other walker's world changes.
//
//   1. /workspaces: the "Sign in as" cards draw each seeded person's face as an
//      <img> that actually loaded, and a user whose directory row has no
//      avatar (intercepted to null) draws initials instead.
//   2. The initiative header draws the owner and SMEs as faces.
//   3. Social: the DM rail draws the peer's face, and the footer presence
//      avatars draw faces for the people standing in the workspace.

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
test.use({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: 'serial' });

const signedIn = (browser: Browser, userId: string) => openAs(browser, userId, { baseURL: BASE, viewport: { width: 1440, height: 900 } });

/** An avatar <img> that decoded (a broken URL would fall back to initials, not pass). */
async function expectLoadedFace(page: Page, selector: string) {
  const img = page.locator(selector).first();
  await expect(img).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0), { timeout: 10_000 }).toBe(true);
}

test('the /workspaces picker draws faces, and initials for a user with no avatar', async ({ browser }) => {
  const { page, close } = await signedIn(browser, 'u-vera');
  // Theo's directory row loses its avatar; everyone else keeps theirs.
  await page.route('**/api/session/users', async (route) => {
    const response = await route.fetch();
    const users = (await response.json()) as Array<{ id: string; avatarUrl?: string | null }>;
    await route.fulfill({ response, json: users.map((u) => (u.id === 'u-theo' ? { ...u, avatarUrl: null } : u)) });
  });
  await page.goto('/workspaces');
  await page.getByRole('tab', { name: /Sign in as/ }).click();
  await expectLoadedFace(page, 'img[alt="Vera Green"][src="/avatars/photos/p-002.jpg"]');
  await expectLoadedFace(page, 'img[alt="Mira Okafor"][src="/avatars/photos/u-mira.jpg"], img[alt="Asha Nair"][src="/avatars/photos/u-asha.jpg"]');
  // Theo: no <img>, the library's initials instead.
  const theo = page.locator('[title="Theo Chang"]').filter({ hasText: /^TC$/ });
  await expect(theo.first()).toBeVisible();
  await expect(page.locator('img[alt="Theo Chang"]')).toHaveCount(0);
  await close();
});

test('the initiative header draws the owner and SMEs as faces', async ({ browser }) => {
  const { page, close } = await signedIn(browser, 'u-theo');
  await page.goto('/iq/projects/p-auth-migration');
  const people = page.getByTestId('initiative-header-people');
  await expect(people).toBeVisible({ timeout: 20_000 });
  await expectLoadedFace(page, '[data-testid="initiative-header-people"] img[src^="/avatars/"]');
  const faces = await people.locator('img[src^="/avatars/"]').count();
  expect(faces, 'owner + SMEs each draw a face').toBeGreaterThanOrEqual(2);
  await close();
});

test('Social: the DM rail and the footer presence avatars draw faces', async ({ browser }) => {
  test.setTimeout(90_000);
  const lena = await signedIn(browser, 'u-lena');
  await lena.page.goto('/social/channels');
  const mira = await signedIn(browser, 'u-mira');
  const { page } = mira;
  await page.goto('/social/channels');
  // u-mira's seeded DM with Farah Osei.
  await expectLoadedFace(page, '[data-testid="social-chat-rail"] img[src="/avatars/photos/u-farah.jpg"]');
  // The footer's "who is here" avatars (xl and up): Lena is standing in the workspace.
  await expectLoadedFace(page, '[data-testid="shell-social-bar"] img[src="/avatars/photos/u-lena.jpg"]');
  await mira.close();
  await lena.close();
});

// The /workspaces cards (user direction, 2026-10-07): every card in a grid has the
// same width and height, so faces, names and the Sign in row line up — the
// workspace cards (different role counts) and the people cards alike.
async function expectUniform(page: Page, grid: string, card: string) {
  const boxes = await page.locator(`[data-testid="${grid}"] > ${card}`).evaluateAll((els) =>
    els.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, name: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 24) }; }));
  expect(boxes.length, `${grid} has cards`).toBeGreaterThan(1);
  for (const box of boxes) {
    expect(Math.abs(box.w - boxes[0]!.w), `${grid} width of ${box.name}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.h - boxes[0]!.h), `${grid} height of ${box.name}`).toBeLessThanOrEqual(1);
  }
}

for (const width of [1440, 1024]) {
  test(`/workspaces cards share one width and height at ${width}px`, async ({ browser }) => {
    const { page, close } = await signedIn(browser, 'u-operator');
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/workspaces');
    await expect(page.getByTestId('select-workspace-grid')).toBeVisible({ timeout: 20_000 });
    await expectUniform(page, 'select-workspace-grid', '*');
    await page.getByRole('tab', { name: /Sign in as/ }).click();
    await expect(page.getByTestId('select-people-grid')).toBeVisible();
    await expectUniform(page, 'select-people-grid', '[data-testid="select-user-card"]');
    // The face and the action row sit at the same y in every card of a row.
    const tops = await page.locator('[data-testid="select-user-card"]').evaluateAll((els) => els.map((el) => {
      const card = el.getBoundingClientRect(); const button = el.querySelector('button')!.getBoundingClientRect();
      const face = el.querySelector('img, [title]')!.getBoundingClientRect();
      return { row: Math.round(card.top), face: face.top - card.top, button: button.top - card.top };
    }));
    for (const t of tops) {
      expect(Math.abs(t.face - tops[0]!.face)).toBeLessThanOrEqual(1);
      expect(Math.abs(t.button - tops[0]!.button)).toBeLessThanOrEqual(1);
    }
    await close();
  });
}
