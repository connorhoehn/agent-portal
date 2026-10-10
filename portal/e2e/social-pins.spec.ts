import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs } from './realSession';

test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

async function person(browser: Browser, baseURL: string | undefined, userId: string, prepare?: (context: BrowserContext) => Promise<void>) {
  const { context, page, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, prepare, url: '/social/channels/general' });
  await expect(page.getByTestId('social-chat-composer-input')).toBeVisible();
  await expect(page.getByText('The realtime gateway is not connected', { exact: false })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('social-chat-composer-input')).toBeEditable({ timeout: 15_000 });
  return { page, context, errors };
}

async function reset(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage(); await page.goto('/');
    expect((await page.request.post('/api/__mock/reset', { data: {} })).status()).toBe(200);
  } finally { await context.close(); }
}

async function say(page: Page, text: string) {
  await page.getByTestId('social-chat-composer-input').click();
  await page.keyboard.type(text); await page.keyboard.press('Enter');
}
const message = (page: Page, text: string) => page.getByTestId('chat-message').filter({ hasText: text });
const pinned = (page: Page, text: string) => page.getByTestId('pinned-message').filter({ hasText: text });

test.beforeEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });
test.afterEach(async ({ browser, baseURL }) => { await reset(browser, baseURL); });

test('a shared pin arrives live, survives reload, jumps to the message, and another member can unpin it', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const mira = await person(browser, baseURL, 'u-mira');
  const sana = await person(browser, baseURL, 'u-sana');
  try {
    await sana.page.getByRole('tab', { name: /^Pinned\b/ }).click();
    await expect(sana.page.getByText('Nothing pinned yet')).toBeVisible();
    const text = `Community call agenda ${Date.now()}`;
    await say(mira.page, text);
    const row = message(mira.page, text);
    await expect(row).toHaveCount(1);
    await row.hover();
    await row.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    await expect(pinned(sana.page, text)).toBeVisible({ timeout: 3_000 });
    await expect(pinned(sana.page, text)).toContainText('pinned by Mira Okafor');
    const pins = await (await sana.page.request.get('/api/chat/pins?channel=social%3Ach%3Ageneral')).json();
    expect(pins.pins[0].pinnedBy).toBe('u-mira');
    expect(pins.pins[0].sentAt).toBeTruthy();
    await sana.page.reload();
    await expect(pinned(sana.page, text)).toBeVisible();
    await pinned(sana.page, text).getByRole('button', { name: 'Go to the pinned message from Mira Okafor' }).click();
    await expect(sana.page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(message(sana.page, text)).toBeVisible();
    await sana.page.getByRole('tab', { name: /^Pinned\b/ }).click();
    await sana.page.screenshot({ path: '/tmp/aws-agentcore-feature-pins/shared-pin.png', fullPage: true });
    await pinned(sana.page, text).getByRole('button', { name: 'Unpin', exact: true }).click();
    await expect(sana.page.getByText('Nothing pinned yet')).toBeVisible();
    await expect(row.getByTestId('pinned-marker')).toHaveCount(0, { timeout: 3_000 });
    expect(mira.errors).toEqual([]); expect(sana.errors).toEqual([]);
  } finally { await mira.context.close(); await sana.context.close(); }
});

test('a failed pin rolls back and keeps its explanation visible on the Pinned tab', async ({ browser, baseURL }) => {
  const mira = await person(browser, baseURL, 'u-mira');
  try {
    const text = `Check the release notes ${Date.now()}`;
    await say(mira.page, text);
    await mira.page.route('**/api/chat/pins', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"store unavailable"}' });
      else await route.continue();
    });
    const row = message(mira.page, text); await row.hover();
    await row.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    await expect(mira.page.getByText('Pinned messages are unavailable:', { exact: false })).toBeVisible();
    await expect(row.getByTestId('pinned-marker')).toHaveCount(0);
    await mira.page.getByRole('tab', { name: /^Pinned\b/ }).click();
    await expect(mira.page.getByText('Nothing pinned yet')).toBeVisible();
    await expect(mira.page.getByText('Pinned messages are unavailable:', { exact: false })).toBeVisible();
    expect(mira.errors).toEqual([]);
  } finally { await mira.context.close(); }
});

