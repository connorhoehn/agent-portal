import { loginAs } from './realSession';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './cdpTest';
import { chooseComposerMode } from './conversationViews';
import { chooseOption, optionValues } from './selectOption';

test.use({ viewport: { width: 1440, height: 900 }, baseURL: process.env.PARITY_BASE_URL ?? 'http://localhost:5261' });
test.describe.configure({ mode: 'serial' });
const contexts = new Set<BrowserContext>();
test.afterEach(async () => { await Promise.all([...contexts].map(context => context.close())); });
const DM = 'social:dm:u-rachel:u-vera';

// Real signed sessions, source authority, canonical DM receipts, Dynamo history
// and gateway delivery. Only unavailable platform-media receipts are inert.
async function actor(browser: Browser, baseURL: string | undefined, userId: string, holdAck?: (release: () => void) => boolean) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  contexts.add(context); context.on('close', () => contexts.delete(context));
  if (holdAck) await context.routeWebSocket('**/ws', socket => {
    const upstream = socket.connectToServer();
    upstream.onMessage(message => {
      let frame: Record<string, unknown> | null = null;
      try { frame = JSON.parse(String(message)); } catch { /* forward non-chat frames */ }
      if (frame?.type === 'chat' && frame.action === 'sent' && holdAck(() => socket.send(message))) return;
      socket.send(message);
    });
  });
  const media: string[] = [], incoming: Record<string, unknown>[] = [], outgoing: Record<string, unknown>[] = [], errors: string[] = [];
  await context.route('**/api/session/realtime-token', async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, platformApiUrl: 'http://embedded-media.test', videoUrl: null } });
  });
  await context.route('http://embedded-media.test/**', async route => {
    const path = new URL(route.request().url()).pathname; media.push(path);
    await route.fulfill({ json: path.endsWith('/join') ? { participantId: `participant-${userId}`, token: null }
      : path.endsWith('/end') ? { ok: true } : { sessionId: 'embedded-signalling-only' } });
  });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    const capture = (into: Record<string, unknown>[], payload: string | Buffer) => {
      try { into.push(JSON.parse(String(payload))); } catch { /* gateway JSON only */ }
    };
    socket.on('framereceived', event => capture(incoming, event.payload));
    socket.on('framesent', event => capture(outgoing, event.payload));
  });
  // Workspace selection revokes the previous context epoch. Each isolated
  // actor starts a new signed session instead of reusing a stale cookie.
  await loginAs(context, userId, baseURL, true);
  await page.goto('/iq/projects/p-auth-migration');
  await expect(page.getByTestId('initiative-header')).toBeVisible();
  await expect(page.getByTestId('shell-social-open')).toBeVisible();
  await expect.poll(async () => (await (await page.request.get('/api/session/me')).json()).sub).toBe(userId);
  return { page, context, media, incoming, outgoing, errors };
}
// The huddle chat is the shell's right split pane. On the overview the
// footer's chat toggle focuses the page composer (Chat, To = huddle), so the
// pane is opened from a page without one and stays open across navigation.
async function openHuddle(page: Page) {
  await page.getByTestId('shell-call-dock-chat').click();
  if (!await page.getByTestId('huddle-chat-panel').isVisible()) {
    const back = page.url();
    await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
    await page.getByTestId('shell-call-dock-chat').click();
    await page.goBack(); await expect(page).toHaveURL(back);
  }
  await expect(page.getByTestId('huddle-chat-panel-subtitle')).toContainText('2 participants', { timeout: 15_000 });
  await expect(page.getByTestId('huddle-chat-participants')).toContainText('Vera Green');
}

async function panel(page: Page, peerId: string, name: string) {
  const receipt = await page.request.post('/api/social/dms', { data: { userId: peerId } });
  expect(receipt.status()).toBe(200); expect((await receipt.json()).channel).toBe(DM);
  await page.getByTestId('shell-social-open').click({ modifiers: ['Alt'] });
  const opened = page.getByTestId('embedded-social-panel');
  await opened.getByTestId('embedded-social-refresh').click();
  await opened.getByTestId('embedded-social-rail').getByText(name, { exact: true }).click();
  await expect(opened.getByTestId('social-chat-composer-input')).toBeEditable();
  return opened;
}
async function composer(page: Page) {
  await page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
  const dock = page.getByTestId('initiative-composer');
  await chooseComposerMode(page, dock, 'Agent', 'Chat');
  const target = dock.getByRole('combobox', { name: 'Chat recipient' });
  await expect.poll(() => optionValues(target)).toContain('person:u-vera');
  await chooseOption(target, 'person:u-vera');
  return { dock, target, input: dock.getByTestId('rich-chat-composer-input'), send: dock.getByTestId('rich-chat-composer-send') };
}
async function leave(page: Page) {
  const button = page.getByTestId('shell-call-dock').getByRole('button', { name: /Leave|Hang up/ }).first();
  if (await button.count()) await button.click();
}

