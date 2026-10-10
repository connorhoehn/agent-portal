import { loginAs } from './realSession';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';
import { test, expect } from './cdpTest';

test.use({ viewport: { width: 1440, height: 900 },
  ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

// Each case gets fresh pages and sockets, while its real signed session can
// be reused within this worker. Repeated cases should not consume the login
// mutation rate limit or require an application fixture reset.
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
const ownedContexts = new Set<BrowserContext>();
test.afterEach(async () => { await Promise.all([...ownedContexts].map(context => context.close())); });

// Authentication, BFF persistence, canonical page resolution, call membership
// and WebSocket delivery are real. Only unavailable media-session metadata and
// receipts are substituted; these checks do not establish WebRTC acceptance.
async function person(browser: Browser, baseURL: string | undefined, userId: string, caller = true) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  ownedContexts.add(context); context.on('close', () => ownedContexts.delete(context));
  try {
  const mediaRequests: string[] = [], incoming: Record<string, unknown>[] = [], outgoing: Record<string, unknown>[] = [];
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, platformApiUrl: 'http://huddle-media.test', videoUrl: null } });
  });
  await context.route('http://huddle-media.test/**', async route => {
    const path = new URL(route.request().url()).pathname; mediaRequests.push(path);
    await route.fulfill({ status: 200, json: path.endsWith('/join') ? { participantId: `participant-${userId}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'huddle-signalling-only' } });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    const capture = (destination: Record<string, unknown>[], payload: string | Buffer) => {
      try { destination.push(JSON.parse(String(payload))); } catch { /* only structured gateway frames matter */ }
    };
    socket.on('framereceived', event => capture(incoming, event.payload));
    socket.on('framesent', event => capture(outgoing, event.payload));
  });
  const sessionKey = `${baseURL ?? ''}:${userId}`, cookies = sessions.get(sessionKey);
  if (cookies) await context.addCookies(cookies);
  else {
    await loginAs(context, userId, baseURL, true);
    sessions.set(sessionKey, await context.cookies());
  }
  const authority = await page.request.get('/api/session/me');
  expect(authority.status()).toBe(200); expect((await authority.json()).sub).toBe(userId);
  await page.goto('/iq/projects/p-auth-migration');
  await expect(page.getByTestId('initiative-header')).toBeVisible();
  if (caller) await expect(page.getByTestId('initiative-start-call')).toBeEnabled({ timeout: 15_000 });
  return { context, page, errors, incoming, outgoing, mediaRequests };
  } catch (error) { await context.close(); throw error; }
}

// The huddle chat is the shell's right split pane (HuddleChat.tsx). On the
// overview the footer's chat toggle focuses the page composer (Chat, To =
// huddle) instead, so these helpers open the pane from a page without one.
const huddlePane = (page: Page) => page.getByTestId('huddle-chat-panel');
const draft = (page: Page) => huddlePane(page).getByTestId('rich-chat-composer-input');
const sendButton = (page: Page) => huddlePane(page).getByTestId('rich-chat-composer-send');
async function closeHuddle(page: Page) {
  await page.locator('[data-testid="huddle-chat-panel-close"], [data-testid="huddle-chat-panel"] [data-testid="floating-panel-close"]').first().click();
}
async function openHuddle(page: Page) {
  await page.getByTestId('shell-call-dock-chat').click();
  if (await huddlePane(page).isVisible()) return;
  const back = page.url();
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByTestId('shell-call-dock-chat').click();
  await expect(huddlePane(page)).toBeVisible();
  await page.goBack(); await expect(page).toHaveURL(back);
}

async function connect(sender: Page, recipient: Page) {
  await sender.getByTestId('initiative-start-call').click();
  await recipient.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 15_000 });
  for (const page of [sender, recipient]) {
    await expect(page.getByTestId('shell-call-dock')).toBeVisible();
    await expect(page.getByTestId(/^(shell-)?call-dock-leave$/).first()).toBeVisible();
    await expect(page.getByTestId('shell-call-dock-chat')).toHaveCount(1);
    await openHuddle(page);
    await expect(page.getByTestId('huddle-chat-participants')).toContainText('Vera Green', { timeout: 15_000 });
    await expect(page.getByTestId('huddle-chat-error')).toHaveCount(0);
  }
  await draft(sender).fill('Readiness probe');
  await expect(sendButton(sender)).toBeEnabled({ timeout: 15_000 });
  await draft(sender).fill('');
}

async function leave(page: Page) {
  const dock = page.getByTestId('shell-call-dock');
  if (await dock.count()) {
    const button = dock.getByRole('button', { name: /Leave|Hang up/ }).first();
    if (await button.count()) await button.click();
  }
}
test('pane shows a Chat mode menu, participant @mentions, a live typing indicator and file attachments behind the formatting strip', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  try {
    await connect(rachel.page, vera.page);
    const pane = huddlePane(rachel.page);
    await expect(pane.getByTestId('huddle-chat-attach-page')).toBeVisible();
    // Files ride the gateway upload guard, which admits only current seats of
    // the call; the narrow pane folds the paperclip into the formatting strip.
    await pane.getByRole('button', { name: 'Show formatting' }).click();
    await expect(pane.getByRole('button', { name: /attach file|attachment/i })).toHaveCount(1);
    await pane.getByRole('button', { name: /Hide formatting|Show formatting/ }).click();
    await draft(vera.page).click();
    await draft(vera.page).pressSequentially('Checking the cut');
    await expect(pane.getByText(/Vera Green is typing/)).toBeVisible({ timeout: 10_000 });
    await rachel.page.screenshot({ path: 'qa/pane-polish-1440-typing.png' });
    await draft(vera.page).fill('');
    await expect(pane.getByText(/is typing/)).toHaveCount(0, { timeout: 10_000 });
    await draft(rachel.page).click();
    await draft(rachel.page).pressSequentially('Hi @Ver');
    await expect(rachel.page.getByText('Vera Green').last()).toBeVisible();
    await rachel.page.screenshot({ path: 'qa/pane-polish-1440-mention.png' });
    await draft(rachel.page).fill('');
    await rachel.page.setViewportSize({ width: 1024, height: 768 });
    await rachel.page.screenshot({ path: 'qa/pane-polish-1024.png' });
    await leave(rachel.page); await leave(vera.page);
  } finally { await rachel.context.close(); await vera.context.close(); }
});
