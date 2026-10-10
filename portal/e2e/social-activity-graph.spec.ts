import { test, expect, type Browser, type Page } from '@playwright/test';
import { loginAs } from './realSession';

// The Social activity/work graph (docs/activity-graph-migration.md §10):
// /social/work-graph and a conversation's `?view=graph` are realtime-modules'
// useWorkGraph into ui-components' WorkGraph, fed by GET /api/social/work-graph/*
// and kept live by the gateway's work-graph stream on
// `social:workgraph:workspace|conversation:<channel>`. Real BFF, real session,
// real socket, on the shared stack (http://127.0.0.1:5183, gateway :28080,
// platform-api :23001, SFU :3902); nothing is reset or restarted.
//
//   1. The rail row 'Work graph' sits under Library and opens the page.
//   2. One live message in #general arrives as a stream delta on a second
//      member's conversation graph (the Work graph toggle, ?view=graph) — the
//      content-free hint fallback never subscribed.
//   3. One call status change (a member joins, then leaves, an open room's call)
//      arrives as stream deltas on the workspace graph.
//   4. A non-member never receives a private channel's nodes (#moderators is
//      Lena's and Mira's); an orgiq session is refused the API.
test.use({ viewport: { width: 1440, height: 1000 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183',
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }, permissions: ['camera', 'microphone'] });
test.describe.configure({ mode: 'serial' });

type Node = { id: string; kind: string; title: string; status: string };
const PRIVATE_CHANNEL = 'social:ch:moderators';

