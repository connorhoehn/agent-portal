import { loginAs } from './realSession';
import { seedPreJoin } from './preJoin';
import { type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test';
import { test, expect } from './cdpTest';
import { chooseComposerMode } from './conversationViews';

test.use({ viewport: { width: 1440, height: 900 },
  ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

// Each case gets fresh pages and sockets, while its real signed session can
// be reused within this worker. Repeated cases should not consume the login
// mutation rate limit or require an application fixture reset.
const sessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();
const ownedContexts = new Set<BrowserContext>();
test.afterEach(async () => { await Promise.all([...ownedContexts].map(context => context.close())); });

type Frame = Record<string, unknown>;
const HUDDLE = /^orgiq:huddle:/;
const isHuddle = (frame: Frame) => typeof frame.channel === 'string' && HUDDLE.test(frame.channel);

// Authentication, gateway chat persistence, canonical page resolution, call
// membership and WebSocket delivery are real. Only unavailable media-session
// metadata and receipts are substituted; these checks do not establish WebRTC
// acceptance. The huddle conversation is the gateway's `orgiq:huddle:<callId>`
// chat channel: a send is a socket frame whose persisted acknowledgement is
// the gateway's `sent` after the store write. The socket route below can hold
// that acknowledgement (never the message itself) to exercise draft ownership,
// and exposes this page's own connection — its call seat — for raw frames.
async function person(browser: Browser, baseURL: string | undefined, userId: string, caller = true) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  await seedPreJoin(context);
  ownedContexts.add(context); context.on('close', () => ownedContexts.delete(context));
  try {
  const mediaRequests: string[] = [], incoming: Frame[] = [], outgoing: Frame[] = [];
  const hold = { on: false, held: [] as Array<() => void> };
  let upstream: WebSocketRoute | null = null;
  await context.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer(); upstream = server;
    // Closing either side closes the other, so a closing context never waits on a routed socket.
    socket.onClose((code, reason) => { void server.close({ code, reason }).catch(() => undefined); });
    server.onClose((code, reason) => { void socket.close({ code, reason }).catch(() => undefined); });
    server.onMessage(message => {
      let frame: Frame | null = null;
      try { frame = JSON.parse(String(message)); } catch { /* forward non-JSON */ }
      if (hold.on && frame?.type === 'chat' && frame.action === 'sent' && isHuddle(frame)) { hold.held.push(() => socket.send(message)); return; }
      socket.send(message);
    });
  });
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
    const capture = (destination: Frame[], payload: string | Buffer) => {
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
  /** A frame on this page's own gateway connection (its call seat). */
  const raw = (frame: Frame) => { if (!upstream) throw new Error('No gateway socket'); upstream.send(JSON.stringify(frame)); };
  return { context, page, errors, incoming, outgoing, mediaRequests, hold, raw };
  } catch (error) { await context.close(); throw error; }
}
type Person = Awaited<ReturnType<typeof person>>;

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
const sends = (who: Person) => who.outgoing.filter(frame => frame.service === 'chat' && frame.action === 'send' && isHuddle(frame));
/**
 * The next huddle send from this page and its persisted acknowledgement: the
 * echoed message carrying the frame's delivery id, and the gateway's `sent`
 * for that message id on the same channel (as received on the network, even
 * while a test holds it back from the page).
 */
async function delivered(who: Person, before = sends(who).length) {
  await expect.poll(() => sends(who).length, { timeout: 15_000 }).toBeGreaterThan(before);
  const frame = sends(who)[before]!;
  const deliveryId = (frame.metadata as Frame).clientDeliveryId as string;
  let message: Frame | undefined;
  await expect.poll(() => {
    message = who.incoming.filter(value => value.type === 'chat' && value.action === 'message' && value.channel === frame.channel)
      .map(value => value.message as Frame).find(value => (value.metadata as Frame | undefined)?.clientDeliveryId === deliveryId);
    return !!message && who.incoming.some(value => value.type === 'chat' && value.action === 'sent'
      && value.channel === frame.channel && value.messageId === message!.id);
  }, { timeout: 15_000 }).toBe(true);
  return { frame, deliveryId, message: message!, callId: String(frame.channel).slice('orgiq:huddle:'.length) };
}
async function history(page: Page, callId: string) {
  const response = await page.request.get(`/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
  expect(response.status()).toBe(200); return response.json();
}
async function workComposer(page: Page) {
  if (await huddlePane(page).count()) await closeHuddle(page);
  await page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
  await expect(page.getByTestId('work-item-detail')).toBeVisible();
  const composer = page.getByTestId('initiative-composer');
  await chooseComposerMode(page, composer, 'Agent', 'Chat');
  const target = composer.getByRole('combobox', { name: 'Chat recipient' });
  await expect(target).toHaveValue('discussion');
  const huddleTargets = await target.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)
    .filter(value => value.startsWith('huddle:')));
  expect(huddleTargets).toHaveLength(1);
  return { composer, target, huddleTarget: huddleTargets[0]!, input: composer.getByTestId('rich-chat-composer-input'),
    send: composer.getByTestId('rich-chat-composer-send') };
}

test('protected persisted huddle messages reach peers live, replay, and retain exact references across navigation', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  const marker = `Huddle logout review ${Date.now()}`;
  try {
    await connect(rachel.page, vera.page);
    await closeHuddle(rachel.page);
    await rachel.page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
    await expect(rachel.page).toHaveURL(/item=wi-auth-e2-b3/);
    await expect(rachel.page.getByTestId('work-item-detail')).toBeVisible();
    const discussionBefore = await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments');
    expect(discussionBefore.status()).toBe(200);
    await rachel.page.getByTestId('shell-call-dock-chat').click();
    await draft(rachel.page).fill(marker);
    await rachel.page.getByTestId('huddle-chat-attach-page').click();
    const before = sends(rachel).length; await sendButton(rachel.page).click();
    const receipt = await delivered(rachel, before);
    // The frame carries only text, a delivery id and the exact {kind,id} descriptor.
    expect(receipt.frame).toMatchObject({ service: 'chat', action: 'send', channel: `orgiq:huddle:${receipt.callId}`, message: marker,
      metadata: { clientDeliveryId: expect.any(String), pageReference: { kind: 'work-item', id: 'wi-auth-e2-b3' } } });
    expect(Object.keys((receipt.frame.metadata as Frame).pageReference as Frame).sort()).toEqual(['id', 'kind']);
    expect(receipt.message).toMatchObject({ userId: 'u-rachel', message: marker, metadata: {
      displayName: 'Rachel Kowalski', clientDeliveryId: receipt.deliveryId,
      pageReference: { status: 'available', kind: 'work-item', id: 'wi-auth-e2-b3',
        title: 'Logout leaves the legacy shim cookie alive', href: '/iq/projects/p-auth-migration?tab=work&item=wi-auth-e2-b3' },
    } });
    await expect(vera.page.getByTestId('huddle-chat-panel')).toContainText(marker);
    await expect(vera.page.getByTestId('huddle-chat-reference-open')).toHaveText('Logout leaves the legacy shim cookie alive');
    await expect.poll(() => vera.incoming.some(frame => frame.type === 'chat' && frame.action === 'message'
      && frame.channel === `orgiq:huddle:${receipt.callId}` && (frame.message as { id?: string } | undefined)?.id === receipt.message.id)).toBe(true);
    for (const peer of [rachel, vera]) {
      const replay = await history(peer.page, receipt.callId);
      expect(replay.messages.filter((message: { id: string }) => message.id === receipt.message.id)).toHaveLength(1);
      expect(replay.messages.find((message: { id: string }) => message.id === receipt.message.id)).toEqual(receipt.message);
      expect(replay.participants.map((person: { userId: string }) => person.userId).sort()).toEqual(['u-rachel', 'u-vera']);
    }
    // The message's attached page does not create a shared-page pin or a
    // planning comment in the work item's separate Discussion destination.
    const pin = await rachel.page.request.get(`/api/calls/${receipt.callId}/page`); expect(pin.status()).toBe(200);
    expect((await pin.json()).page).toBeNull();
    const discussionAfter = await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments');
    expect(discussionAfter.status()).toBe(200); expect(JSON.stringify(await discussionAfter.json())).not.toContain(marker);
    await closeHuddle(vera.page);
    await vera.page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(vera.page).toHaveURL(/\/settings$/); await vera.page.getByTestId('shell-call-dock-chat').click();
    await expect(vera.page.getByTestId('huddle-chat-panel')).toContainText(marker);
    await draft(vera.page).fill('Draft retained in Settings');
    await vera.page.getByTestId('huddle-chat-reference-open').click();
    await expect(vera.page).toHaveURL(/\/iq\/projects\/p-auth-migration\?tab=work&item=wi-auth-e2-b3$/);
    await expect(draft(vera.page)).toHaveText('Draft retained in Settings');
    await expect(vera.page.getByTestId('shell-call-dock')).toHaveCount(1);
    expect(vera.mediaRequests.filter(path => path.endsWith('/join'))).toHaveLength(1);
    expect(vera.mediaRequests.filter(path => path.endsWith('/end'))).toHaveLength(0);
    for (const peer of [rachel, vera]) {
      // Every huddle frame either page sent names exactly this call's channel
      // (chat, or reactions on it), and every send names its delivery id.
      const huddleFrames = peer.outgoing.filter(frame => String(frame.channel ?? '').includes(':huddle:'));
      expect(huddleFrames.length).toBeGreaterThan(0);
      for (const frame of huddleFrames) expect(frame.channel).toBe(`orgiq:huddle:${receipt.callId}`);
      for (const frame of sends(peer)) expect((frame.metadata as Frame).clientDeliveryId).toEqual(expect.any(String));
      expect(peer.errors).toEqual([]);
    }
  } finally { await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close()]); }
});

test('unjoined and outsider users cannot read or post, and delivery retries are persisted without duplicates', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  const nora = await person(browser, baseURL, 'u-nora', false), theo = await person(browser, baseURL, 'u-theo', false);
  try {
    await connect(rachel.page, vera.page);
    const marker = `Persist once ${Date.now()}`;
    await draft(rachel.page).fill(marker);
    const before = sends(rachel).length; await sendButton(rachel.page).click();
    const receipt = await delivered(rachel, before);
    const channel = `orgiq:huddle:${receipt.callId}`, path = `/api/calls/${receipt.callId}/chat`;
    for (const peer of [nora, theo]) {
      expect((await peer.page.request.get(path)).status()).toBe(403);
      // Their own gateway connections are not seats: join, history, send and typing are refused.
      const errorsBefore = peer.incoming.filter(frame => frame.type === 'error').length;
      peer.raw({ service: 'chat', action: 'join', channel });
      peer.raw({ service: 'chat', action: 'history', channel });
      peer.raw({ service: 'chat', action: 'send', channel, message: 'Unauthorized', metadata: { clientDeliveryId: `unjoined-${Date.now()}` } });
      peer.raw({ service: 'chat', action: 'typing', channel, typing: true });
      await expect.poll(() => peer.incoming.filter(frame => frame.type === 'error').length).toBeGreaterThanOrEqual(errorsBefore + 4);
      await expect(peer.page.getByTestId('shell-call-dock-chat')).toHaveCount(0);
      expect(peer.incoming.filter(frame => frame.type === 'chat' && frame.channel === channel
        && ['message', 'history', 'typing', 'joined', 'sent'].includes(String(frame.action)))).toEqual([]);
    }
    // The same delivery again on Rachel's own seat: the original message and acknowledgement, no second copy.
    const sentBefore = rachel.incoming.filter(frame => frame.type === 'chat' && frame.action === 'sent' && frame.messageId === receipt.message.id).length;
    rachel.raw(receipt.frame);
    await expect.poll(() => rachel.incoming.filter(frame => frame.type === 'chat' && frame.action === 'sent'
      && frame.messageId === receipt.message.id).length).toBe(sentBefore + 1);
    const deniedBefore = rachel.incoming.filter(frame => frame.type === 'error' && frame.channel === channel).length;
    rachel.raw({ ...receipt.frame, message: 'Different payload' });
    rachel.raw({ service: 'chat', action: 'send', channel, message: 'Forged page', metadata: { clientDeliveryId: `forged-${Date.now()}`,
      pageReference: { kind: 'work-item', id: 'wi-auth-e2-b3', title: 'Forged', href: 'https://forged.invalid' } } });
    await expect.poll(() => rachel.incoming.filter(frame => frame.type === 'error' && frame.channel === channel).length).toBe(deniedBefore + 2);
    // A forged sender is stamped over by the authenticated one.
    const forgedId = `forged-sender-${Date.now()}`;
    rachel.raw({ service: 'chat', action: 'send', channel, message: 'Forged sender', metadata: { clientDeliveryId: forgedId, userId: 'u-vera', displayName: 'Vera Green' } });
    await expect.poll(async () => (await history(vera.page, receipt.callId)).messages
      .find((message: { metadata?: { clientDeliveryId?: string } }) => message.metadata?.clientDeliveryId === forgedId)?.userId).toBe('u-rachel');
    const replay = await history(vera.page, receipt.callId);
    expect(replay.messages.filter((message: { metadata?: { clientDeliveryId?: string } }) => message.metadata?.clientDeliveryId === receipt.deliveryId)).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain('Forged page');
    expect(JSON.stringify(replay)).not.toContain('Different payload');
    for (const peer of [rachel, vera, nora, theo]) expect(peer.errors).toEqual([]);
  } finally { await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close(), nora.context.close(), theo.context.close()]); }
});

test('explicit To keeps Discussion separate from the huddle and removing draft context leaves the shared pin intact', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  try {
    await connect(rachel.page, vera.page);
    const editor = await workComposer(rachel.page), callId = editor.huddleTarget.slice('huddle:'.length);
    const discussionText = `Discussion destination ${Date.now()}`, huddleText = `Huddle destination ${Date.now()}`;
    const pinBefore = await rachel.page.request.get(`/api/calls/${callId}/page`); expect(pinBefore.status()).toBe(200);
    const pinResult = await rachel.page.request.put(`/api/calls/${callId}/page`, { data: {
      expectedRevision: (await pinBefore.json()).revision, page: { kind: 'initiative', id: 'p-auth-migration' },
    } });
    expect(pinResult.status()).toBe(200); const pinned = await pinResult.json();
    await editor.input.fill(discussionText);
    // This item's Discussion is the gateway thread orgiq:work:<id> the pane shows (one store with the Discussion tab).
    const discussionFrames = () => rachel.outgoing.filter(frame => frame.service === 'chat' && frame.action === 'send'
      && frame.channel === 'orgiq:work:wi-auth-e2-b3' && frame.message === discussionText).length;
    await editor.send.click(); await expect.poll(discussionFrames, { timeout: 15_000 }).toBe(1);
    await expect(editor.input).toHaveText('');
    await expect(rachel.page.getByTestId('page-conversation-pane').getByTestId('chat-message').filter({ hasText: discussionText })).toHaveCount(1, { timeout: 15_000 });
    expect(JSON.stringify(await history(vera.page, callId))).not.toContain(discussionText);
    await editor.target.selectOption(editor.huddleTarget); await editor.input.fill(huddleText);
    // On the work item the huddle is the shell's right pane: the composer hands
    // its draft and page reference to the pane, whose Send persists it.
    await editor.send.click();
    await expect(draft(rachel.page)).toHaveText(huddleText);
    const before = sends(rachel).length; await sendButton(rachel.page).click();
    const withPage = await delivered(rachel, before);
    expect((withPage.frame.metadata as Frame).pageReference).toEqual({ kind: 'work-item', id: 'wi-auth-e2-b3' });
    await expect(vera.page.getByTestId('huddle-chat-panel')).toContainText(huddleText);
    const thread = rachel.page.getByTestId('page-conversation-pane').getByTestId('chat-message');
    await expect(thread.filter({ hasText: discussionText })).toHaveCount(1); await expect(thread.filter({ hasText: huddleText })).toHaveCount(0);
    await editor.composer.getByTestId('rich-chat-composer-references').getByRole('button', { name: /Remove .* from this draft/ }).click();
    await editor.input.fill(`Huddle without page ${Date.now()}`);
    await editor.send.click();
    await expect(huddlePane(rachel.page).getByTestId('rich-chat-composer-context-label')).toHaveCount(0);
    const plainBefore = sends(rachel).length; await sendButton(rachel.page).click();
    const plain = await delivered(rachel, plainBefore);
    expect(plain.frame.metadata).not.toHaveProperty('pageReference');
    const pinAfter = await vera.page.request.get(`/api/calls/${callId}/page`); expect(pinAfter.status()).toBe(200);
    expect(await pinAfter.json()).toEqual(pinned);
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally { await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close()]); }
});

for (const switchTarget of [false, true]) {
  test(`a real persisted acknowledgement ${switchTarget ? 'keeps the composer draft when its recipient changes' : 'clears the locked composer draft only after confirmation'}`, async ({ browser, baseURL }) => {
    test.setTimeout(90_000);
    const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
    const release = () => { rachel.hold.on = false; rachel.hold.held.splice(0).forEach(deliver => deliver()); };
    try {
      await connect(rachel.page, vera.page);
      const editor = await workComposer(rachel.page), callId = editor.huddleTarget.slice('huddle:'.length);
      await editor.target.selectOption(editor.huddleTarget);
      const submitted = `Persist before ack ${Date.now()}`, newerDraft = `Next draft ${Date.now()}`;
      // The gateway persists and acknowledges normally. Only delivery of that
      // actual acknowledgement to this page is held, to exercise draft ownership.
      rachel.hold.on = true;
      // The focused work item hands a huddle-bound draft to the shell's huddle
      // pane; the pane composer owns the send and its persisted acknowledgement.
      await editor.input.fill(submitted); await editor.send.click();
      await expect(draft(rachel.page)).toHaveText(submitted);
      const before = sends(rachel).length; await sendButton(rachel.page).click();
      const receipt = await delivered(rachel, before);
      expect(receipt.callId).toBe(callId);
      await expect.poll(() => rachel.hold.held.length).toBe(1);
      await expect(vera.page.getByTestId('huddle-chat-panel')).toContainText(submitted);
      expect(JSON.stringify(await history(vera.page, callId))).toContain(submitted);
      // Until the real acknowledgement reaches this page the pane stays in its
      // sending state and refuses a second send of the same draft.
      await expect(sendButton(rachel.page)).toHaveText('Sending…');
      await sendButton(rachel.page).click({ force: true }); expect(sends(rachel)).toHaveLength(before + 1);
      if (switchTarget) await editor.target.selectOption('discussion');
      release();
      await expect(sendButton(rachel.page)).toHaveText('Send');
      await expect(draft(rachel.page)).toHaveText('');
      expect(sends(rachel)).toHaveLength(before + 1);
      if (switchTarget) await expect(editor.target).toHaveValue('discussion');
      await editor.input.fill(newerDraft);
      if (switchTarget) await expect(editor.target).toHaveValue('discussion');
      expect(JSON.stringify(await history(vera.page, callId))).not.toContain(newerDraft);
      const comments = await rachel.page.request.get('/api/graph/work-items/wi-auth-e2-b3/comments'); expect(comments.status()).toBe(200);
      expect(JSON.stringify(await comments.json())).not.toContain(newerDraft);
      expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
    } finally { release(); await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close()]); }
  });
}

test('a real delayed panel acknowledgement preserves text typed for the next huddle message', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  const release = () => { rachel.hold.on = false; rachel.hold.held.splice(0).forEach(deliver => deliver()); };
  try {
    await connect(rachel.page, vera.page);
    rachel.hold.on = true;
    const submitted = `Panel persisted ${Date.now()}`, nextDraft = `Panel next draft ${Date.now()}`;
    await draft(rachel.page).fill(submitted);
    const before = sends(rachel).length; await sendButton(rachel.page).click();
    await delivered(rachel, before); await expect.poll(() => rachel.hold.held.length).toBe(1);
    await expect(vera.page.getByTestId('huddle-chat-panel')).toContainText(submitted);
    await draft(rachel.page).fill(nextDraft); release();
    await expect(sendButton(rachel.page)).toHaveText('Send');
    await expect(draft(rachel.page)).toHaveText(nextDraft);
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally { release(); await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close()]); }
});

test('an explicitly selected huddle that ends retains its draft instead of retargeting Discussion', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  try {
    await connect(rachel.page, vera.page); const editor = await workComposer(rachel.page);
    await editor.target.selectOption(editor.huddleTarget); await editor.input.fill('Draft for the selected huddle only');
    await leave(rachel.page);
    await expect(editor.composer.getByTestId('initiative-composer-recipient-unavailable')).toHaveText('This huddle has ended. Choose a current destination.');
    await expect(editor.target).toHaveValue(editor.huddleTarget);
    await expect(editor.input).toHaveText('Draft for the selected huddle only'); await expect(editor.send).toBeDisabled();
    expect(rachel.errors).toEqual([]); expect(vera.errors).toEqual([]);
  } finally { await leave(rachel.page); await Promise.all([rachel.context.close(), vera.context.close()]); }
});

test('a references-only huddle message stores the page reference with a blank body, never invented text', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const rachel = await person(browser, baseURL, 'u-rachel'), vera = await person(browser, baseURL, 'u-vera');
  try {
    await connect(rachel.page, vera.page);
    await closeHuddle(rachel.page);
    await rachel.page.getByText('Logout leaves the legacy shim cookie alive', { exact: true }).first().click();
    await expect(rachel.page.getByTestId('work-item-detail')).toBeVisible();
    await rachel.page.getByTestId('shell-call-dock-chat').click();
    await rachel.page.getByTestId('huddle-chat-attach-page').click();
    const before = sends(rachel).length;
    await sendButton(rachel.page).click();
    const receipt = await delivered(rachel, before);
    expect(receipt.frame).toMatchObject({ service: 'chat', action: 'send', message: '',
      metadata: { pageReference: { kind: 'work-item', id: 'wi-auth-e2-b3' } } });
    expect(receipt.message.message.trim()).toBe('');
    expect(receipt.message.message).not.toMatch(/Shared a work item/);
    expect(receipt.message.metadata).toMatchObject({ pageReference: { status: 'available', kind: 'work-item', id: 'wi-auth-e2-b3' } });
    await expect(vera.page.getByTestId('huddle-chat-reference-open')).toHaveText('Logout leaves the legacy shim cookie alive');
  } finally { await rachel.context.close(); await vera.context.close(); }
});
