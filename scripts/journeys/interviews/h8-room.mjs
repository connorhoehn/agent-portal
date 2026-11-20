// Lane H8's helpers for the pieces that need both sides IN the call (I4.2, I4.3, I4.4, I3.5, I3.8). Lowercase, so the
// walk runner does not run it as a piece (h4-kit.mjs is the precedent). The call stand-in itself is lib.mjs standInCall; the rest stays here until the lead adds these to
// lib.mjs: the mock world has no platform-api, so a call starts only with the SFU stood in, the way
// scripts/journeys/meeting-assistant.mjs does it (the realtime token's platformApiUrl points at a stand-in host that every
// request to answers locally; nothing leaves the machine, nothing is recorded).
//
//   staffRoom(ctx, who, interviewId, { width })   a signed-in context with the stand-in, on the interview's room → { context, page, calls }
//   joinCall(page)                                the lead's or a panel member's footer "Join the call", through the pre-join dialog
//   guestRoom(ctx, interviewId, lead, { width })  the candidate: link, consents, devices, the knock, admitted by `lead`, Join → { context, page, token }
//   pad(page) / padText(page) / carets(page)       the shared pad, its text, the named carets drawn on this page
//   typeInPad(page, text)                         click into the pad's editor, go to the end, type
//   until(fn, ms)                                 a bounded wait for a truthy value
//   callIdOf(page-or-calls)                       the call id the page talked to (/api/calls/:id/…)
//   who(e)                                        a step error as one line

import { standInCall, PREJOIN_KEYS } from './lib.mjs';

export const STAND_IN_SFU = 'http://interviews-h8.test';
const PANEL_KEY = PREJOIN_KEYS.panel;
const GUEST_KEY = PREJOIN_KEYS.guest;

export const why = (e) => {
  const lines = (e instanceof Error ? e.message : String(e)).split('\n').map((l) => l.trim()).filter(Boolean);
  // A timeout names the locator on its second line ("waiting for …"): keep it, it is what says which wait gave up.
  const wait = lines.find((l) => /waiting for/.test(l));
  return `${lines[0] ?? ''}${wait ? ` (${wait.replace(/\u001b\[\d+m/g, '')})` : ''}`.slice(0, 300);
};
export const until = async (fn, ms = 15_000, step = 400) => {
  const end = Date.now() + ms;
  let v = await fn().catch(() => null);
  while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, step)); v = await fn().catch(() => null); }
  return v;
};

/** Mic and camera off at the pre-join, the token's SFU pointed at the stand-in, and the stand-in answering every call (lib.mjs standInCall). */
const standIn = (context, tokenRoute, key, label) => standInCall(context, { sfu: STAND_IN_SFU, tokenRoute, prejoinKey: key, label, sessionId: 'h8-signalling-only' });

/** The call ids a page has talked to, newest last. */
function watchCalls(page) {
  const calls = [];
  page.on('request', (r) => {
    const m = /\/api\/calls\/([^/?]+)\//.exec(r.url());
    if (m) { const id = decodeURIComponent(m[1]); if (calls.at(-1) !== id) calls.push(id); }
  });
  return calls;
}
export const callIdOf = (calls) => calls.at(-1) ?? null;

