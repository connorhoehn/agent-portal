import { test, expect, type Browser, type Page } from '@playwright/test';

// The S1 walk (docs/social-tenant-goal.md phase S1; docs/social-tenant-design.md
// §4.2–§4.5): channels and DMs on the social tenant, two browser contexts, one
// per user, against the shared dev:mock stack (PARITY_BASE_URL when not :5183).
//
//   1. u-mira (community-admin) posts in #general from its composer; u-sana
//      (participant), on the same channel in another context, reads it within
//      2s without a reload — and again after a reload (it was stored).
//   2. u-sana opens a DM with u-mira through "New message"; her message
//      arrives in u-mira's copy of the DM live, and u-mira's reply comes back.
//   3. u-theo — a #general MEMBER, but standing in orgiq — hand-builds a
//      subscribe to social:ch:general on /ws with his orgiq realtime token:
//      the gateway answers AUTHZ_CHANNEL_DENIED and no message of the channel
//      reaches him. The tenant rule is asked before membership.
//
// The mock world is reset first and last (POST /api/__mock/reset), so the
// posted messages do not outlive the run.

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, userId: string) {
  await page.goto('/');
  let status = 0;
  for (let attempt = 0; attempt < 2 && status !== 200; attempt += 1) {
    if (attempt) await page.waitForTimeout(10_000); // a middleware edit restarts tsx watch
    status = await page.evaluate(async (id) => (await fetch('/api/session/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ userId: id }),
    })).status, userId);
  }
  expect(status, `demo login as ${userId}`).toBe(200);
}

type Person = { context: Awaited<ReturnType<Browser['newContext']>>; page: Page; errors: string[] };

async function person(browser: Browser, baseURL: string | undefined, userId: string, path: string, ready: string): Promise<Person> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page, userId);
  const me = await page.evaluate(async () => (await fetch('/api/session/me', { credentials: 'include' })).json());
  expect(me.tenant, `${userId} stands in the social tenant`).toBe('social');
  await page.goto(path);
  await expect(page.getByTestId(ready)).toBeVisible({ timeout: 20_000 });
  return { context, page, errors };
}

async function post(page: Page, path: string, body: unknown): Promise<number> {
  return page.evaluate(async ({ path, body }) => (await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body),
  })).status, { path, body });
}

async function resetWorld(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto('/');
  expect(await post(page, '/api/__mock/reset', {}), 'mock reset').toBe(200);
  await context.close();
}

/** The composer is ready once the socket is up (it is disabled while offline). */
async function composerReady(page: Page) {
  const input = page.getByTestId('social-chat-composer-input');
  await expect(input).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('social-chat-panel').getByText('The realtime gateway is not connected')).toHaveCount(0, { timeout: 15_000 });
  return input;
}

async function say(page: Page, text: string) {
  const input = await composerReady(page);
  await input.click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const message = (page: Page, text: string) => page.getByTestId('social-chat-panel').getByTestId('chat-message').filter({ hasText: text });

test.beforeAll(async ({ browser, baseURL }) => { await resetWorld(browser, baseURL); });
test.afterAll(async ({ browser, baseURL }) => { await resetWorld(browser, baseURL); });

test('a channel message posted in one context arrives in the other', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const mira = await person(browser, baseURL, 'u-mira', '/social/channels/general', 'social-channels-page');
  const sana = await person(browser, baseURL, 'u-sana', '/social/channels/general', 'social-channels-page');
  await composerReady(mira.page);
  await composerReady(sana.page);
  // The rail lists the directory; #general is open in both.
  await expect(sana.page.getByTestId('social-channel-rail').locator('[data-testid="conversation-row"][data-channel="social:ch:general"]')).toBeVisible();

  const text = `Agenda for Thursday is up ${Date.now()}`;
  await say(mira.page, text);
  await expect(message(mira.page, text)).toHaveCount(1, { timeout: 5_000 });
  // Within 2s, on the page as loaded.
  await expect(message(sana.page, text)).toHaveCount(1, { timeout: 2_000 });

  // Stored, not just relayed: a reload reads it back from history.
  await sana.page.reload();
  await composerReady(sana.page);
  await expect(message(sana.page, text)).toHaveCount(1, { timeout: 10_000 });

  for (const p of [mira, sana]) {
    expect(p.errors, 'page errors').toEqual([]);
    await p.context.close();
  }
});

