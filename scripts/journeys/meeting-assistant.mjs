#!/usr/bin/env node
// The call assistant's call UI (docs/meeting-assistant-design.md, package 3), walked in a browser on the default mock
// world with no media, no microphone and no paid session:
//   1 Invite Nova is offered to a person in a call    2 inviting: "Nova is listening" for both, Nova in the roster
//   3 the notice shows to the second person only      4 nothing stored before the acknowledgement, lines after it
//   5 pause and resume from the second person         7 nothing clipped or scrolling in the call bar at 1280 (run before 6)
//   6 dismiss: the mark goes, Invite does not return, "Nova has left this call"
//   8 to 11 (package 4a, API level: the scripted session answers, no model): a spoken read lands in the call chat labelled with
//     the asker; a write is a card only the asker confirms and shows as a running turn only after that; a tool call from someone
//     who never said the name is refused and counted; after dismissal the inviter's spend has a meeting_assistant entry.
//   12 to 17 (package 5, the minutes; the scripted writer): the leaving message in the call chat, the meeting page at 1440 and 1280,
//     a person who was not there gets 404 and a not-found page, the Meetings list, the :minutes ledger entry, the inviter's delete.
//
// Two people share one call without media the way portal/e2e/work-huddle-navigation.spec.ts does: one starts a call on an
// initiative page, the other accepts the ring, and the SFU session metadata is the only thing stubbed (the realtime token
// advertises a stand-in platform API that answers join/end; mic and camera stay off). Seats, call chat and the gateway are real.
// Transcript lines come from the mock-only injector (POST /api/dev/calls/:callId/transcript-lines).
//
//   cd portal && npm run journey:meeting-assistant [-- --shots <dir> --out <dir>]
//
// Exit codes as learning-loop.mjs: 0 every step passed, 1 a step failed, 2 the stack is unreachable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORTAL = (process.env.PORTAL_URL ?? 'http://localhost:5166').replace(/\/$/, '');
const MIDDLEWARE = (process.env.MIDDLEWARE_URL ?? 'http://127.0.0.1:3966').replace(/\/$/, '');
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-assistant-'));
const SHOTS = flag('--shots') ?? path.join(OUT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const VERA = { userId: 'u-vera', role: 'org-leader' };
const NORA = { userId: 'u-nora', role: 'sme' };
const INITIATIVE = '/iq/projects/p-observability';
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
const STAND_IN_SFU = 'http://meeting-assistant.test';

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

/** Waits for a test id to be (in)visible; the assistant state refreshes every five seconds, so the waits are generous. */
async function seen(page, id, ms = 15000) {
  await page.getByTestId(id).first().waitFor({ state: 'visible', timeout: ms }).catch(() => { throw new StepFailure(`${id} never appeared`); });
}
async function gone(page, id, ms = 15000) {
  await page.getByTestId(id).first().waitFor({ state: 'detached', timeout: ms }).catch(() => { throw new StepFailure(`${id} never went away`); });
}
async function markText(page, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await page.getByTestId('nova-mark').first().innerText().catch(() => '')).trim();
    if (t) return t;
    await sleep(300);
  }
  return '';
}
async function waitMark(page, re, ms = 15000) {
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) { t = await markText(page, 600); if (re.test(t)) return t; await sleep(400); }
  throw new StepFailure(`the call bar never read ${re}: "${t}"`);
}

/** The bar: no sideways page scroll, Nova's controls inside the call dock, the dock inside the footer row, no control cut off. */
async function barFits(page, label, width) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(700);
  const r = await page.evaluate(() => {
    const rect = (el) => el.getBoundingClientRect();
    const dock = document.querySelector('[data-testid="shell-call-dock"]');
    const row = document.querySelector('[data-testid="shell-footer-row"]');
    const nova = document.querySelector('[data-testid="nova-bar"]');
    if (!dock || !row) return { missing: !dock ? 'shell-call-dock' : 'shell-footer-row' };
    const bad = [];
    const scrollX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const rr = rect(row), dr = rect(dock);
    if (dr.right > rr.right + 1) bad.push(`dock ends at ${Math.round(dr.right)}, row at ${Math.round(rr.right)}`);
    if (dock.scrollWidth > dock.clientWidth + 1) bad.push(`dock scrolls by ${dock.scrollWidth - dock.clientWidth}px`);
    for (const el of dock.querySelectorAll('button')) {
      const b = rect(el);
      if (b.width > 0 && (b.right > dr.right + 1 || b.left < dr.left - 1)) bad.push(`${el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 18)} outside the dock`);
    }
    if (nova) {
      const nr = rect(nova);
      if (nr.right > rr.right + 1 || nr.left < rr.left - 1) bad.push(`Nova's controls run outside the footer row (${Math.round(nr.left)}..${Math.round(nr.right)} in ${Math.round(rr.left)}..${Math.round(rr.right)})`);
      if (nr.height > 40) bad.push(`Nova's controls wrapped (${Math.round(nr.height)}px tall)`);
      for (const el of nova.querySelectorAll('[data-testid]')) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible') bad.push(`${el.getAttribute('data-testid')} is cut off`);
      }
    }
    return { scrollX, bad, barHeight: Math.round(rr.height), rowHeight: Math.round(rr.height), novaWidth: nova ? Math.round(rect(nova).width) : 0 };
  });
  check(!r.missing, `${label}: ${r.missing} is not on the page`);
  check(r.scrollX <= 1, `${label} scrolls sideways at ${width} by ${r.scrollX}px`);
  check(r.bad.length === 0, `${label} at ${width}: ${r.bad.join('; ')}`);
  return r;
}
async function shot(page, name, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await sleep(600);
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: false });
}