export async function staffRoom(ctx, who, interviewId, { width = 1440 } = {}) {
  const context = await ctx.signIn(ctx.SEED.cast[who], width);
  await standIn(context, '**/api/session/realtime-token', PANEL_KEY, who);
  const page = await context.newPage();
  const calls = watchCalls(page);
  await page.goto(`${ctx.portal}/interviews/rounds/${interviewId}/room`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('interview-room').first().waitFor({ timeout: 40_000 });
  return { context, page, calls };
}

/** Click the first visible button matching `name` in `scope`, then the pre-join dialog's own. */
async function joinFrom(page, scope, name) {
  const btn = scope.getByRole('button', { name }).first();
  await btn.waitFor({ timeout: 20_000 }).catch(async () => {
    const text = (await scope.first().innerText().catch(() => 'no such region')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`no ${name} button; the region reads "${text}"`);
  });
  await until(async () => !(await btn.isDisabled()), 20_000);
  await btn.click({ timeout: 8000 });
  await page.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last().click({ timeout: 6000 }).catch(() => undefined);
}

/** The panel's footer: Join the call. Resolves once the room's pad or chat is the call's (bounded). */
export async function joinCall(page) {
  await page.waitForTimeout(1500);
  // As h3-call.mjs does: the footer's own start (the first person in) or join (the call is running) control, by test id.
  const start = page.getByTestId('shell-footer-context-start');
  const join = page.getByTestId('shell-footer-context-join');
  const which = await Promise.any([
    start.first().waitFor({ timeout: 30_000 }).then(() => start.first()),
    join.first().waitFor({ timeout: 30_000 }).then(() => join.first()),
  ]).catch(() => null);
  if (!which) {
    const text = ((await page.getByTestId('shell-footer').innerText().catch(() => '')) || 'no footer').replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`no Join the call in the footer; it reads "${text}"`);
  }
  await until(async () => !(await which.isDisabled()), 20_000);
  await which.click({ timeout: 8000 });
  await page.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last().click({ timeout: 3000 }).catch(() => undefined);
  await page.getByTestId('shell-call-dock').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(4000);
}

/** The candidate, admitted by `lead` (a context), in the call with the pane open. */
/** `prepare(context)` runs on the candidate's fresh context before its first page loads (a piece's own routes, say). */
export async function guestRoom(ctx, interviewId, lead, { width = 1440, prepare = null } = {}) {
  const recruiter = await ctx.signIn(ctx.SEED.cast.recruiter);
  const invite = await ctx.mintInvite(recruiter, interviewId);
  await recruiter.close();
  if (invite.status !== 201) throw new Error(`the link was not made (${invite.status} ${invite.error ?? ''})`);
  const context = await ctx.browser.newContext({ viewport: { width, height: 900 }, permissions: ['camera', 'microphone'] });
  await standIn(context, '**/api/interview-invite/realtime-token', GUEST_KEY, 'guest');
  if (prepare) await prepare(context);
  const page = await context.newPage();
  const calls = watchCalls(page);
  await page.goto(`${ctx.portal}${invite.linkPath}`, { waitUntil: 'domcontentloaded' });
  // A candidate whose answers are already on record (the seeded live round) lands on the device check, not the landing card.
  const seenId = (id) => page.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id);
  const first = await Promise.any(['join-interview', 'join-consents', 'join-devices', 'join-waiting', 'join-room'].map(seenId)).catch(async () => {
    throw new Error(`the invite page did not show a first step at ${new URL(page.url()).pathname.replace(/[0-9a-f-]{20,}/g, ':token')}; it reads "${((await page.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ').slice(0, 220)}"`);
  });
  let step = null;
  if (first === 'join-interview' || first === 'join-consents') step = await ctx.toWaiting(page);
  else {
    if (first === 'join-devices') {
      await page.getByTestId('join-devices-continue').click();
      step = await Promise.any(['join-waiting', 'join-room', 'join-held'].map(seenId)).then((id) => id.replace('join-', '')).catch(() => null);
    } else step = first.replace('join-', '');
  }
  if (step !== 'waiting' && step !== 'room') throw new Error(`the candidate stopped at ${step}`);
  const a = await ctx.admit(lead, interviewId, true);
  if (a.status !== 200) throw new Error(`admit answered ${a.status}`);
  await page.getByTestId('join-room').first().waitFor({ timeout: 30_000 });
  await joinFrom(page, page.getByTestId('join-room-bar'), /join/i);
  await page.getByTestId('join-room-pane').first().waitFor({ timeout: 30_000 }).catch(async () => {
    throw new Error(`the candidate's pane did not open; the room reads "${(await page.getByTestId('join-room').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200)}"`);
  });
  return { context, page, calls, token: invite.token };
}