test('Jump retrieves a retained pinned original beyond 1,000 newer messages and explains the history gap', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const mira = await person(browser, baseURL, 'u-mira');
  const channel = 'social:ch:general';
  try {
    const text = `Retained community decision ${Date.now()}`;
    await say(mira.page, text);
    const original = message(mira.page, text);
    await expect(original).toHaveCount(1);
    const messageId = await original.getAttribute('data-message-id');
    expect(messageId).toBeTruthy();
    await original.hover();
    await original.getByRole('button', { name: 'Pin to channel', exact: true }).click();
    await mira.page.getByRole('tab', { name: /^Pinned\b/ }).click();
    await expect(pinned(mira.page, text)).toBeVisible();

    // Every newer row goes through the authenticated real chat service and
    // its persisted "sent" acknowledgement. No fixture mutation or fake
    // browser response can make an older-message regression appear to pass.
    const seeded = await mira.page.evaluate(async ({ channel, messageId, prefix }) => {
      const tokenResponse = await fetch('/api/session/realtime-token', { credentials: 'include' });
      if (!tokenResponse.ok) throw new Error(`Realtime token unavailable (${tokenResponse.status})`);
      const token = await tokenResponse.json() as { token: string; gatewayUrl: string };
      const ws = new WebSocket(`${token.gatewayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws`, ['bearer-token-v1', token.token]);
      type Frame = { type?: string; action?: string; channel?: string; messageId?: string; error?: string; messages?: Array<{ id: string }> };
      let pending: { action: string; resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
      const fail = (error: Error) => {
        if (!pending) return;
        clearTimeout(pending.timer); pending.reject(error); pending = null;
      };
      ws.onmessage = event => {
        const frame = JSON.parse(String(event.data)) as Frame;
        if (frame.type === 'error') { fail(new Error(frame.error ?? 'The chat service refused a history seed')); return; }
        if (!pending || frame.type !== 'chat' || frame.channel !== channel || frame.action !== pending.action) return;
        clearTimeout(pending.timer); pending.resolve(frame); pending = null;
      };
      ws.onclose = () => fail(new Error('The seed socket closed before acknowledgement'));
      ws.onerror = () => fail(new Error('The seed socket failed'));
      const command = (frame: Record<string, unknown>, action: string) => new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error(`Timed out waiting for ${action}`)), 10_000);
        pending = { action, resolve, reject, timer };
        ws.send(JSON.stringify({ service: 'chat', channel, ...frame }));
      });
      try {
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('The seed socket was refused')); });
        await command({ action: 'join' }, 'joined');
        let sent = 0;
        for (let index = 0; index < 1_001; index++) {
          const acknowledgement = await command({ action: 'send', message: `${prefix} ${index}` }, 'sent');
          if (!acknowledgement.messageId) throw new Error('A persisted message acknowledgement had no id');
          sent += 1;
        }
        const history = await command({ action: 'history', limit: 1_000 }, 'history');
        return { sent, historyCount: history.messages?.length ?? 0, includesOriginal: history.messages?.some(row => row.id === messageId) ?? false };
      } finally { ws.close(); }
    }, { channel, messageId: messageId!, prefix: `More recent conversation ${Date.now()}` });
    expect(seeded).toEqual({ sent: 1_001, historyCount: 1_000, includesOriginal: false });

    await mira.page.reload();
    await expect(pinned(mira.page, text)).toBeVisible();
    await mira.page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await expect(mira.page.getByTestId('chat-message').first()).toBeVisible();
    await expect(message(mira.page, text)).toHaveCount(0);
    await mira.page.getByRole('tab', { name: /^Pinned\b/ }).click();
    const retrieved = mira.page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === '/api/chat/message'
        && url.searchParams.get('channel') === channel && url.searchParams.get('messageId') === messageId;
    });
    await pinned(mira.page, text).getByRole('button', { name: 'Go to the pinned message from Mira Okafor' }).click();
    const response = await retrieved;
    expect(response.status()).toBe(200);
    expect((await response.json()).message).toMatchObject({ id: messageId, channel, message: text, userId: 'u-mira' });
    await expect(mira.page.getByRole('tab', { name: 'Chat', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(message(mira.page, text)).toBeVisible();
    await expect(mira.page.getByText('Showing the pinned message alongside the latest conversation. Messages between them are not loaded.', { exact: true })).toBeVisible();
    await expect(mira.page.getByText('This pinned message is no longer in the available chat history.', { exact: true })).toHaveCount(0);
    await mira.page.screenshot({ path: '/tmp/aws-agentcore-subagents/pins-old-message-jump.png', fullPage: true });
    expect(mira.errors).toEqual([]);
  } finally { await mira.context.close(); }
});

test('a real server rejection retains the composer draft and an untouched retry succeeds', async ({ browser, baseURL }) => {
  const channel = 'social:ch:general';
  const outbound: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  let injections = 0;
  const mira = await person(browser, baseURL, 'u-mira', async context => {
    await context.routeWebSocket('**/ws', socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.service === 'chat' && frame.action === 'send' && frame.channel === channel) {
          outbound.push(frame);
          if (injections === 0) {
            // Fault injection changes one outgoing request only. The actual
            // authenticated service supplies the rejection; the retry and
            // every other request reach it unchanged.
            injections += 1;
            server.send(JSON.stringify({ ...frame, message: '' }));
            return;
          }
        }
        server.send(raw);
      });
      server.onMessage(raw => {
        received.push(JSON.parse(String(raw)) as Record<string, unknown>);
        socket.send(raw);
      });
    });
  });
  try {
    const text = `Keep this draft after rejection ${Date.now()}`;
    const composer = mira.page.getByTestId('social-chat-composer-input');
    await expect(mira.page.getByTestId('chat-message').first()).toBeVisible();
    const initialRows = await mira.page.getByTestId('chat-message').count();
    await say(mira.page, text);
    const explanation = mira.page.getByText('A message needs text or an attachment', { exact: true });
    await expect(explanation).toBeVisible();
    expect(injections).toBe(1);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toMatchObject({ channel, message: text });
    expect(received).toContainEqual(expect.objectContaining({
      type: 'error', service: 'chat', error: expect.objectContaining({ message: 'A message needs text or an attachment' }),
    }));
    expect(received.filter(frame => frame.type === 'chat' && frame.action === 'sent' && frame.channel === channel)).toHaveLength(0);
    await expect(composer).toHaveText(text);
    await expect(message(mira.page, text)).toHaveCount(0);
    await expect(mira.page.getByTestId('chat-message')).toHaveCount(initialRows);
    await mira.page.screenshot({ path: '/tmp/aws-agentcore-subagents/pins-rejected-send.png', fullPage: true });

    await expect(composer).toBeEditable();
    await composer.press('Enter');
    await expect(message(mira.page, text)).toHaveCount(1);
    await expect(composer).toHaveText('');
    await expect(explanation).toHaveCount(0);
    expect(injections).toBe(1);
    expect(outbound).toHaveLength(2);
    expect(outbound[1]).toMatchObject({ channel, message: text });
    expect(received.filter(frame => frame.type === 'chat' && frame.action === 'sent' && frame.channel === channel)).toHaveLength(1);
    expect(mira.errors).toEqual([]);
  } finally { await mira.context.close(); }
});