async function session(browser: Browser, baseURL: string | undefined, userId: string, tenant: string | null = 'social') {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 }, permissions: ['camera', 'microphone'] });
  await loginAs(context, userId, baseURL, true);
  if (tenant && tenant !== 'orgiq') expect((await context.request.post('/api/session/tenant', { data: { tenant } })).status()).toBe(200);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const stream: string[] = [];
  const sent: string[] = [];
  page.on('websocket', ws => {
    ws.on('framereceived', f => { const p = String(f.payload); if (p.includes('"work-graph"')) stream.push(p); });
    ws.on('framesent', f => { sent.push(String(f.payload)); });
  });
  return { context, page, errors, stream, sent };
}
function today(timezone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
async function served(page: Page, path = '/api/social/work-graph/workspace/graph'): Promise<Node[]> {
  const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const res = await page.request.get(path, { params: { day: today(timezone), timezone } });
  expect(res.status()).toBe(200);
  return (await res.json()).nodes as Node[];
}
const graphOf = (page: Page) => page.locator('section[aria-label="Shared work graph"]').first();

test('the rail row sits under Library and opens the workspace graph', async ({ browser, baseURL }) => {
  const mira = await session(browser, baseURL, 'u-mira');
  try {
    await mira.page.goto('/social/channels');
    const row = mira.page.getByRole('link', { name: 'Work graph' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(mira.page).toHaveURL(/\/social\/work-graph$/);
    const root = mira.page.getByTestId('social-work-graph');
    await expect(graphOf(root.page())).toBeVisible({ timeout: 20_000 });
    const conversations = (await served(mira.page)).filter(n => n.id.startsWith('sconv:'));
    expect(conversations.length).toBeGreaterThan(0);
    await expect.poll(async () => {
      for (const c of conversations.slice(0, 12)) if (await root.getByText(c.title, { exact: true }).count()) return true;
      return false;
    }, { timeout: 20_000 }).toBe(true);
    await root.screenshot({ path: test.info().outputPath('social-work-graph.png') });
    expect(mira.errors).toEqual([]);
  } finally { await mira.context.close(); }
});

test('a live message arrives as a delta on another member’s conversation graph', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const mira = await session(browser, baseURL, 'u-mira');
  const sana = await session(browser, baseURL, 'u-sana');
  try {
    await sana.page.goto('/social/channels/general?view=graph');
    await expect(graphOf(sana.page)).toBeVisible({ timeout: 20_000 });
    await expect(sana.page.getByTestId('social-conversation-graph-toggle')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => sana.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    const before = (await served(sana.page, '/api/social/work-graph/conversations/social%3Ach%3Ageneral/graph')).find(n => n.id.startsWith('sthread:'));

    await mira.page.goto('/social/channels/general');
    const input = mira.page.getByTestId('social-chat-composer-input');
    await expect(input).toBeVisible({ timeout: 20_000 });
    await expect(mira.page.getByTestId('social-chat-panel').getByText('The realtime gateway is not connected')).toHaveCount(0, { timeout: 15_000 });
    await input.click();
    await mira.page.keyboard.type(`Graph e2e message ${Date.now()}`);
    await mira.page.keyboard.press('Enter');

    // The thread node arrives (or changes) as this viewer's own delta, no reload.
    await expect.poll(() => sana.stream.some(p => p.includes('"kind":"delta"') && p.includes('sthread:')), { timeout: 30_000 }).toBe(true);
    const after = (await served(sana.page, '/api/social/work-graph/conversations/social%3Ach%3Ageneral/graph')).find(n => n.id.startsWith('sthread:'));
    expect(after, 'the day has a message thread node').toBeTruthy();
    if (before) expect(after!.id).toBe(before.id);
    // The content-free hint fallback never subscribed.
    expect(sana.sent.some(p => p.includes('"social:workgraph"') && !p.includes('social:workgraph:'))).toBe(false);
    await graphOf(sana.page).screenshot({ path: test.info().outputPath('social-conversation-graph-live-message.png') });
    expect(sana.errors).toEqual([]);
  } finally { await mira.context.close(); await sana.context.close(); }
});

test('a call status change arrives as deltas on the workspace graph', async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const lena = await session(browser, baseURL, 'u-lena');
  const sana = await session(browser, baseURL, 'u-sana');
  try {
    const rooms = await (await sana.context.request.get('/api/social/rooms')).json();
    const room = (rooms.rooms as Array<{ slug: string; visibility: string }>).find(r => r.visibility === 'org');
    test.skip(!room, 'no open room to call in');
    await lena.page.goto('/social/work-graph');
    await expect(graphOf(lena.page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => lena.stream.some(p => p.includes('"action":"subscribed"')), { timeout: 20_000 }).toBe(true);
    const seen = lena.stream.length;

    await sana.page.goto(`/social/rooms?room=${room!.slug}`);
    const join = sana.page.getByTestId('social-room-join');
    await expect(join).toBeEnabled({ timeout: 20_000 });
    await join.click();
    // The dock reports its phase; it is a shelf that may collapse to no box, so read the attribute, not visibility.
    await expect(sana.page.getByTestId('social-call-dock')).toHaveAttribute('data-phase', 'active', { timeout: 30_000 });
    // Live: the call appears as a delta (no reload, no refetch hint).
    await expect.poll(() => lena.stream.slice(seen).some(p => p.includes('"kind":"delta"') && p.includes('scall:')), { timeout: 30_000 }).toBe(true);
    const afterJoin = lena.stream.length;

    await sana.page.getByTestId('social-room-leave').click();
    // Leaving moves the call's status: a second delta naming the call.
    await expect.poll(() => lena.stream.slice(afterJoin).some(p => p.includes('"kind":"delta"') && p.includes('scall:')), { timeout: 45_000 }).toBe(true);
    await graphOf(lena.page).screenshot({ path: test.info().outputPath('social-work-graph-live-call.png') });
    expect(lena.errors).toEqual([]);
  } finally { await lena.context.close(); await sana.context.close(); }
});

test('a non-member never sees a private channel’s nodes; an orgiq session is refused', async ({ browser, baseURL }) => {
  const sana = await session(browser, baseURL, 'u-sana');
  const lena = await session(browser, baseURL, 'u-lena');
  const nora = await session(browser, baseURL, 'u-nora', 'orgiq');
  try {
    const day = today('UTC');
    const params = { day, timezone: 'UTC' };
    // The member sees the private channel; the non-member's snapshots name nothing of it.
    const own = await lena.page.request.get('/api/social/work-graph/workspace/graph', { params });
    expect(own.status()).toBe(200);
    const ownText = JSON.stringify(await own.json());
    const theirs = await sana.page.request.get('/api/social/work-graph/workspace/graph', { params });
    expect(theirs.status()).toBe(200);
    const theirText = JSON.stringify(await theirs.json());
    expect(theirText).not.toContain('moderators');
    expect(theirText).not.toContain(PRIVATE_CHANNEL);
    // The member reads that conversation's own page; the day may hold no message there, the conversation is hers.
    const ownPage = await lena.page.request.get(`/api/social/work-graph/conversations/${encodeURIComponent(PRIVATE_CHANNEL)}/graph`, { params });
    expect(ownPage.status()).toBe(200);
    expect(JSON.stringify(await ownPage.json())).toContain('sconv:social:ch:moderators');
    // Asking for the private conversation directly is the uniform 404.
    const direct = await sana.page.request.get(`/api/social/work-graph/conversations/${encodeURIComponent(PRIVATE_CHANNEL)}/graph`, { params });
    expect(direct.status()).toBe(404);
    // Forged conversation names are refused (404/400), never served.
    const forged = await sana.page.request.get(`/api/social/work-graph/conversations/${encodeURIComponent('social:dm:u-lena:u-mira')}/graph`, { params });
    expect([400, 404]).toContain(forged.status());
    // Cross-tenant: an orgiq session is refused the API and gets no social frames.
    expect((await nora.context.request.get('/api/social/work-graph/workspace/graph', { params })).status()).toBe(403);
    await nora.page.goto('/iq/activity');
    expect(nora.stream.join('\n')).not.toContain('sconv:');
  } finally { await sana.context.close(); await lena.context.close(); await nora.context.close(); }
});