test('To-person uses the canonical DM, delivers live and replays without changing source or writing Discussion', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await actor(browser, baseURL, 'u-rachel'), vera = await actor(browser, baseURL, 'u-vera');
  const recipient = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
  const senderPanel = await panel(rachel.page, 'u-vera', 'Vera Green');
  await senderPanel.getByTestId('social-chat-composer-input').fill('Independent Social panel draft');
  await senderPanel.getByTestId('floating-panel-close').click();
  const editor = await composer(rachel.page), before = rachel.page.url(), marker = `To Vera persisted ${Date.now()}`;
  await editor.dock.getByTestId('rich-chat-composer-references').getByRole('button', { name: /Remove .* from this draft/ }).click();
  await expect(editor.dock.getByTestId('rich-chat-composer-references')).toHaveCount(0);
  await editor.input.fill(marker);
  const receipt = rachel.page.waitForResponse(response => response.url().endsWith('/api/social/dms') && response.request().method() === 'POST');
  await editor.send.click();
  const canonical = await receipt; expect(canonical.status()).toBe(200);
  expect(canonical.request().postDataJSON()).toEqual({ userId: 'u-vera' });
  expect((await canonical.json()).channel).toBe(DM);
  await expect(editor.input).toHaveText(''); await expect(recipient).toContainText(marker);
  const delivered = vera.incoming.find(frame => frame.type === 'chat' && frame.action === 'message' && (frame.message as { message?: string })?.message === marker);
  expect(delivered?.channel).toBe(DM); expect(delivered?.message).toMatchObject({ userId: 'u-rachel' });
  expect((delivered?.message as { metadata?: unknown }).metadata).not.toHaveProperty('pageReference');
  await expect(rachel.page).toHaveURL(before);
  const session = await rachel.page.request.get('/api/session/me'); expect((await session.json()).tenant).toBe('orgiq');
  const discussion = await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments');
  expect(discussion.status()).toBe(200); expect(JSON.stringify(await discussion.json())).not.toContain(marker);
  await rachel.page.getByTestId('shell-social-open').click({ modifiers: ['Alt'] });
  await expect(senderPanel.getByTestId('social-chat-composer-input')).toHaveText('Independent Social panel draft');
  await vera.page.reload(); await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
  await expect(vera.page.getByTestId('embedded-social-panel')).toContainText(marker);
  expect(rachel.outgoing.filter(frame => frame.service === 'chat' && frame.action === 'send' && frame.message === marker)).toHaveLength(1);
  expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
});

