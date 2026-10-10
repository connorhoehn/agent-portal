import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { chooseComposerMode } from './conversationViews';
import { openAs } from './realSession';

// The "new messages" divider (portal/src/hooks/useUnreadBoundary.ts), against the shared app
// (http://127.0.0.1:5183, BFF gateway on /ws, no fixtures, no mock reset). One reader reads the
// thread; someone else posts; the reader opens it again: the library's separator sits directly
// above the first new message and the cursor advances (a further open shows no divider).
//   1. social #general: u-sana reads, u-lena posts, Sana reopens.
//   2. assessment team Discussion (TEAM-005), 3. an initiative Discussion (p-auth-migration) and
//      4. a pipelines run thread: open page discussions with no member list. Since realtime-modules
//      0.115 the gateway keeps a read cursor per CURRENT reader there (`receipts` frame: enabled,
//      mode readers; lib/page-thread-unread.ts), so the same flow draws the divider — and while the
//      reader is away, GET /api/discussions/unread counts the two new messages server-side (the
//      rail door and palette badge), clearing once the thread is read.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close())); });

type Probe = { page: Page; errors: string[] };
const SEPARATOR = '[data-testid="chat-unread-separator"]';

async function signedIn(browser: Browser, baseURL: string | undefined, userId: string, tenant: string): Promise<Probe> {
  const { context, page, errors } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, landing: null, consoleErrors: true, expectTenant: tenant });
  contexts.push(context);
  return { page, errors };
}

/** `composer`: a test id, or a CSS selector (`[data-testid=…] …`) for an input inside a page composer. */
const input = (page: Page, composer: string) => composer.startsWith('[') ? page.locator(composer) : page.getByTestId(composer);

async function open(page: Page, url: string, panel: string, composer: string) {
  await page.goto(url);
  await expect(input(page, composer)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId(panel).getByText(/gateway is not connected/i)).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(2_500); // history + receipts frames settle, the read cursor advances
}