test('a direct message round trip', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const sana = await person(browser, baseURL, 'u-sana', '/social/dms', 'social-dms-page');
  const lobby = 'social:dm:u-mira:u-sana';
  const mira = await person(browser, baseURL, 'u-mira', `/social/dms/${encodeURIComponent(lobby)}`, 'social-dms-page');
  await composerReady(mira.page);

  // Sana starts the DM from "New message" and the roster picker.
  await sana.page.getByTestId('social-new-dm').click();
  const picker = sana.page.getByTestId('social-dm-picker');
  await expect(picker).toBeVisible();
  await picker.getByPlaceholder(/Search people/).fill('Mira');
  await picker.getByRole('button', { name: /Mira Okafor/ }).first().click();
  await expect(sana.page).toHaveURL(new RegExp(`/social/dms/${encodeURIComponent(lobby)}$`), { timeout: 10_000 });

  const hello = `Hi Mira, quick question about the call ${Date.now()}`;
  await say(sana.page, hello);
  await expect(message(mira.page, hello)).toHaveCount(1, { timeout: 2_000 });

  const answer = `Sure — ask away ${Date.now()}`;
  await say(mira.page, answer);
  await expect(message(sana.page, answer)).toHaveCount(1, { timeout: 2_000 });

  // The conversation is in Sana's list now (the conversations index).
  await sana.page.reload();
  await expect(sana.page.getByTestId('social-dm-rail').locator(`[data-testid="conversation-row"][data-channel="${lobby}"]`)).toBeVisible({ timeout: 10_000 });

  for (const p of [mira, sana]) {
    expect(p.errors, 'page errors').toEqual([]);
    await p.context.close();
  }
});

test('a forged cross-tenant subscribe is refused with AUTHZ_CHANNEL_DENIED', async ({ browser, baseURL }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await signIn(page, 'u-theo');
  const me = await page.evaluate(async () => (await fetch('/api/session/me', { credentials: 'include' })).json());
  // u-theo holds a social participant grant and is a #general member, but this session stands in orgiq.
  expect(me.tenant).toBe('orgiq');
  expect(me.grants.social).toEqual(['participant']);

  const result = await page.evaluate(async () => {
    const t = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string; gatewayUrl: string };
    const url = `${t.gatewayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`;
    const ws = new WebSocket(url, ['bearer-token-v1', t.token]);
    const frames: Array<Record<string, unknown>> = [];
    ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('socket refused')); });
    const until = async (pred: () => boolean) => { for (let i = 0; i < 60 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 50)); };
    const channel = 'social:ch:general';
    ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
    ws.send(JSON.stringify({ service: 'chat', action: 'history', channel, limit: 20 }));
    ws.send(JSON.stringify({ service: 'presence', action: 'subscribe', channel }));
    await until(() => frames.filter((f) => f['code'] === 'AUTHZ_CHANNEL_DENIED').length >= 3);
    await new Promise((r) => setTimeout(r, 300));
    ws.close();
    return {
      denied: frames.filter((f) => f['type'] === 'error' && f['code'] === 'AUTHZ_CHANNEL_DENIED').map((f) => `${String(f['service'])}/${String(f['kind'])}:${String(f['channel'])}`),
      leaked: frames.filter((f) => f['type'] === 'chat' && (f['action'] === 'history' || f['action'] === 'message' || f['action'] === 'joined')).length,
    };
  });
  expect(result.denied).toEqual(expect.arrayContaining(['chat/subscribe:social:ch:general', 'presence/subscribe:social:ch:general']));
  expect(result.leaked, 'no #general history or message reached the orgiq session').toBe(0);
  await context.close();
});