test('To-person page attachments resolve canonically for peers and survive reload independently of the shared huddle page', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rachel = await actor(browser, baseURL, 'u-rachel'), vera = await actor(browser, baseURL, 'u-vera');
  try {
    await rachel.page.getByTestId('initiative-start-call').click();
    await vera.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 15_000 });
    await expect(rachel.page.getByTestId('shell-call-dock')).toBeVisible();
    await openHuddle(rachel.page);
    const callId = String(rachel.incoming.find(frame => frame.type === 'call-chat' && frame.action === 'members')?.callId);
    const prior = await (await rachel.page.request.get(`/api/calls/${callId}/page`)).json();
    const pinned = await rachel.page.request.put(`/api/calls/${callId}/page`, { data: { expectedRevision: prior.revision,
      page: { kind: 'initiative', id: 'p-auth-migration' } } });
    expect(pinned.status()).toBe(200); const snapshot = await pinned.json();
    await rachel.page.getByTestId('huddle-chat-panel-close').click();
    const recipient = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
    const editor = await composer(rachel.page), before = rachel.page.url(), marker = `DM canonical work ${Date.now()}`;
    await expect(editor.dock.getByTestId('rich-chat-composer-references')).toHaveCount(1);
    await editor.input.fill(marker); await editor.send.click(); await expect(editor.input).toHaveText('');
    const row = recipient.locator('[data-message-id]').filter({ hasText: marker });
    await expect(row.getByTestId('dm-page-reference-open')).toHaveText('Logout leaves the legacy shim cookie alive');
    const frame = vera.incoming.find(frame => frame.type === 'chat' && frame.action === 'message' && (frame.message as { message?: string })?.message === marker);
    expect((frame?.message as { metadata?: Record<string, unknown> })?.metadata?.pageReference).toEqual({ kind: 'work-item', id: 'wi-auth-e2-b3' });
    expect(JSON.stringify(frame)).not.toContain('Logout leaves the legacy shim cookie alive');
    await expect(rachel.page).toHaveURL(before);
    expect(await (await rachel.page.request.get(`/api/calls/${callId}/page`)).json()).toEqual(snapshot);
    expect(JSON.stringify(await (await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments')).json())).not.toContain(marker);
    await row.getByTestId('dm-page-reference-open').click();
    await expect(vera.page).toHaveURL(/\/iq\/projects\/p-auth-migration\?tab=work&item=wi-auth-e2-b3$/);
    await expect(vera.page.getByTestId('shell-call-dock')).toHaveCount(1);
    expect(vera.media.filter(path => path.endsWith('/join'))).toHaveLength(1);
    await leave(rachel.page); await leave(vera.page);
    await vera.page.reload(); const reloaded = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
    await expect(reloaded.locator('[data-message-id]').filter({ hasText: marker }).getByTestId('dm-page-reference-open')).toHaveText('Logout leaves the legacy shim cookie alive');
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally { await leave(rachel.page); await leave(vera.page); }
});

test('a Social workspace reader opens an attached Org page through explicit workspace selection', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const rachel = await actor(browser, baseURL, 'u-rachel'), vera = await actor(browser, baseURL, 'u-vera');
  const recipient = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
  const editor = await composer(rachel.page), marker = `Org chooser reference ${Date.now()}`;
  await editor.input.fill(marker); await editor.send.click(); await expect(editor.input).toHaveText('');
  await expect(recipient.locator('[data-message-id]').filter({ hasText: marker }).getByTestId('dm-page-reference-open')).toBeVisible();
  expect((await vera.page.request.post('/api/session/tenant', { data: { tenant: 'social' } })).status()).toBe(200);
  expect((await vera.page.request.post('/api/session/role', { data: { role: 'participant' } })).status()).toBe(200);
  await vera.page.goto('/social'); const socialPanel = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
  await socialPanel.locator('[data-message-id]').filter({ hasText: marker }).getByTestId('dm-page-reference-open').click();
  await expect(vera.page).toHaveURL(/\/workspaces\?to=/);
  expect((await (await vera.page.request.get('/api/session/me')).json()).tenant).toBe('social');
  await expect(vera.page.getByText('Choose an Org workspace role to open the shared page.', { exact: true })).toBeVisible();
  await vera.page.getByTestId('select-role-orgiq-member').click();
  await expect(vera.page).toHaveURL(/\/iq\/projects\/p-auth-migration\?tab=work&item=wi-auth-e2-b3$/);
  expect((await (await vera.page.request.get('/api/session/me')).json()).tenant).toBe('orgiq');
  expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
});

test('a held real persisted DM receipt cannot clear the draft after its composer destination changes', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  let release: (() => void) | null = null;
  const rachel = await actor(browser, baseURL, 'u-rachel', forward => { release = forward; return true; });
  const vera = await actor(browser, baseURL, 'u-vera');
  try {
    const recipient = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
    const editor = await composer(rachel.page), marker = `DM receipt held ${Date.now()}`;
    await editor.input.fill(marker); await editor.send.click();
    await expect.poll(() => release !== null, { timeout: 15_000 }).toBe(true);
    await expect(recipient).toContainText(marker);
    await expect(editor.input).toHaveAttribute('contenteditable', 'false');
    await chooseOption(editor.target, 'discussion'); release!();
    await expect(editor.input).toBeEditable(); await expect(editor.input).toHaveText(marker);
    await expect(editor.dock.getByTestId('initiative-composer-note')).toContainText('Your current draft has been kept');
    const discussion = await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments');
    expect(JSON.stringify(await discussion.json())).not.toContain(marker);
    expect(rachel.outgoing.filter(frame => frame.service === 'chat' && frame.action === 'send' && frame.message === marker)).toHaveLength(1);
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally { release?.(); }
});

