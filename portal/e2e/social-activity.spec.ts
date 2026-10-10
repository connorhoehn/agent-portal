import { test, expect, type Browser, type Page } from '@playwright/test';
import { signIn } from './realSession';

// The judge for the header activity indicator (docs/social-tenant-design.md
// §3.6; docs/social-tenant-goal.md phase N). Runs against the shared dev:mock
// stack with the document env (`npm run dev:mock:social`), like
// assessment-documents-parity.spec.ts, and PARITY_BASE_URL when that is not :5183.
//
//   1. u-farah replies to u-jonas's comment on the workspace's Rubric Overview
//      page → u-jonas's bell reads 1 within 2s, no reload; the popover names
//      the document and the author; clicking lands on the document with the
//      Comments tab open, and the bell reads 0.
//   2. u-hr (Priya Desai, orgiq hr-admin only — no social grant) receives
//      nothing from a social DM addressed to her, while the same sender's DM
//      to u-mira (a social grant holder) is delivered — the grant rule, with
//      its control.
//   3. A reload replays the unread set (and keeps the read one read).
//
// The notification inbox is reset to its seed first (u-jonas and u-hr have
// no seeded rows) and the whole mock world is reset at the end. The replies
// themselves land on platform-api's comment threads, which the mock reset
// does not reach — the same as the parity spec's comments.

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const DOC = 'page:100002';
const PARENT = 'kc-rubric-01'; // u-jonas's comment on Rubric Overview (imported legacy thread)

async function signedIn(page: Page, userId: string) {
  await page.goto('/');
  await signIn(page, userId);
}

async function person(browser: Browser, baseURL: string | undefined, userId: string, path: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signedIn(page, userId);
  await page.goto(path);
  await expect(bell(page)).toBeVisible({ timeout: 20_000 });
  return { context, page, errors };
}

const bell = (page: Page) => page.getByTestId('activity-bell-button');

/** The socket connects after the header paints (token, then upgrade); give it a bounded moment. */
async function socketSettled(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
}

async function post(page: Page, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(async ({ path, body }) => {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }, { path, body });
}

async function reply(page: Page, text: string) {
  const result = await post(page, `/api/assessment/knowledge/doc/workflows/comments?id=${encodeURIComponent(DOC)}`, { text, parentCommentId: PARENT });
  expect(result.status, `reply posted: ${JSON.stringify(result.json)}`).toBe(201);
}

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/');
  const reset = await post(page, '/api/__mock/reset', { fixture: 'notifications' });
  expect(reset.status, 'notifications fixture reset').toBe(200);
  await context.close();
});

test.afterAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/');
  await post(page, '/api/__mock/reset', {});
  await context.close();
});

test("a reply reaches the author's bell without a reload", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const jonas = await person(browser, baseURL, 'u-jonas', '/assessment/teams');
  const farah = await person(browser, baseURL, 'u-farah', '/assessment/teams');
  await socketSettled(jonas.page);
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity');

  const text = `Adding the release-gate example now ${Date.now()}`;
  await reply(farah.page, text);
  // Within 2s, on the page as loaded.
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity, 1 unread', { timeout: 2_000 });
  await expect(jonas.page.getByTestId('activity-bell-badge')).toHaveText('1');

  await bell(jonas.page).click();
  const popover = jonas.page.getByTestId('activity-bell-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Farah Osei replied to your comment');
  await expect(popover).toContainText('Rubric Overview');
  await expect(popover).toContainText('Assessment');

  await popover.getByText('Farah Osei replied to your comment').click();
  await expect(jonas.page).toHaveURL(/\/assessment\/workspace\?doc=page%3A100002/);
  const shell = jonas.page.getByTestId('document-shell');
  await expect(shell).toBeVisible({ timeout: 20_000 });
  await expect(shell.getByRole('tab', { name: /^Comments/ })).toHaveAttribute('aria-selected', 'true');
  await expect(jonas.page.getByTestId('document-comments').getByText(text)).toBeVisible({ timeout: 20_000 });
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity');

  for (const p of [jonas, farah]) {
    expect(p.errors, 'page errors').toEqual([]);
    await p.context.close();
  }
});

