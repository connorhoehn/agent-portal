import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';

// Document conversation on the BFF's own realtime gateway (/ws): two
// assessment people on one document see each other's messages, attributed by
// the realtime token's display name — never by anything the client typed.
//
// Needs the offline stack (middleware `npm run dev:mock:social` on :3001,
// portal on :5183) with the gateway on. Skips otherwise, with the reason.
//
// Cleanup: the Chat panel offers no delete on this page (WrappedChatPanel is
// not handed onDeleteMessage), so each message is soft-deleted over the same
// /ws socket with the sender's own token — `{service:'chat', action:'delete'}`,
// author-only on the server. The record stays in history as `deleted`, which
// the panel does not render.

const DOC = 'page:100002';
const DOC_URL = `/assessment/workspace?doc=${encodeURIComponent(DOC)}`;
const CHANNEL = 'assessment:doc:page:100002';

/** GET /api/health with a few retries: a `tsx watch` restart of the middleware is a gap of a second or two, not an outage. */
async function gatewayHealth(request: APIRequestContext): Promise<{ realtime?: { gateway?: string } } | null> {
  for (let i = 0; i < 5; i++) {
    const body = await request.get('/api/health').then((r) => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
    if (body) return body;
    await new Promise((r) => setTimeout(r, 1_500));
  }
  return null;
}

type Person = { page: Page; context: BrowserContext; userId: string; name: string };

async function signIn(page: Page, userId: string): Promise<void> {
  await page.goto('/');
  const status = await page.evaluate(async (id: string) => (await fetch('/api/session/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ userId: id }),
  })).status, userId);
  expect(status, `demo login as ${userId}`).toBe(200);
}

/** The display name the gateway will stamp: the realtime token's own claim. */
async function tokenName(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string };
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { displayName: string };
    return payload.displayName;
  });
}

async function open(browser: Browser, userId: string): Promise<Person> {
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  const page = await context.newPage();
  await signIn(page, userId);
  const name = await tokenName(page);
  await page.goto(DOC_URL);
  await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('page-composer-input')).toBeVisible({ timeout: 20_000 });
  return { page, context, userId, name };
}

/**
 * Who a message is attributed to. Consecutive messages by one author are
 * grouped and only the first row of a group draws the author line, so this
 * reads the nearest author line at or above the message.
 */
async function authorOf(p: Person, text: string): Promise<string> {
  return p.page.getByTestId('document-chat-panel').getByTestId('chat-message').evaluateAll((els, needle) => {
    let author = '';
    for (const el of els) {
      const a = el.querySelector('[data-testid="message-row-author"]')?.textContent?.trim();
      if (a) author = a;
      if ((el.textContent ?? '').includes(needle)) return author;
    }
    return '';
  }, text);
}

/**
 * The Chat panel. It renders only while the context column is open on Chat:
 * the dock's own send opens it for the sender; everyone else opens it from
 * the column's icon rail (panel id 'chat', label "Chat").
 */
async function chatPanel(p: Person) {
  const panel = p.page.getByTestId('document-chat-panel');
  if (!(await panel.isVisible())) {
    await p.page.getByTestId('context-column-panel-chat').click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('document conversation', () => {
  let farah: Person;
  let jonas: Person;
  const sent: string[] = [];

  test.beforeAll(async ({ browser, request }) => {
    const health = await gatewayHealth(request);
    test.skip(!health || health.realtime?.gateway !== 'on', 'the :3001 middleware is unreachable or REALTIME_GATEWAY is not on (GET /api/health realtime.gateway) — start `npm run dev:mock:social`');
    farah = await open(browser, 'u-farah');
    jonas = await open(browser, 'u-jonas');
  });

  test.afterAll(async () => {
    // Delete every message this run posted, as its author, over the gateway.
    for (const p of [farah, jonas]) {
      if (!p) continue;
      const ids = await p.page.getByTestId('chat-message').evaluateAll((els) =>
        els.filter((el) => el.querySelector('[data-testid="message-row"]')?.getAttribute('data-mine') === 'true')
          .map((el) => ({ id: el.getAttribute('data-message-id') ?? '', text: el.textContent ?? '' })));
      const mine = ids.filter((m) => m.id && sent.some((s) => m.text.includes(s)));
      if (mine.length) {
        await p.page.evaluate(async ({ channel, ids: del }) => {
          const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string };
          await new Promise<void>((resolve) => {
            const ws = new WebSocket('ws://localhost:3001/ws', ['bearer-token-v1', token]);
            ws.onmessage = (ev) => {
              if (JSON.parse(String(ev.data)).type !== 'session') return;
              ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
              for (const id of del) ws.send(JSON.stringify({ service: 'chat', action: 'delete', channel, messageId: id }));
              setTimeout(() => { ws.close(); resolve(); }, 800);
            };
            ws.onerror = () => resolve();
            setTimeout(resolve, 5_000);
          });
        }, { channel: CHANNEL, ids: mine.map((m) => m.id) });
      }
    }
    await farah?.context.close();
    await jonas?.context.close();
  });

  test('a dock send appears in both Chat panels under the sender\'s token name, and a panel-composer reply flows back', async () => {
    const stamp = Date.now();

    // 1. Farah sends from the composer dock under the page.
    const fromDock = `e2e dock ${stamp}`;
    sent.push(fromDock);
    // The dock opens in Agent mode (parity goal, decision 8); pick Chat.
    const dock = farah.page.getByTestId('page-composer-dock');
    await dock.getByRole('button', { name: 'Agent', exact: true }).click();
    await dock.getByRole('button', { name: 'Composer mode: Agent' }).click();
    await farah.page.getByRole('menu', { name: 'Composer mode: Agent' }).getByRole('menuitem', { name: 'Chat', exact: true }).click();
    await farah.page.getByTestId('page-composer-input').click();
    await farah.page.keyboard.type(fromDock);
    await farah.page.keyboard.press('Enter');

    for (const who of [farah, jonas]) {
      const panel = await chatPanel(who);
      const message = panel.getByTestId('chat-message').filter({ hasText: fromDock });
      await expect(message, `${who.userId} sees the dock message`).toHaveCount(1, { timeout: 10_000 });
      expect(await authorOf(who, fromDock)).toBe(farah.name);
    }
    // Ownership is per viewer: mine for Farah, someone else's for Jonas.
    const row = (p: Person, text: string) => p.page.getByTestId('chat-message').filter({ hasText: text }).getByTestId('message-row');
    await expect(row(farah, fromDock)).toHaveAttribute('data-mine', 'true');
    await expect(row(jonas, fromDock)).toHaveAttribute('data-mine', 'false');

    // 2. Jonas answers from the Chat panel's own composer.
    const reply = `e2e panel reply ${stamp}`;
    sent.push(reply);
    const jonasPanel = await chatPanel(jonas);
    await jonasPanel.getByTestId('document-chat-composer-input').click();
    await jonas.page.keyboard.type(reply);
    await jonas.page.keyboard.press('Enter');

    for (const who of [jonas, farah]) {
      const panel = await chatPanel(who);
      const message = panel.getByTestId('chat-message').filter({ hasText: reply });
      await expect(message, `${who.userId} sees the panel reply`).toHaveCount(1, { timeout: 10_000 });
      expect(await authorOf(who, reply)).toBe(jonas.name);
    }
    expect(farah.name).not.toBe(jonas.name);
  });
});