test('Search Message during a huddle preserves the source URL, shared page, call and media instance', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await actor(browser, baseURL, 'u-rachel'), vera = await actor(browser, baseURL, 'u-vera');
  try {
    await expect(rachel.page.getByTestId('initiative-start-call')).toBeEnabled();
    await rachel.page.getByTestId('initiative-start-call').click();
    await vera.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 15_000 });
    await expect(rachel.page.getByTestId('shell-call-dock')).toBeVisible();
    await openHuddle(rachel.page);
    const member = rachel.incoming.find(frame => frame.type === 'call-chat' && frame.action === 'members');
    const callId = String(member?.callId); expect(callId).not.toBe('undefined');
    const pin = await rachel.page.request.get(`/api/calls/${callId}/page`); expect(pin.status()).toBe(200);
    const shared = await rachel.page.request.put(`/api/calls/${callId}/page`, { data: {
      expectedRevision: (await pin.json()).revision, page: { kind: 'initiative', id: 'p-auth-migration' },
    } });
    expect(shared.status()).toBe(200); const original = await shared.json();
    await rachel.page.getByTestId('huddle-chat-panel-close').click();
    // A public navigation link changes the page while preserving shell ownership.
    await rachel.page.getByRole('link', { name: 'Search', exact: true }).first().click();
    await rachel.page.evaluate(() => {
      history.pushState({}, '', '/iq/search?tab=connections&selection=person%3Ap-002');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    const location = rachel.page.url();
    await expect(rachel.page.getByTestId('search-message')).toBeEnabled();
    await rachel.page.getByTestId('search-message').click();
    await expect(rachel.page.getByTestId('embedded-social-panel').getByTestId('social-chat-panel')).toContainText('Vera Green');
    await expect(rachel.page).toHaveURL(location); await expect(rachel.page.getByTestId('shell-call-dock')).toHaveCount(1);
    expect((await (await rachel.page.request.get('/api/session/me')).json()).tenant).toBe('orgiq');
    expect(await (await rachel.page.request.get(`/api/calls/${callId}/page`)).json()).toEqual(original);
    expect(rachel.media.filter(path => path.endsWith('/join'))).toHaveLength(1);
    expect(rachel.media.filter(path => path.endsWith('/end'))).toHaveLength(0);
    expect(rachel.outgoing.filter(frame => frame.service === 'presence' && frame.action === 'subscribe' && frame.channel === 'social:lobby')).toHaveLength(1);
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
      await rachel.page.setViewportSize(viewport);
      await expect.poll(async () => {
        const floating = await rachel.page.getByTestId('embedded-social-panel').boundingBox();
        const dock = await rachel.page.getByTestId('shell-call-dock').boundingBox();
        return !!floating && !!dock && floating.y + floating.height <= dock.y - 12;
      }).toBe(true);
    }
    await leave(rachel.page);
    await expect(rachel.page.getByTestId('shell-call-dock')).toHaveCount(0);
    await expect(rachel.page.getByTestId('embedded-social-panel')).toBeVisible();
  } finally { await leave(rachel.page); }
});

test('a failed attachment upload keeps the draft text and the file, shows the error, and a retry delivers', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await actor(browser, baseURL, 'u-rachel'), vera = await actor(browser, baseURL, 'u-vera');
  const recipient = await panel(vera.page, 'u-rachel', 'Rachel Kowalski');
  const editor = await composer(rachel.page), marker = `Upload retry ${Date.now()}`;
  let failing = true, puts = 0;
  await rachel.context.route('**/api/uploads/**', async route => {
    if (route.request().method() === 'PUT' && failing) { puts++; await route.fulfill({ status: 500, json: { error: 'upload store down' } }); }
    else await route.continue();
  });
  await editor.input.fill(marker);
  // In the shell's narrow conversation pane the attach control sits behind Aa.
  const formatting = editor.dock.getByTestId('rich-chat-composer-format-toggle');
  if (await formatting.isVisible().catch(() => false) && (await formatting.getAttribute('aria-pressed')) !== 'true') await formatting.click();
  await editor.dock.getByTestId('rich-chat-composer-file-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  const chip = editor.dock.getByTestId('composer-attachment');
  await expect(chip).toHaveCount(1); await editor.send.click();
  await expect.poll(() => puts, { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(editor.dock.getByTestId('rich-chat-composer-send-error').or(editor.dock.getByTestId('initiative-composer-recipient-error'))).toContainText(/upload/i, { timeout: 30_000 });
  await expect(editor.input).toBeEditable(); await expect(editor.input).toHaveText(marker); await expect(chip).toHaveCount(1);
  await expect(recipient).not.toContainText(marker);
  failing = false; await rachel.context.unroute('**/api/uploads/**').catch(() => {});
  await editor.send.click();
  await expect(recipient).toContainText(marker, { timeout: 30_000 });
  await expect(recipient).toContainText('notes.txt'); await expect(editor.input).toHaveText('');
  expect(rachel.errors).toEqual([]);
});