async function say(page: Page, composer: string, text: string, dock?: string) {
  // A page composer with Chat | Agent (the initiative's, docked in the content column): Chat → the Discussion.
  if (dock && await page.getByTestId(dock).getByRole('button', { name: 'Composer mode: Agent', exact: true }).isVisible().catch(() => false)) {
    await chooseComposerMode(page, page.getByTestId(dock), 'Agent', 'Chat');
  }
  await input(page, composer).click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

type Unread = { threads?: Array<{ channel: string; unreadCount: number; section: string }> };
async function unreadCount(page: Page, channel: string): Promise<number> {
  const body = (await (await page.request.get('/api/discussions/unread')).json()) as Unread;
  return body.threads?.find(t => t.channel === channel)?.unreadCount ?? 0;
}

async function scenario(browser: Browser, baseURL: string | undefined, o: { reader: string; poster: string; tenant: string; url: string; panel: string; composer: string; channel?: string; dock?: string }) {
  const reader = await signedIn(browser, baseURL, o.reader, o.tenant);
  const receiptFrames: Array<Record<string, unknown>> = [];
  reader.page.on('websocket', ws => ws.on('framereceived', e => { try { const f = JSON.parse(String(e.payload)); if (f.type === 'chat' && f.action === 'receipts') receiptFrames.push(f); } catch { /* not json */ } }));
  const poster = await signedIn(browser, baseURL, o.poster, o.tenant);
  await open(poster.page, o.url, o.panel, o.composer);
  const stamp = Date.now();
  // Make sure there is something for the reader to have read (a divider needs an older message above it).
  await say(poster.page, o.composer, `earlier note ${stamp}`, o.dock);
  await open(reader.page, o.url, o.panel, o.composer);
  await expect(reader.page.getByTestId(o.panel).getByText(`earlier note ${stamp}`)).toBeVisible({ timeout: 15_000 });
  // (A divider on this first open is legitimate when an earlier run left unread messages; it is not asserted.)
  await reader.page.goto('about:blank'); // the reader leaves; its cursor is the earlier note

  await new Promise(r => setTimeout(r, 1_200));
  const first = `first unseen ${stamp}`, second = `second unseen ${stamp}`;
  await say(poster.page, o.composer, first, o.dock);
  await expect(poster.page.getByText(first)).toBeVisible({ timeout: 10_000 });
  await say(poster.page, o.composer, second, o.dock);
  await expect(poster.page.getByText(second)).toBeVisible({ timeout: 10_000 });

  // A page discussion: the reader's badge is the server's count of what they have not read.
  if (o.channel) await expect.poll(() => unreadCount(reader.page, o.channel!), { timeout: 15_000 }).toBe(2);

  await open(reader.page, o.url, o.panel, o.composer);
  const panel = reader.page.getByTestId(o.panel);
  await expect(panel.getByText(second)).toBeVisible({ timeout: 15_000 });
  if (o.channel) {
    const mine = receiptFrames.filter(f => f.channel === o.channel);
    expect(mine.length, JSON.stringify(receiptFrames)).toBeGreaterThan(0);
    expect(mine.every(f => f.enabled === true && f.mode === 'readers'), JSON.stringify(mine[0])).toBe(true);
  }
  const separator = reader.page.locator(SEPARATOR);
  await expect(separator).toHaveCount(1);
  // The divider sits directly above the FIRST new message, not above the second and not above the old note.
  const order = await panel.evaluate((root, args) => {
    const all = [...root.querySelectorAll('[data-testid="chat-unread-separator"], [data-testid="chat-message"]')];
    const label = (el: Element) => el.getAttribute('data-testid') === 'chat-unread-separator' ? 'DIVIDER' : (el.textContent ?? '').includes(args.first) ? 'FIRST' : (el.textContent ?? '').includes(args.second) ? 'SECOND' : (el.textContent ?? '').includes(args.old) ? 'OLD' : 'other';
    return all.map(label);
  }, { first, second, old: `earlier note ${stamp}` });
  const at = order.indexOf('DIVIDER');
  expect(order[at + 1], JSON.stringify(order)).toBe('FIRST');
  expect(order.indexOf('SECOND')).toBeGreaterThan(at);
  expect(order.indexOf('OLD')).toBeLessThan(at);

  // The cursor advanced: the next open has nothing unread.
  await reader.page.waitForTimeout(1_500);
  await open(reader.page, o.url, o.panel, o.composer);
  await expect(reader.page.getByTestId(o.panel).getByText(second)).toBeVisible({ timeout: 15_000 });
  await expect(reader.page.locator(SEPARATOR)).toHaveCount(0);
  if (o.channel) await expect.poll(() => unreadCount(reader.page, o.channel!), { timeout: 10_000 }).toBe(0);
  expect(reader.errors).toEqual([]); expect(poster.errors).toEqual([]);
}

test('social #general: the divider sits above Lena\'s first new message and the cursor advances', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  await scenario(browser, baseURL, { reader: 'u-sana', poster: 'u-lena', tenant: 'social', url: '/social/channels/general', panel: 'social-chat-panel', composer: 'social-chat-composer-input' });
});

test('assessment team Discussion: the divider sits above Jonas\'s first new message and the cursor advances', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  // The team Discussion is the scorecard's right pane (the thread); off Certification (Improvement Plan) its one
  // input is the team composer docked in the content column (2.438.3) — the only composer on screen.
  await scenario(browser, baseURL, { reader: 'u-asha', poster: 'u-jonas', tenant: 'assessment', url: '/assessment/teams/TEAM-005?tab=plan',
    panel: 'scope-discussion-panel', composer: '[data-testid="team-discussion-composer"] [data-testid="rich-chat-composer-input"]', channel: 'assessment:team:TEAM-005' });
});

test('initiative Discussion: a member reads, an SME posts, the divider and cursor follow', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  // The thread is the right pane; the one input is the initiative composer in the content column (Chat → the Discussion).
  await scenario(browser, baseURL, { reader: 'u-rachel', poster: 'u-nora', tenant: 'orgiq', url: '/iq/projects/p-auth-migration',
    panel: 'scope-discussion-panel', composer: '[data-testid="initiative-composer"] [data-testid="rich-chat-composer-input"]', channel: 'orgiq:initiative:p-auth-migration', dock: 'initiative-composer' });
});

test('pipelines run thread: an author reads, an operator posts, the divider and cursor follow', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const boot = await signedIn(browser, baseURL, 'u-kofi', 'pipelines');
  const runs = (await (await boot.page.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
  expect(runs.length).toBeGreaterThan(0);
  const id = runs[0]!.id;
  await scenario(browser, baseURL, { reader: 'u-ines', poster: 'u-kofi', tenant: 'pipelines', url: `/pipelines/runs/${encodeURIComponent(id)}`,
    panel: 'pipeline-discussion-panel', composer: 'pipeline-discussion-panel-composer-input', channel: `pipelines:run:${id}` });
});