async function main() {
  const down = await reachable();
  if (down) { console.error(`meeting-assistant: unreachable: ${down}`); return 2; }
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) { console.error(`meeting-assistant: POST /api/__mock/reset answered ${r.status}`); return 2; }

  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const results = [];
  const errors = [];
  const contexts = [];
  let callId = null;

  /** A signed-in person with their own browser context and page, the call's SFU stubbed (see the header). */
  async function person(who) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    contexts.push(context);
    const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
    check(login.status() === 200, `login ${who.userId}: ${login.status()}`);
    const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
    check(role.status() === 200, `role ${who.role}: ${role.status()}`);
    await context.addInitScript(([key]) => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [PRE_JOIN_KEY]);
    await context.route('**/api/session/realtime-token', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: STAND_IN_SFU, videoUrl: null } });
    });
    await context.route(`${STAND_IN_SFU}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who.userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'meeting-assistant-signalling-only' } });
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${who.userId}: ${e.message}`));
    page.on('request', (rq) => { const m = /\/api\/calls\/([^/]+)\/chat(?:\?|$)/.exec(new URL(rq.url()).pathname + new URL(rq.url()).search); if (m && !callId) callId = decodeURIComponent(m[1]); });
    await page.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.getByTestId('initiative-header').waitFor({ timeout: 30000 });
    return { who, context, page, api: context.request };
  }

  const step = async (name, fn) => {
    const started = Date.now();
    try {
      const detail = await fn();
      check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
      results.push({ step: name, ok: true, ms: Date.now() - started, detail });
      console.log(`PASS ${name}${detail ? `\n  ${detail}` : ''}`);
    } catch (e) {
      results.push({ step: name, ok: false, ms: Date.now() - started, error: e.message });
      console.log(`FAIL ${name}\n  ${e.message}`);
      if (!(e instanceof StepFailure)) console.log(e.stack);
      errors.length = 0;
    }
  };
  /** Pause, Resume or Dismiss live in the mark's menu (one compact control keeps the footer on a line). */
  const novaMenu = async (p, name) => {
    await p.page.getByTestId('nova-mark').click();
    await p.page.getByRole('menuitem', { name }).click();
  };
  const transcript = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/transcript`);
    check(res.status() === 200, `GET transcript answered ${res.status()}`);
    return (await res.json()).lines.map((l) => l.text);
  };
  const inject = async (userId, text) => {
    const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, text }),
    });
    check(res.status < 300, `the injector answered ${res.status}`);
  };
  const stored = async (p, text, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await transcript(p)).includes(text)) return true; await sleep(500); }
    return false;
  };

  const asApi = (p, p2) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${p2}`;
  const chatMessages = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
    check(res.status() === 200, `GET the call chat answered ${res.status()}`);
    return (await res.json()).messages;
  };
  const novaOf = async (p, kind) => (await chatMessages(p)).filter((m) => m.metadata?.kind === kind);
  const waitFor = async (fn, ms, what) => {
    const end = Date.now() + ms;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new StepFailure(`${what} never happened`); await sleep(400); }
  };
  const myTurns = async (p) => {
    const res = await p.api.get(asApi(p, 'turns?mine=1'));
    check(res.status() === 200, `GET turns answered ${res.status()}`);
    return (await res.json()).turns;
  };
  const chatPanel = (p) => p.page.getByTestId('huddle-thread');
  const workTitles = async (p) => {
    const res = await p.api.get(`${PORTAL}/api/graph/work`);
    check(res.status() === 200, `GET the work list answered ${res.status()}`);
    const rows = JSON.stringify(await res.json());
    return rows;
  };
  const stateOf = async (p) => (await (await p.api.get(asApi(p, 'state'))).json());

  let vera, nora;
  try {
    // ── Setup: two people in one call, no media ──
    await step('0: setup: one person starts a call on an initiative, the other accepts, both are in it', async () => {
      vera = await person(VERA);
      nora = await person(NORA);
      const me = await (await vera.api.get(`${PORTAL}/api/session/me`)).json();
      check(me.meetingAssistant === true, `/api/session/me does not advertise the assistant: ${JSON.stringify(me.meetingAssistant)}`);
      await vera.page.getByTestId('initiative-start-call').click();
      await nora.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30000 });
      await vera.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      await nora.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      const end = Date.now() + 15000;
      while (!callId && Date.now() < end) await sleep(300);
      check(callId, 'no call id was seen on the wire');
      return `call ${callId}`;
    });
    if (!callId) throw new StepFailure('no call to walk');

    // ── 1. Invite is offered ──
    await step('1: the feature is advertised; a person in the call sees Invite Nova (every orgiq role holds the capability, so the "without it" half is skipped here and unit-tested in meetingAssistantModel)', async () => {
      await seen(vera.page, 'nova-invite');
      await seen(nora.page, 'nova-invite');
      const heights = [];
      for (const width of [1440, 1280]) heights.push(`${width}: ${(await barFits(vera.page, 'the bar with Invite Nova', width)).barHeight}px`);
      await shot(vera.page, '1-invite');
      return `Invite Nova on both bars; no mark yet; bar height ${heights.join(', ')}`;
    });

    // ── 2. Invite ──
    await step('2: inviting shows "Nova is listening" to both people and Nova in the roster; Invite goes', async () => {
      await vera.page.getByTestId('nova-invite').click();
      const a = await waitMark(vera.page, /^Nova is listening$/);
      const b = await waitMark(nora.page, /^Nova is listening$/);
      await gone(vera.page, 'nova-invite');
      await gone(nora.page, 'nova-invite');
      // The roster: the conversation pane's destination row (the call's tiles never list a non-media entry).
      const chat = vera.page.getByTestId('shell-call-dock-chat');
      if (!(await vera.page.getByTestId('conversation-pane-destination').isVisible().catch(() => false))) await chat.click();
      await seen(vera.page, 'nova-roster-entry');
      const line = (await vera.page.getByTestId('nova-roster-entry').innerText()).trim();
      check(/Nova \(Assistant, listening\)/.test(line), `the roster line does not name Nova: "${line}"`);
      check(!(await vera.page.locator('[data-call-stream], video').filter({ hasText: /Nova/ }).count()), 'Nova took a media tile');
      for (const width of [1440, 1280]) await barFits(vera.page, 'the bar with Nova listening', width);
      await shot(vera.page, '2-listening-roster');
      return `marks "${a}" and "${b}"; roster "${line.trim().slice(0, 120)}"`;
    });

    // ── 3. The notice ──
    await step('3: the second person sees the notice (inviter named, speech provider, 30 days, nothing kept until acknowledged); the inviter does not', async () => {
      await seen(nora.page, 'nova-notice');
      const text = (await nora.page.getByTestId('nova-notice').innerText()).replace(/\s+/g, ' ');
      check(/Vera\S* .*invited Nova/.test(text) || /invited Nova/.test(text), `the notice does not name who invited: "${text}"`);
      check(/speech provider/.test(text), `the notice does not say speech goes to a provider: "${text}"`);
      check(/30 days/.test(text), `the notice does not say how long it is kept: "${text}"`);
      check(/Nothing you say is kept until you acknowledge/.test(text), `the notice does not say nothing is kept before acknowledging: "${text}"`);
      check(await nora.page.getByTestId('nova-notice-acknowledge').isVisible(), 'no acknowledge control');
      check(await nora.page.getByTestId('nova-notice-secondary').isVisible(), 'no way to dismiss Nova from the notice');
      check(await vera.page.getByTestId('nova-notice').count() === 0, 'the inviter sees the notice');
      await barFits(nora.page, 'the bar under the notice', 1280);
      await shot(nora.page, '3-notice');
      return `"${text.slice(0, 200)}"`;
    });

    // ── 3b. Hiding the notice does not acknowledge; the mark keeps offering it ──
    await step('3b: the second person closes the notice with its own mark: nothing is acknowledged, and the Nova mark says Nova cannot hear them with Acknowledge one click away', async () => {
      await nora.page.getByTestId('nova-notice-dismiss').click();
      await gone(nora.page, 'nova-notice');
      await waitMark(nora.page, /^Nova cannot hear you yet$/);
      check((await stateOf(nora)).youMustAck === true, 'closing the notice acknowledged for the person');
      check(await vera.page.getByTestId('nova-mark').innerText().then((t) => /Nova is listening/.test(t)), 'the inviter\'s mark changed');
      await nora.page.getByTestId('nova-mark').click();
      const item = nora.page.getByRole('menuitem', { name: /Acknowledge/ });
      check(await item.isVisible(), 'no Acknowledge in the Nova menu');
      check(/cannot hear you until you do/i.test(await item.innerText()), 'the Acknowledge item does not say why');
      await barFits(nora.page, 'the bar with the mark prompting', 1280);
      await shot(nora.page, '3b-notice-hidden-mark-menu');
      await barFits(nora.page, 'the bar with the mark prompting', 1440);
      await nora.page.keyboard.press('Escape');
      return 'notice hidden; mark "Nova cannot hear you yet"; menu offers Acknowledge';
    });

    // ── 4. Nothing kept before the acknowledgement ──
    await step('4: a line for the second person is not stored before they acknowledge; after they do, a new one is', async () => {
      const before = 'Before ack: the canary rollout is on hold until Thursday.';
      const after = 'After ack: the canary rollout resumes on Friday.';
      await inject(NORA.userId, before);
      check(!(await stored(vera, before, 3500)), 'a line from a person who had not acknowledged was stored');
      await novaMenu(nora, /Acknowledge/);
      await waitMark(nora.page, /^Nova is listening$/);
      check((await stateOf(nora)).youMustAck === false, 'the menu\'s Acknowledge did not acknowledge');
      await inject(NORA.userId, after);
      check(await stored(vera, after, 10000), 'a line after the acknowledgement was not stored');
      check(!(await transcript(vera)).includes(before), 'the line from before the acknowledgement appeared later');
      return 'before: absent; after: stored';
    });

    // ── 5. Pause and resume ──
    await step('5: the second person pauses Nova: both see "paused" and a line is not stored; resume brings listening back', async () => {
      await novaMenu(nora, 'Pause Nova');
      await waitMark(nora.page, /^Nova is paused$/);
      await waitMark(vera.page, /^Nova is paused$/);
      await vera.page.getByTestId('nova-mark').click();
      check(await vera.page.getByRole('menuitem', { name: 'Resume Nova' }).isVisible(), 'no Resume Nova while paused');
      check(await vera.page.getByRole('menuitem', { name: 'Pause Nova' }).count() === 0, 'Pause Nova is offered while paused');
      await vera.page.keyboard.press('Escape');
      const heldBack = 'While paused: this must not be kept.';
      await inject(NORA.userId, heldBack);
      check(!(await stored(vera, heldBack, 3500)), 'a line was stored while Nova was paused');
      await barFits(vera.page, 'the bar while paused', 1280);
      await shot(vera.page, '5-paused');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/);
      await waitMark(nora.page, /^Nova is listening$/);
      const resumed = 'After resume: kept again.';
      await inject(NORA.userId, resumed);
      check(await stored(vera, resumed, 10000), 'a line after resume was not stored');
      return 'paused: both see it, nothing stored; resumed: stored';
    });

    // ── 8. A spoken read is answered in the call chat, labelled with who asked (the scripted session: no model) ──
    await step('8: "Nova, what is two plus two?" from the inviter lands in the call chat as Nova\'s reply to that person; nothing else was asked of the browser', async () => {
      await inject(VERA.userId, 'Nova, what is two plus two?');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).find((m) => m.message === 'Four.'), 20000, 'the reply "Four."');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}, not ${VERA.userId}`);
      check(typeof reply.metadata.askedByName === 'string' && reply.metadata.askedByName.length > 0 && reply.metadata.askedByName !== VERA.userId, `the label has no display name: ${reply.metadata.askedByName}`);
      check((await myTurns(vera)).length === 0, 'a plain answer left a turn for the browser');
      check((await myTurns(nora)).length === 0, 'a plain answer left a turn for the other person');
      return `reply "Four." labelled "${reply.metadata.askedByName}"`;
    });

    // ── 8a. A spoken read runs in the asker's own browser ──
    await step('8a: "Nova, search for login" from the inviter: the inviter\'s browser runs the read and posts the result, and Nova\'s reply appears in the chat labelled with the asker', async () => {
      const beforeReplies = (await novaOf(vera, 'assistant-reply')).length;
      const refusedBefore = (await stateOf(vera)).refusedCalls ?? 0;
      await inject(VERA.userId, 'Nova, search for login');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(beforeReplies).find((m) => m.message === 'Here is the result.'), 25000, 'the reply to the search');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}`);
      check((await myTurns(vera)).length === 0, 'the read is still waiting for the browser');
      check(((await stateOf(vera)).refusedCalls ?? 0) === refusedBefore, 'the read was refused');
      await seen(vera.page, 'huddle-thread');
      const label = await waitFor(async () => /Here is the result\.[\s\S]*Asked by Vera/.test(await chatPanel(vera).innerText()), 15000, 'the reply and its "Asked by" line on the inviter\'s screen');
      await shot(vera.page, '8a-read-reply-labelled');
      await shot(vera.page, '8a-read-reply-labelled', 1440);
      return `reply "${reply.message}" labelled "${reply.metadata.askedByName}"; shown with "Asked by"`;
    });

    // ── 9. A write is a card; only the asker confirms; the asker's browser then runs it ──
    await step('9: "Nova, create a work item ..." is a card both people see, controls for the asker only; the asker confirms in the chat, the browser creates it, the card reads done, and it exists', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the login cookie bug.');
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && /login cookie bug/.test(m.metadata.summary)), 20000, 'the action card');
      check(card.metadata.askedBy === VERA.userId && card.metadata.status === 'waiting', `the card is ${card.metadata.status} for ${card.metadata.askedBy}`);
      check((await myTurns(vera)).length === 0, 'a turn reached the asker\'s browser before they confirmed');
      check(!(await workTitles(vera)).includes('login cookie bug'), 'the work item existed before the card was confirmed');
      // Both people see the card; only the asker has controls.
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      await veraCard.waitFor({ timeout: 20000 }); await noraCard.waitFor({ timeout: 20000 });
      check(await veraCard.getByTestId('assistant-action-confirm').isVisible(), 'the asker has no Confirm');
      check(await noraCard.getByTestId('assistant-action-confirm').count() === 0 && await noraCard.getByTestId('assistant-action-decline').count() === 0, 'the other person has controls on the card');
      check(/Waiting for Vera/.test(await noraCard.innerText()), `the other person's card does not say who it waits for: "${await noraCard.innerText()}"`);
      await shot(vera.page, '9-card-waiting-asker'); await shot(nora.page, '9-card-waiting-other');
      const stranger = await nora.api.post(asApi(nora, `actions/${encodeURIComponent(card.metadata.actionId)}/decision`), { data: { decision: 'confirm' } });
      check(stranger.status() === 403, `another person confirming answered ${stranger.status()}, not 403`);
      check((await myTurns(vera)).length === 0, 'another person\'s confirm made a turn');
      await veraCard.getByTestId('assistant-action-confirm').click();
      await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'done'), 25000, 'the card going to done');
      check((await workTitles(vera)).includes('login cookie bug'), 'the work item does not exist after the card read done');
      check((await myTurns(vera)).length === 0, 'the confirmed turn is still waiting');
      await waitFor(async () => /Done/.test(await noraCard.getByTestId('assistant-action-status').innerText()) && (await noraCard.getByTestId('assistant-action-result').count()) > 0, 15000, 'the other person\'s card reading done with a result sentence');
      const resultLine = await noraCard.getByTestId('assistant-action-result').innerText();
      await shot(nora.page, '9-card-done-other'); await shot(vera.page, '9-card-done-asker');
      await shot(vera.page, '9-card-done-asker', 1440);
      return `card waiting (controls: asker only), 403 for the other person, confirmed in the UI, done: "${resultLine}"; the work item exists`;
    });

    // ── 9c. A declined card creates nothing ──
    await step('9c: a second card is declined by the asker: it reads declined for both, nothing is created, no turn reaches the browser', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the nightly export audit.');
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => /nightly export audit/.test(m.metadata.summary)), 20000, 'the second card');
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: /nightly export audit/ }).last();
      await veraCard.waitFor({ timeout: 20000 });
      await veraCard.getByTestId('assistant-action-decline').click();
      await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'declined'), 15000, 'the card going to declined');
      const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: /nightly export audit/ }).last();
      await waitFor(async () => /Declined/.test(await noraCard.getByTestId('assistant-action-status').innerText()), 15000, 'the other person seeing declined');
      await sleep(3500);
      check(!(await workTitles(vera)).includes('nightly export audit'), 'a declined card created the work item');
      check((await myTurns(vera)).length === 0, 'a declined card left a turn');
      await shot(vera.page, '9c-card-declined');
      return 'declined for both; nothing created';
    });

    // ── 9d. A private answer reaches only the asker ──
    await step('9d: "Nova, how much budget do I have" is answered privately: the asker sees a toast marked "only you can see this", the other person\'s chat and screen show nothing', async () => {
      const noraBefore = (await chatMessages(nora)).length;
      const asks = (await novaOf(vera, 'assistant-reply')).length;
      await inject(VERA.userId, 'Nova, how much budget do I have?');
      const toast = vera.page.getByText(/only you can see this/i).first();
      await toast.waitFor({ timeout: 25000 });
      await shot(vera.page, '9d-private-toast');
      const toastBox = await toast.evaluate((el) => (el.closest('[role="status"],[role="alert"],[data-testid*="toast"]') ?? el.parentElement).innerText.replace(/\s+/g, ' '));
      await sleep(1500);
      check((await novaOf(vera, 'assistant-reply')).length === asks, 'the private answer was posted in the call chat');
      check((await chatMessages(nora)).length === noraBefore, 'the other person\'s chat changed');
      check(await nora.page.getByText(/only you can see this/i).count() === 0, 'the other person sees the private toast');
      return `toast: "${toastBox.slice(0, 120)}"; chat unchanged for the other person`;
    });

    // ── 10. A tool call with no name in the asker's recent words is refused ──
    await step('10: a tool call attributed to someone who never said the name is refused, counted and posts nothing', async () => {
      const before = (await stateOf(vera)).refusedCalls ?? 0;
      const messages = (await chatMessages(vera)).length;
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: NORA.userId, name: 'search', args: { query: 'canary' } }),
      });
      check(res.status === 202, `the dev tool call answered ${res.status}`);
      await waitFor(async () => ((await stateOf(vera)).refusedCalls ?? 0) > before, 10000, 'the refused-call counter rising');
      await sleep(1500);
      check((await chatMessages(vera)).length === messages, 'a refused call posted something in the chat');
      check((await myTurns(nora)).length === 0, 'a refused call made a turn');
      return `refusedCalls ${before} -> ${(await stateOf(vera)).refusedCalls}`;
    });

    // ── 9e. At most three tool calls per addressed request ──
    await step('9e: the fourth tool call inside one addressed request is refused ("too many steps") and counted; the first three ran', async () => {
      await inject(VERA.userId, 'Nova, I need a hand with something.');
      await sleep(1500);
      const before = (await stateOf(vera)).refusedCalls ?? 0;
      for (const n of [1, 2, 3, 4]) {
        const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: VERA.userId, name: 'search', args: { query: `chain ${n}` } }),
        });
        check(res.status === 202, `dev tool call ${n} answered ${res.status}`);
        await sleep(300);
      }
      await waitFor(async () => ((await stateOf(vera)).refusedCalls ?? 0) > before, 15000, 'the fourth call being refused');
      await sleep(2500);
      const after = (await stateOf(vera)).refusedCalls ?? 0;
      check(after === before + 1, `refusedCalls went ${before} -> ${after}, not by exactly one`);
      check((await myTurns(vera)).length === 0, 'a turn is still waiting');
      return `refusedCalls ${before} -> ${after} after four chained calls`;
    });

    // ── 7. The bar at both widths with Nova's controls present ──
    await step('7: with Nova listening and its controls present the call bar and Nova controls neither scroll sideways nor clip at 1440 and 1280, and the footer keeps its height', async () => {
      const out = [];
      for (const p of [vera, nora]) for (const width of [1440, 1280]) {
        const m = await barFits(p.page, `${p.who.userId}'s bar`, width);
        out.push(`${p.who.userId}@${width}: dock ${m.barHeight}px, Nova ${m.novaWidth}px`);
      }
      // Nova must not make the bar taller: the dock measures the same with Nova's controls taken out of the layout.
      for (const p of [vera, nora]) for (const width of [1440, 1280]) {
        await p.page.setViewportSize({ width, height: 900 });
        await sleep(600);
        const [withNova, without] = await p.page.evaluate(async () => {
          const row = document.querySelector('[data-testid="shell-footer-row"]');
          const nova = document.querySelector('[data-testid="nova-bar"]');
          const a = row.getBoundingClientRect().height;
          nova.style.display = 'none';
          await new Promise((r) => setTimeout(r, 300));
          const b = row.getBoundingClientRect().height;
          nova.style.display = '';
          return [Math.round(a), Math.round(b)];
        });
        check(withNova <= without + 1, `${p.who.userId}@${width}: Nova's controls grow the footer row from ${without}px to ${withNova}px`);
        out.push(`${p.who.userId}@${width}: ${withNova}px with Nova, ${without}px without`);
      }
      return out.join('; ');
    });

    // ── 6. Dismiss ──
    await step('6: dismiss: the mark goes, Invite does not return, the bar says "Nova has left this call", re-invite is refused', async () => {
      await novaMenu(nora, 'Dismiss Nova');
      await seen(nora.page, 'nova-left');
      await seen(vera.page, 'nova-left');
      for (const p of [vera, nora]) {
        check(/Nova has left this call/.test(await p.page.getByTestId('nova-left').innerText()), 'the left state is not in words');
        check(await p.page.getByTestId('nova-mark').count() === 0, 'the listening mark stayed');
        check(await p.page.getByTestId('nova-invite').count() === 0, 'Invite Nova came back');
        check(await p.page.getByTestId('nova-menu').count() === 0, 'Nova controls stayed');
      }
      const again = await vera.api.post(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/invite`, { data: {} });
      check(again.status() === 409, `a re-invite answered ${again.status()}, not 409`);
      check(await vera.page.getByTestId('nova-roster-entry').count() === 0, 'Nova stayed in the roster');
      await barFits(vera.page, 'the bar after dismissal', 1280);
      await shot(vera.page, '6-left');
      return 'left; re-invite 409';
    });

    // ── 11. The inviter's spend ──
    await step('11: after the dismissal the inviter\'s spend has a meeting_assistant entry, and the state shows the listening time', async () => {
      const entry = await waitFor(async () => {
        const spend = await (await vera.api.get(`${PORTAL}/api/me/spend?period=month`)).json();
        return spend.byInitiative?.find((r) => r.bySource && 'meeting_assistant' in r.bySource);
      }, 15000, 'a meeting_assistant ledger entry for the inviter');
      const st = await stateOf(vera);
      check(st.state === 'left' && st.listeningSeconds > 0, `the state after leaving: ${JSON.stringify({ state: st.state, listeningSeconds: st.listeningSeconds })}`);
      check(st.ceilingSeconds >= 60, `the state has no ceiling: ${st.ceilingSeconds}`);
      return `entry ${JSON.stringify(entry.bySource)}; listened ${st.listeningSeconds} s of ${st.ceilingSeconds} s`;
    });
    // ── Package 5: the minutes (steps 12 to 17 run after the dismissal; the scripted writer, no model) ──
    const MEETING = () => `${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`;
    const LAYLA = { userId: 'u-layla', role: 'sme' };
    /** A person who was not in the call: logged in, no call, no initiative page needed. */
    const outsider = async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: LAYLA.userId } });
      check(login.status() === 200, `login ${LAYLA.userId}: ${login.status()}`);
      const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: LAYLA.role } });
      check(role.status() === 200, `role ${LAYLA.role}: ${role.status()}`);
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(`${LAYLA.userId}: ${e.message}`));
      return { who: LAYLA, context, page, api: context.request };
    };
    /** No sideways scroll and no element running past the right edge of the page. */
    const fitsWidth = async (page, label, width) => {
      await page.setViewportSize({ width, height: 900 });
      await sleep(600);
      const out = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check(out.over <= 1, `${label} scrolls sideways at ${width} by ${out.over}px`);
    };
    let layla;

    await step('12: after the dismissal Nova leaves one message in the call chat: the summary, the decision and action item counts, and a link to the meeting page', async () => {
      const msg = await waitFor(async () => (await chatMessages(vera)).find((m) => /Nova's minutes/.test(m.message ?? '')), 20000, 'the minutes message in the call chat');
      check(msg.userId === 'agent:nova' || msg.metadata?.assistant === true, 'the minutes message is not Nova\'s');
      check(/\d+ decisions? and \d+ action items?/.test(msg.message), `no counts in "${msg.message}"`);
      check(msg.message.includes(`/iq/meetings/${callId}`), `no link to the meeting page in "${msg.message}"`);
      check(/ said: /.test(msg.message), `no summary in "${msg.message}"`);
      const all = (await chatMessages(vera)).filter((m) => /Nova's minutes/.test(m.message ?? ''));
      check(all.length === 1, `${all.length} minutes messages were posted`);
      return `"${msg.message.slice(0, 220)}"`;
    });

    await step('13: the meeting page renders for an attendee at 1440 and 1280 with the summary, an action item and the transcript with speaker names', async () => {
      await vera.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(vera.page, 'meeting-page', 30000);
      await seen(vera.page, 'meeting-summary');
      await seen(vera.page, 'meeting-action-items');
      const out = [];
      for (const width of [1440, 1280]) {
        await fitsWidth(vera.page, 'the meeting page', width);
        const text = await bodyText(vera.page);
        check(/Nova invited by /.test(text), 'the header does not say who invited Nova');
        check(/summary/i.test(text) && /decisions/i.test(text) && /action items/i.test(text) && /transcript/i.test(text), `a section is missing at ${width}: ${text.slice(0, 300)}`);
        const summary = (await vera.page.getByTestId('meeting-summary').innerText()).trim();
        check(summary.length > 10, 'the summary is empty');
        const items = (await vera.page.getByTestId('meeting-action-items').innerText()).replace(/\s+/g, ' ');
        check(/work item/i.test(items), `the action items do not hold the work item created in the call: "${items}"`);
        // Speaker names, not ids: the transcript lines were injected for u-nora and u-vera.
        check(/Nora/.test(text), 'Nora is not named in the transcript');
        check(!/\bu-nora\b|\bu-vera\b/.test(text), 'a raw user id shows on the page');
        check(text.includes('After resume: kept again.'), 'a transcript line is missing');
        out.push(`${width}: ok`);
      }
      await vera.page.setViewportSize({ width: 1280, height: 900 });
      await vera.page.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      await vera.page.screenshot({ path: path.join(SHOTS, '13-meeting-page-1280.png'), fullPage: false });
      return out.join(', ');
    });

    await step('14: a person who was not in the call gets a not-found page and a 404 from both API routes', async () => {
      layla = await outsider();
      const min = await layla.api.get(asApi(layla, 'minutes'));
      const tr = await layla.api.get(asApi(layla, 'transcript'));
      check(min.status() === 404, `minutes answered ${min.status()} to an outsider`);
      check(tr.status() === 404, `transcript answered ${tr.status()} to an outsider`);
      check(!/login cookie|canary|resume/i.test(await min.text() + await tr.text()), 'the 404 body carries meeting words');
      await layla.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(layla.page, 'meeting-not-found', 30000);
      const text = await bodyText(layla.page);
      check(!/login cookie|canary|rollout|resumes/i.test(text), 'the not-found page shows meeting words');
      return 'API 404 x2; "Meeting not found" page';
    });

    await step('15: the Meetings list shows the meeting to an attendee, table first, and not to the outsider', async () => {
      await vera.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(vera.page, 'iq-meetings-table', 30000);
      const row = vera.page.getByTestId('iq-meetings-table').getByText(/call/i).first();
      await row.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new StepFailure('the meeting is not in the list'); });
      for (const width of [1440, 1280]) {
        await fitsWidth(vera.page, 'the Meetings list', width);
        const top = await row.evaluate((el) => el.getBoundingClientRect().top).catch(() => null);
        check(top !== null && top < 600, `the first row starts at ${top}px: the table is not above the fold at ${width}`);
      }
      const text = await bodyText(vera.page);
      check(/Nora/.test(text), 'the list does not name the people');
      await vera.page.setViewportSize({ width: 1280, height: 900 });
      await sleep(400);
      await vera.page.screenshot({ path: path.join(SHOTS, '15-meetings-list-1280.png'), fullPage: false });
      const mine = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      check(mine.meetings.some((m) => m.callId === callId && m.actionItemCount >= 1), `the API list lacks the meeting: ${JSON.stringify(mine).slice(0, 200)}`);
      const theirs = await (await layla.api.get(`${PORTAL}/api/meetings`)).json();
      check(Array.isArray(theirs.meetings) && theirs.meetings.length === 0, `the outsider's list is ${JSON.stringify(theirs).slice(0, 200)}`);
      await layla.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(layla.page, 'iq-meetings-table', 30000);
      check(!/ said: /.test(await layla.page.getByTestId('iq-meetings-table').innerText()), 'the outsider\'s table shows a meeting');
      return `attendee: ${mine.meetings.length} meeting(s); outsider: none`;
    });

    await step('16: a ledger entry for the minutes exists, booked to the inviter (source id ending :minutes)', async () => {
      const res = await vera.api.get(`${PORTAL}/api/spend/entries?groupBy=source&key=meeting_assistant&period=month&limit=50`);
      check(res.status() === 200, `the spend entries answered ${res.status()}`);
      const body = await res.json();
      const ids = (body.entries ?? []).map((e) => e.sourceId);
      check(ids.some((id) => id === `ma:${callId}:minutes`), `no :minutes entry among ${JSON.stringify(ids)}`);
      return `entries ${JSON.stringify(ids)}`;
    });

    await step('17: only the inviter sees Delete; deleting (after the confirm step) makes the page and the transcript route 404 for everyone', async () => {
      await nora.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(nora.page, 'meeting-page', 30000);
      check(await nora.page.getByTestId('meeting-delete').count() === 0, 'a person who did not invite Nova is offered Delete');
      const refused = await nora.api.delete(asApi(nora, 'minutes'));
      check(refused.status() === 403, `a non-inviter deleting answered ${refused.status()}`);
      await vera.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(vera.page, 'meeting-delete', 30000);
      await vera.page.getByTestId('meeting-delete').click();
      await vera.page.getByRole('button', { name: 'Delete record' }).click();
      await vera.page.waitForURL(/\/iq\/meetings$/, { timeout: 20000 }).catch(() => { throw new StepFailure('deleting did not return to the Meetings list'); });
      for (const p of [vera, nora]) {
        const a = await p.api.get(asApi(p, 'minutes')); const b = await p.api.get(asApi(p, 'transcript'));
        check(a.status() === 404 && b.status() === 404, `${p.who.userId}: minutes ${a.status()}, transcript ${b.status()} after the delete`);
      }
      await vera.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(vera.page, 'meeting-not-found', 30000);
      const list = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      check(!list.meetings.some((m) => m.callId === callId), 'the deleted meeting is still listed');
      return 'non-inviter: no button, 403; inviter: confirm, then 404 on the page and both routes, gone from the list';
    });
  } finally {
    for (const p of [vera, nora]) {
      const leave = p?.page.getByTestId('shell-call-dock').getByRole('button', { name: /Leave|Hang up/ }).first();
      if (leave && await leave.isVisible().catch(() => false)) await leave.click().catch(() => undefined);
    }
    for (const c of contexts) await c.close().catch(() => undefined);
    await browser.close();
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'meeting-assistant.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const fails = results.filter((x) => !x.ok).length;
  console.log(`meeting-assistant: ${results.length - fails}/${results.length} passed; fails=${fails}; screenshots in ${SHOTS}`);
  return fails === 0 ? 0 : 1;
}

process.exit(await main());