export const pad = (page) => page.getByTestId('interview-pad').first();
export const synced = (page, ms = 30_000) => page.locator('[data-testid="interview-pad"][data-connection="synced"]').first().waitFor({ timeout: ms }).then(() => true, () => false);
/** The editor's text, line by line as the document holds it. */
export const padText = (page) => pad(page).locator('.cm-content').evaluate((el) => [...el.querySelectorAll('.cm-line')].map((l) => {
  // The other people's carets are widgets inside a line (their name, zero-width joiners): read the line without them.
  const c = l.cloneNode(true);
  for (const w of c.querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo, .cm-widgetBuffer')) w.remove();
  return (c.textContent ?? '').replace(/\u2060/g, '');
}).join('\n')).catch(() => null);
/** The named carets of the other people drawn on this page. */
export const carets = (page) => pad(page).locator('.cm-ySelectionInfo').allTextContents().then((a) => a.map((s) => s.trim()).filter(Boolean)).catch(() => []);

export async function typeInPad(page, text) {
  await pad(page).locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text, { delay: 15 });
}

/** The pad's language (the library's Select: a native select, or its combobox showing the label). → the label shown, e.g. "JavaScript". */
export const languageOf = (page) => pad(page).getByTestId('interview-pad-language').first().evaluate((el) => {
  const sel = el instanceof HTMLSelectElement ? el : el.querySelector('select');
  if (sel) return sel.options[sel.selectedIndex]?.text ?? sel.value;
  return (el.textContent ?? '').trim();
}).catch(() => null);
export async function chooseLanguage(page, label) {
  const el = pad(page).getByTestId('interview-pad-language').first();
  const sel = await el.evaluate((e) => e instanceof HTMLSelectElement || !!e.querySelector('select')).catch(() => false);
  if (sel) { await (await el.evaluate((e) => e instanceof HTMLSelectElement) ? el : el.locator('select')).selectOption({ label }); return; }
  await el.click();
  await page.getByRole('option', { name: label, exact: true }).first().click({ timeout: 5000 });
}

/** The run output pane's text, one line. */
export const outputText = (page) => page.getByTestId('interview-pad-run-output').first().innerText().then((s) => s.replace(/\s+/g, ' ').trim()).catch(() => '');