test('a user with no social grant receives no social item', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const hr = await person(browser, baseURL, 'u-hr', '/');
  await socketSettled(hr.page);
  await expect(bell(hr.page)).toHaveAttribute('aria-label', 'Activity');

  // u-mira (community-admin) listens on a raw socket — the control: the DM
  // producer fires for a social grant holder in this very run.
  const miraCtx = await browser.newContext({ baseURL });
  const mira = await miraCtx.newPage();
  await signedIn(mira, 'u-mira');
  await mira.evaluate(async () => {
    const t = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string; gatewayUrl: string };
    const url = `${t.gatewayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
    const frames: unknown[] = [];
    (window as unknown as { __frames: unknown[] }).__frames = frames;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, ['bearer-token-v1', t.token]);
      ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('mira socket refused'));
    });
  });

  // u-sana (social participant) sends one DM to u-hr and one to u-mira.
  const sanaCtx = await browser.newContext({ baseURL });
  const sana = await sanaCtx.newPage();
  await signedIn(sana, 'u-sana');
  const me = await sana.evaluate(async () => (await fetch('/api/session/me', { credentials: 'include' })).json());
  expect(me.tenant, 'u-sana signs into the social tenant').toBe('social');
  const refused = await sana.evaluate(async () => {
    const t = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string; gatewayUrl: string };
    const url = `${t.gatewayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
    const ws = new WebSocket(url, ['bearer-token-v1', t.token]);
    const frames: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('sana socket refused')); });
    const until = async (pred: () => boolean) => { for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 50)); };
    for (const channel of ['social:dm:u-hr:u-sana', 'social:dm:u-mira:u-sana']) {
      ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
      await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'joined' && f['channel'] === channel));
      ws.send(JSON.stringify({ service: 'chat', action: 'send', channel, message: `Hello from Sana on ${channel}` }));
      await until(() => frames.some((f) => f['type'] === 'chat' && f['action'] === 'sent' && f['channel'] === channel));
    }
    return frames.filter((f) => f['type'] === 'error');
  });
  expect(refused, 'the DMs were accepted by the gateway').toEqual([]);

  // The control arrives…
  await expect.poll(async () => mira.evaluate(() => ((window as unknown as { __frames: Array<Record<string, unknown>> }).__frames)
    .filter((f) => f['type'] === 'notification:new').map((f) => (f['payload'] as { title: string; payload: { tenant: string } })))
  , { timeout: 5_000 }).toEqual([expect.objectContaining({ title: 'Sana Iqbal sent you a message', payload: expect.objectContaining({ tenant: 'social' }) })]);
  // …and u-hr's bell stays empty, through a reload too.
  await hr.page.waitForTimeout(1_000);
  await expect(bell(hr.page)).toHaveAttribute('aria-label', 'Activity');
  await hr.page.reload();
  await expect(bell(hr.page)).toBeVisible({ timeout: 20_000 });
  await socketSettled(hr.page);
  await expect(bell(hr.page)).toHaveAttribute('aria-label', 'Activity');
  await bell(hr.page).click();
  await expect(hr.page.getByTestId('activity-bell-empty')).toBeVisible();

  expect(hr.errors, 'page errors').toEqual([]);
  for (const c of [hr.context, miraCtx, sanaCtx]) await c.close();
});

test('a reload replays the unread set', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const jonas = await person(browser, baseURL, 'u-jonas', '/assessment/teams');
  const farah = await person(browser, baseURL, 'u-farah', '/assessment/teams');
  await socketSettled(jonas.page);
  // The first test's reply was read (server-side too), so this starts at 0.
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity');

  await reply(farah.page, `One more on the rubric ${Date.now()}`);
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity, 1 unread', { timeout: 2_000 });

  await jonas.page.reload();
  await expect(bell(jonas.page)).toBeVisible({ timeout: 20_000 });
  await expect(bell(jonas.page)).toHaveAttribute('aria-label', 'Activity, 1 unread', { timeout: 10_000 });
  await bell(jonas.page).click();
  const popover = jonas.page.getByTestId('activity-bell-popover');
  await expect(popover.getByText('Farah Osei replied to your comment')).toHaveCount(1);

  // A fresh context (no local read marks at all) sees the same unread set: the server holds it.
  const fresh = await person(browser, baseURL, 'u-jonas', '/assessment/teams');
  await expect(bell(fresh.page)).toHaveAttribute('aria-label', 'Activity, 1 unread', { timeout: 10_000 });

  for (const p of [jonas, farah, fresh]) {
    expect(p.errors, 'page errors').toEqual([]);
    await p.context.close();
  }
});