// ── Milo in the call (I3.5, I3.8, I4.5) ─────────────────────────────────────────────────────────────────────────
/** The lead invites Milo from the footer's own control (Work's Invite Milo), past the budget ask; true once Milo is listening. */
export async function inviteMilo(ctx, room) {
  await room.page.getByTestId('assistant-invite').first().click({ timeout: 10_000 });
  await room.page.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i }).click({ timeout: 4000 }).catch(() => undefined);
  const callId = await until(async () => callIdOf(room.calls), 10_000);
  if (!callId) return null;
  const listening = await until(async () => {
    const r = await ctx.api(room.context, 'GET', `/api/calls/${encodeURIComponent(callId)}/assistant/state`);
    return r.body?.state === 'listening' ? true : null;
  }, 20_000, 1000);
  return listening ? callId : null;
}
export const voice = (ctx, room, callId, on) => ctx.api(room.context, 'POST', `/api/calls/${encodeURIComponent(callId)}/assistant/voice`, { on });
/** A line heard in the call (the mock world's transcript injector). */
export const hear = (ctx, room, callId, userId, text) => ctx.api(room.context, 'POST', `/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, { userId, text });
/** Audio frames this page's Milo voice has played: the candidate's chip, or the panel's bar. */
export const framesOf = async (page) => {
  const g = page.getByTestId('guest-milo-voice').first();
  const at = (await g.count()) ? g : page.locator('[data-testid="assistant-status-mark"],[data-testid="assistant-menu"]').first();
  return Number(await at.getAttribute('data-voice-frames', { timeout: 2000 }).catch(() => '-1'));
};
/** True when this page shows Milo speaking at this moment (the candidate's chip, the panel's bar). */
export const speakingOn = async (page) => (await page.getByTestId('guest-milo-speaking').count()) > 0
  || (await page.locator('[data-testid="assistant-status-mark"],[data-testid="assistant-menu"]').first().getAttribute('data-voice-speaking', { timeout: 500 }).catch(() => null)) === 'true';
/** A click on the page so the browser lets it play sound (the voice player's gesture), and the bar's own sound button. */
export async function letSound(page) {
  await page.mouse.click(5, 5).catch(() => undefined);
  for (const id of ['guest-milo-enable-sound', 'assistant-enable-sound']) {
    const b = page.getByTestId(id).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => undefined);
  }
}
/** The call chat as this page shows it (the panel's Chat tab, the candidate's). */
export async function chatText(page) {
  const lead = page.getByTestId('interview-room-pane');
  if (await lead.count()) {
    await lead.getByRole('tab', { name: /^chat$/i }).click({ timeout: 4000 }).catch(() => undefined);
    await page.waitForTimeout(800);
    return (await page.getByTestId('interview-room-chat').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  }
  await page.getByTestId('join-room-pane').getByRole('tab', { name: /^chat$/i }).click({ timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return (await page.getByTestId('join-room-chat').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
}
/** Back to the pad tab on either side. */
export async function padTab(page) {
  const lead = page.getByTestId('interview-room-pane');
  const tabs = (await lead.count()) ? lead : page.getByTestId('join-room-pane');
  await tabs.getByRole('tab', { name: /^pad$/i }).click({ timeout: 4000 }).catch(() => undefined);
}
/** Wait for the lead's footer suggestion (the scripted coach can take up to 120 s). → the deck's text, or null. */
export async function suggestion(page, ms = 160_000) {
  const deck = page.getByTestId('interview-room-ask');
  // The suggestion waits as a button on the footer's row (nothing is drawn above the row): open it, as the lead does.
  const open = async () => { if (!(await deck.isVisible().catch(() => false))) await page.getByTestId('interview-room-ask-open').click({ timeout: 1500 }).catch(() => undefined); };
  return until(async () => { await open(); return (await deck.getByRole('button', { name: /have milo ask/i }).isVisible().catch(() => false)) ? (await deck.innerText()).replace(/\s+/g, ' ').trim() : null; }, ms, 2500);
}

/**
 * What the lead's "Have Milo ask" on a question card says. The line is shown only until the pane moves: in a technical round
 * a question Milo said aloud opens the Pad tab (InterviewRoomPage `onAsked`), so a line that never shows while the Pad tab is
 * selected is the built behaviour, read as spoken. → { said: 'spoken' | …| null, line, padOpened }
 */
export async function askedMarker(page, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const el = page.getByTestId('interview-room-milo-said').first();
    if (await el.count()) return { said: await el.getAttribute('data-said').catch(() => null), line: await el.innerText().catch(() => ''), padOpened: false };
    const padSelected = await page.getByTestId('interview-room-pane').getByRole('tab', { name: /^pad/i }).first().getAttribute('aria-selected').catch(() => null);
    if (padSelected === 'true') return { said: 'spoken', line: 'Milo asked it aloud (the Pad tab opened on the question).', padOpened: true };
    await new Promise((r) => setTimeout(r, 150));
  }
  return { said: null, line: '', padOpened: false };
}

/** Sample an element's text until it matches `re` (a receipt that stays only a moment), bounded. → the text that matched, or the last text read */
export async function catchText(page, testId, re, ms = 8000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    const el = testId ? page.getByTestId(testId).first() : page.locator('body');  // no test id: anywhere on the page
    last = ((await el.innerText({ timeout: 500 }).catch(() => '')) || '').replace(/\s+/g, ' ');
    if (re.test(last)) return last;
    await new Promise((r) => setTimeout(r, 120));
  }
  return last;
}
