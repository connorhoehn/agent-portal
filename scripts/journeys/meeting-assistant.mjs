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
//   P1 to P9 (meeting consent, packages 2, 3 and 6): a third person joins; a proposal Nova heard shows its lines only to people who
//     were in the call (a named person who was not sees the statement only); a proposal from the dev creator is one card for all
//     three ("Nova heard a decision", how it will be recorded, Answer only) and a deck prompt for each that arrives without moving
//     focus and ignores digits outside the deck; the executor's Consent says it runs only when hers is the last; Esc and the
//     footer count (only what waits on you), the card's Answer; two consents with the executor's last run it in her browser and
//     the card ends with the decision's title and link, whose page says "Agreed in a call by"; another consent last stops at
//     consented until her "Run it now"; an objection with a shared reason, what clears it, its withdrawal from the card, "Not a
//     decision" with Undo, "Raise it again"; an asked write only its asker may drop; a proposal left open when Nova leaves is
//     answered on the meeting page (13b), runs there and ends recorded.
//   12 to 17 (package 5, the minutes; the scripted writer): the leaving message in the call chat, the meeting page at 1440 and 1280,
//     what Nova covered and how long the meeting is kept (13a), written minutes cannot be written again (13a2), the bell (13a3),
//     a person who was not there gets 404 and a neutral not-found page, the Meetings list, the :minutes ledger entry, the inviter's delete.
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
  const allErrors = []; // every page error of the whole walk, never cleared: the last step fails on any
  const results_ = []; // every result post a browser made: { turnId, ok, say, answered }
  const contexts = [];
  let callId = null;

  /** Collects page errors (the step's and the walk's) and every claim result the page posts, with what the server answered. */
  function watch(page, label) {
    page.on('pageerror', (e) => { errors.push(`${label}: ${e.message}`); allErrors.push(`${label}: ${e.message}`); });
    page.on('response', async (res) => {
      const m = /\/api\/calls\/[^/]+\/assistant\/turns\/([^/]+)\/result$/.exec(new URL(res.url()).pathname);
      if (!m || res.request().method() !== 'POST') return;
      let sent = {}; let answered = null;
      try { sent = JSON.parse(res.request().postData() ?? '{}'); } catch { /* not json */ }
      try { answered = (await res.json()).status ?? null; } catch { /* not json */ }
      results_.push({ turnId: decodeURIComponent(m[1]), by: label, ok: sent.ok === true, say: sent.output?.say ?? null, http: res.status(), answered });
    });
  }

  // JOURNEY_VIDEO_DIR records every person's browser as video (Playwright's recordVideo), labelled by user in index.txt.
  function videoOpts() { const dir = process.env.JOURNEY_VIDEO_DIR; return dir ? { recordVideo: { dir, size: { width: 1440, height: 900 } } } : {}; }
  function labelVideos(context, who) {
    const dir = process.env.JOURNEY_VIDEO_DIR; if (!dir) return;
    context.on('page', (pg) => { void pg.video()?.path().then((f) => import('node:fs').then((fs) => fs.appendFileSync(`${dir}/index.txt`, `${who} ${Date.now()} ${f}\n`))).catch(() => undefined); });
  }
  /** A signed-in person with their own browser context and page, the call's SFU stubbed (see the header). */
  async function person(who) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...videoOpts() });
    labelVideos(context, who.userId);
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
    watch(page, who.userId);
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
  /** Every work item with exactly this title, as { id, projectId }, found anywhere in the work list's JSON. */
  const itemsTitled = async (p, title) => {
    const res = await p.api.get(`${PORTAL}/api/graph/work`);
    check(res.status() === 200, `GET the work list answered ${res.status()}`);
    const found = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.title === 'string' && v.title.toLowerCase().includes(title.toLowerCase())) found.push({ id: v.id, projectId: v.projectId ?? v.project_id ?? null, title: v.title }); Object.values(v).forEach(walk); } };
    walk(await res.json());
    return found;
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
    await step('3: the second person sees the notice (the inviter named, speech provider, the retention period set by the organisation, nothing kept until acknowledged); the inviter does not', async () => {
      await seen(nora.page, 'nova-notice');
      const text = (await nora.page.getByTestId('nova-notice').innerText()).replace(/\s+/g, ' ');
      const inviterName = (await (await vera.api.get(`${PORTAL}/api/session/me`)).json()).name;
      check(typeof inviterName === 'string' && inviterName.length > 0, `the inviter has no display name: ${inviterName}`);
      check(text.includes(`${inviterName} invited Nova`), `the notice does not name the inviter "${inviterName}": "${text}"`);
      check(/speech provider/.test(text), `the notice does not say speech goes to a provider: "${text}"`);
      check(/retention period set by your organisation/.test(text) && !/30 days/.test(text), `the notice does not say how long it is kept, or promises a fixed period: "${text}"`);
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
      // The pause notice is Nova speaking quietly: one row at the start under Nova's mark, its sentence in a tinted pill, not centred grey text.
      await seen(vera.page, 'huddle-thread');
      const pausedLine = vera.page.locator('[data-testid="chat-system-line"]').filter({ hasText: /paused Nova\. Nothing is being heard or stored\./ }).last();
      await pausedLine.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no pause notice'); });
      const lineLook = await pausedLine.evaluate((el) => ({ voice: el.getAttribute('data-voice'), mark: !!el.querySelector('[data-testid="assistant-mark"]'),
        pill: !!el.querySelector('[data-testid="chat-assistant-notice"]'), justify: getComputedStyle(el).justifyContent }));
      check(lineLook.voice === 'assistant' && lineLook.mark && lineLook.pill, `the pause notice is not in Nova's voice: ${JSON.stringify(lineLook)}`);
      check(lineLook.justify !== 'center', 'the pause notice is still centred');
      await shot(vera.page, '5-paused');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/);
      await waitMark(nora.page, /^Nova is listening$/);
      const resumed = 'After resume: kept again.';
      await inject(NORA.userId, resumed);
      check(await stored(vera, resumed, 10000), 'a line after resume was not stored');
      return 'paused: both see it, nothing stored; resumed: stored';
    });

    // ── 5b. A spoken pause does what the button does: the same named notice, seen by both ──
    await step('5b: "Nova, pause" said by the second person pauses Nova for both and posts the same named notice as the button; resume brings listening back', async () => {
      const before = (await novaOf(vera, 'assistant-notice')).filter((m) => /paused Nova\. Nothing is being heard or stored\./.test(m.message)).length;
      await inject(NORA.userId, 'Nova, pause.');
      await waitMark(vera.page, /^Nova is paused$/);
      await waitMark(nora.page, /^Nova is paused$/);
      const notices = await waitFor(async () => {
        const all = (await novaOf(vera, 'assistant-notice')).filter((m) => /paused Nova\. Nothing is being heard or stored\./.test(m.message));
        return all.length > before ? all : null;
      }, 20000, 'the spoken pause notice');
      check(!notices.at(-1).message.startsWith(NORA.userId), `the spoken pause notice names an id, not a person: "${notices.at(-1).message}"`);
      check((await stateOf(vera)).pausedBy === NORA.userId, 'the pause is not recorded as the speaker\'s');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/);
      return `paused by voice; notice "${notices.at(-1).message}"`;
    });

    // ── 8. A spoken read is answered in the call chat, labelled with who asked (the scripted session: no model) ──
    await step('8: "Nova, what is two plus two?" from the inviter lands in the call chat as Nova\'s reply to that person; nothing else was asked of the browser', async () => {
      await inject(VERA.userId, 'Nova, what is two plus two?');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).find((m) => m.message === 'Four.'), 20000, 'the reply "Four."');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}, not ${VERA.userId}`);
      check(typeof reply.metadata.askedByName === 'string' && reply.metadata.askedByName.length > 0 && reply.metadata.askedByName !== VERA.userId, `the label has no display name: ${reply.metadata.askedByName}`);
      check((await myTurns(vera)).length === 0, 'a plain answer left a turn for the browser');
      check((await myTurns(nora)).length === 0, 'a plain answer left a turn for the other person');
      // In the chat the reply is Nova's to look at: its mark, the author "Nova" and "Asked by" under the text, as an ordinary row (no
      // tint: the tint belongs to Nova's cards, which stand out against its replies).
      await seen(vera.page, 'huddle-thread');
      const row = vera.page.locator('[data-testid="chat-message"][data-voice="assistant"]').filter({ hasText: 'Four.' }).last();
      await row.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no reply row in Nova\'s voice'); });
      const look = await row.evaluate((el) => ({ mark: !!el.querySelector('[data-testid="assistant-mark"]'), author: el.querySelector('[data-testid="message-row-author"]')?.textContent?.trim() ?? null,
        askedBy: el.querySelector('[data-testid="assistant-reply-asked-by"]')?.textContent?.trim() ?? null,
        tinted: getComputedStyle(el.querySelector('[data-testid="message-row-content"]')).backgroundColor }));
      check(look.mark && look.author === 'Nova', `the reply row shows mark ${look.mark}, author ${look.author}`);
      check(look.askedBy === `Asked by ${reply.metadata.askedByName}`, `the reply's caption reads ${look.askedBy}`);
      check(/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(look.tinted), `the reply text is tinted (${look.tinted}); only Nova's cards are`);
      // The huddle dialogue is its own place: the muted surface behind the messages, its dot field under them, taking no pointer
      // events, and still when the reader asks for reduced motion.
      const surface = vera.page.getByTestId('huddle-dialogue-surface');
      check(await surface.evaluate((el, row) => el.contains(row), await row.elementHandle()), 'the reply is not inside the huddle dialogue surface');
      const ambient = async () => surface.evaluate((el) => {
        const field = el.querySelector('[data-testid="ambient-surface-field"]');
        const dots = field?.firstElementChild;
        return { bg: getComputedStyle(el).backgroundColor, field: !!field, pointer: field ? getComputedStyle(field).pointerEvents : null,
          hidden: field?.getAttribute('aria-hidden'), z: field ? getComputedStyle(field).zIndex : null, animation: dots ? getComputedStyle(dots).animationName : null };
      });
      const moving = await ambient();
      check(moving.field && moving.pointer === 'none' && moving.hidden === 'true' && moving.z === '-1', `the dot field is not decoration: ${JSON.stringify(moving)}`);
      check(!/^(rgba\(0, 0, 0, 0\)|transparent|rgb\(255, 255, 255\))$/.test(moving.bg), `the huddle dialogue has no surface of its own (${moving.bg})`);
      check(moving.animation === 'uic-ambient-drift', `the dot field does not drift (${moving.animation})`);
      await vera.page.emulateMedia({ reducedMotion: 'reduce' });
      const still = await ambient();
      await vera.page.emulateMedia({ reducedMotion: 'no-preference' });
      check(still.animation === 'none', `the dot field still moves under reduced motion (${still.animation})`);
      return `reply "Four." labelled "${reply.metadata.askedByName}" as an ordinary row; the dialogue on ${moving.bg}, its field drifting and still under reduced motion`;
    });

    // ── 8a. A spoken read runs in the asker's own browser ──
    await step('8a: "Nova, search for login" from the inviter: the inviter\'s browser runs the read and posts the result, and Nova\'s reply appears in the chat labelled with the asker', async () => {
      const beforeReplies = (await novaOf(vera, 'assistant-reply')).length;
      const refusedBefore = (await stateOf(vera)).refusedCalls ?? 0;
      await inject(VERA.userId, 'Nova, search for login');
      const reply = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(beforeReplies).find((m) => m.message === 'Here is the result.'), 25000, 'the reply to the search');
      check(reply.metadata.askedBy === VERA.userId, `the reply is labelled for ${reply.metadata.askedBy}`);
      check((await myTurns(vera)).length === 0, 'the read is still waiting for the browser');
      const posted = results_.filter((r) => r.by === VERA.userId && r.ok && r.answered === 'done');
      check(posted.length >= 1, `no result post of the asker's browser was answered "done": ${JSON.stringify(results_)}`);
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
      check((await itemsTitled(vera, 'login cookie bug')).length === 0, 'the work item existed before the card was confirmed');
      const callInitiative = (await stateOf(vera)).initiativeId;
      check(callInitiative === 'p-observability', `the call's initiative is ${callInitiative}`);
      // Both people see the card; only the asker has controls.
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      const noraCard = nora.page.getByTestId('assistant-action-card').filter({ hasText: /login cookie bug/ }).last();
      await veraCard.waitFor({ timeout: 20000 }); await noraCard.waitFor({ timeout: 20000 });
      check(await veraCard.getByTestId('assistant-action-confirm').isVisible(), 'the asker has no Confirm');
      check(await noraCard.getByTestId('assistant-action-confirm').count() === 0 && await noraCard.getByTestId('assistant-action-decline').count() === 0, 'the other person has controls on the card');
      const cardText = await veraCard.innerText();
      check(cardText.includes(card.metadata.summary), `the card does not carry the action's sentence "${card.metadata.summary}": "${cardText}"`);
      check(/title\W.*login cookie bug/i.test(cardText), `the card has no title line: "${cardText}"`);
      check(/Initiative: .+/.test(cardText), `the card names no initiative: "${cardText}"`);
      check(/Waiting for Vera/.test(await noraCard.innerText()), `the other person's card does not say who it waits for: "${await noraCard.innerText()}"`);
      await shot(vera.page, '9-card-waiting-asker'); await shot(nora.page, '9-card-waiting-other');
      const stranger = await nora.api.post(asApi(nora, `actions/${encodeURIComponent(card.metadata.actionId)}/decision`), { data: { decision: 'confirm' } });
      check(stranger.status() === 403, `another person confirming answered ${stranger.status()}, not 403`);
      check((await myTurns(vera)).length === 0, 'another person\'s confirm made a turn');
      await veraCard.getByTestId('assistant-action-confirm').click();
      await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'done'), 25000, 'the card going to done');
      const made = await itemsTitled(vera, 'login cookie bug');
      check(made.length === 1, `${made.length} work items titled "login cookie bug" exist after one confirm, not one: ${JSON.stringify(made)}`);
      check(made[0].projectId === callInitiative, `the work item is on ${made[0].projectId}, the call's initiative is ${callInitiative}`);
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
    await step('9d: "Nova, how much budget do I have" is answered privately: the asker\'s toast reads the answer itself, the call chat shows only "Answered privately for Vera.", and the other person sees nothing', async () => {
      const noraBefore = (await chatMessages(nora)).length;
      const asks = (await novaOf(vera, 'assistant-reply')).length;
      const sentBefore = results_.length;
      await inject(VERA.userId, 'Nova, how much budget do I have?');
      const toast = vera.page.getByText(/only you can see this/i).first();
      await toast.waitFor({ timeout: 25000 });
      const sent = await waitFor(() => results_.slice(sentBefore).find((r) => r.by === VERA.userId && r.ok && typeof r.say === 'string' && r.say.length > 0), 15000, 'the private result post with a say sentence');
      check(sent.answered === 'done', `the private turn was answered "${sent.answered}", not done`);
      await shot(vera.page, '9d-private-toast');
      const toastBox = await toast.evaluate((el) => (el.closest('[role="status"],[role="alert"],[data-testid*="toast"]') ?? el.parentElement).innerText.replace(/\s+/g, ' '));
      check(toastBox.includes(sent.say.replace(/\s+/g, ' ').trim()), `the toast "${toastBox}" does not carry the say sentence "${sent.say}"`);
      await waitFor(async () => (await novaOf(vera, 'assistant-reply')).length === asks + 1, 15000, 'the one public line');
      const line = (await novaOf(vera, 'assistant-reply')).slice(asks);
      check(line.length === 1 && /^Answered privately for Vera/.test(line[0].message), `the call chat got: ${JSON.stringify(line.map((m) => m.message))}`);
      const noraChat = (await chatMessages(nora)).slice(noraBefore).filter((m) => m.metadata?.assistant || m.metadata?.kind);
      check(noraChat.every((m) => /^Answered privately for Vera/.test(m.message)), `the other person's chat carries more than the fixed line: ${JSON.stringify(noraChat.map((m) => m.message))}`);
      check(!(await chatPanel(nora).innerText()).includes(sent.say.slice(0, 40)), 'the private sentence is in the other person\'s chat');
      check(await nora.page.getByText(/only you can see this/i).count() === 0, 'the other person sees the private toast');
      return `toast: "${toastBox.slice(0, 120)}"; public line "${line[0].message}"; other person: the fixed line only`;
    });

    // ── 9f. Two tabs, one confirm, one work item ──
    await step('9f: the asker has a second tab with its own runner: one write card confirmed once is run by exactly one runner, makes exactly one work item on the call\'s initiative, and a second claim and a result with a wrong claim are refused', async () => {
      const tab2 = await vera.context.newPage();
      watch(tab2, `${VERA.userId}#2`);
      await tab2.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await tab2.getByTestId('initiative-header').waitFor({ timeout: 30000 });
      // A second tab cannot be seated in a call that is already running, so its runner is the app's own turn code (the module the footer's
      // runner uses: processTurns, runCallTool, pollChain) started in that tab with the same endpoints. Tab 1's turn list is held empty
      // while the card is confirmed, so the confirmed turn is claimed and run by tab 2's runner alone.
      const initiativeId = (await stateOf(vera)).initiativeId;
      await tab2.evaluate(async ({ base, initiativeId, userId }) => {
        const [turns, core, tools, palette] = await Promise.all([
          import('/src/lib/meetingTurns.ts'), import('/src/lib/voice/runCore.ts'), import('/src/lib/voice/tools.ts'), import('/src/components/shell/portalCommands.ts'),
        ]);
        const log = { polls: 0, claims: [], ran: [], posted: [] };
        const seen = new turns.SeenTurns('walk-tab2-seen'); const pending = new turns.PendingResults('walk-tab2-pending');
        const ctx = { tenant: 'orgiq', role: 'org-leader', switchable: null, userId, userName: null, ledger: new Map(), results: new tools.ResultMemory(),
          palette: { pages: palette.PAGES, visible: palette.isPageVisible }, can: () => true, fetch: (u, i) => fetch(u, i), navigate: () => undefined, now: () => new Date(),
          page: () => ({ path: location.pathname, record: { ref: `initiative:${initiativeId}`, title: 'the call\'s initiative' }, rows: [] }), tabs: () => null };
        const claim = async (turnId) => {
          const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/claim`, { method: 'POST', credentials: 'include', cache: 'no-store' });
          log.claims.push({ turnId, http: res.status });
          return res.status === 404 || res.status === 409 ? { status: 'refused' } : res.ok ? turns.parseClaim(await res.json().catch(() => null)) : { status: 'error' };
        };
        const post = async (turnId, body) => {
          const res = await fetch(`${base}/turns/${encodeURIComponent(turnId)}/result`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          log.posted.push({ turnId, http: res.status }); return res.status;
        };
        const poll = async () => {
          log.polls += 1;
          const res = await fetch(`${base}/turns?mine=1`, { credentials: 'include', cache: 'no-store' });
          if (!res.ok) return false;
          await turns.processTurns(turns.parseTurns(await res.json().catch(() => null)), {
            seen, pending, now: () => Date.now(), claim, post,
            run: async (name, args, write) => { log.ran.push({ name, write }); return core.runCallTool(name, args, ctx, { write }); },
          });
          return true;
        };
        const chain = turns.pollChain({ poll, nextMs: () => 300, schedule: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h) });
        chain.start();
        window.__walkRunner = { log, stop: () => chain.stop() };
      }, { base: `/api/calls/${encodeURIComponent(callId)}/assistant`, initiativeId, userId: VERA.userId });
      const title = 'two tab audit trail';
      const sentBefore = results_.length;
      const holdTab1 = /\/assistant\/turns\?mine=1/;
      await vera.page.route(holdTab1, (route) => route.fulfill({ json: { turns: [] } }));
      try {
        await inject(VERA.userId, `Nova, create a work item for the ${title}.`);
        const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && m.metadata.summary.includes(title)), 20000, 'the action card');
        const cardOnTab1 = vera.page.getByTestId('assistant-action-card').filter({ hasText: title }).last();
        await cardOnTab1.waitFor({ timeout: 20000 });
        await cardOnTab1.getByTestId('assistant-action-confirm').click(); // confirmed once
        await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'done'), 25000, 'the card going to done');
      } finally { await vera.page.unroute(holdTab1); }
      await sleep(6000); // long enough for tab 1 to have polled again, with its list back
      const made = await itemsTitled(vera, title);
      check(made.length === 1, `${made.length} work items titled "${title}" exist after one confirm`);
      check(made[0].projectId === initiativeId, `the item is on ${made[0].projectId}, not the call's initiative`);
      const mine = results_.slice(sentBefore).filter((r) => r.ok && r.http === 200);
      check(mine.length === 1, `the browsers posted ${mine.length} accepted results for one turn: ${JSON.stringify(mine)}`);
      check(mine[0].by === `${VERA.userId}#2`, `the accepted result came from ${mine[0].by}, not the second tab's runner`);
      const log = await tab2.evaluate(() => window.__walkRunner.log);
      check(log.polls >= 3, `the second tab's runner polled ${log.polls} times`);
      check(log.ran.length === 1 && log.ran[0].write === true, `the second tab's runner ran ${JSON.stringify(log.ran)}, not one write`);
      check(log.claims.length >= 1 && log.claims[0].http === 200, `the second tab's claim answered ${JSON.stringify(log.claims)}`);
      // Another claim of the same turn, and a result without its claim, are refused by the server.
      const turnId = mine[0].turnId;
      const url = `/api/calls/${encodeURIComponent(callId)}/assistant/turns/${encodeURIComponent(turnId)}`;
      const again = await vera.page.evaluate(async (u) => {
        const claim = await fetch(`${u}/claim`, { method: 'POST', credentials: 'include' });
        const result = await fetch(`${u}/result`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claimId: 'abcdef0123456789abcdef01', ok: true, output: {} }) });
        return { claim: claim.status, result: result.status };
      }, url);
      check(again.claim === 409, `a second claim answered ${again.claim}, not 409`);
      check(again.result === 409, `a result with a wrong claim answered ${again.result}, not 409`);
      check((await itemsTitled(vera, title)).length === 1, 'the second claim or result made another work item');
      await tab2.evaluate(() => window.__walkRunner.stop());
      await shot(tab2, '9f-two-tabs-card-done');
      await tab2.close();
      return `one item on ${made[0].projectId}; the second tab's runner ran it once (${log.polls} polls); a second claim 409 and a result with a wrong claim 409`;
    });

    // ── 9g. A write whose record is not named exactly fails on its card, and nothing changes ──
    await step('9g: a card for a write that names its record by position is confirmed, the runner refuses it ("Say the record\'s full name."), and the card reads Failed for both', async () => {
      await inject(VERA.userId, 'Nova, I need a hand with something else.');
      await sleep(1500);
      const before = (await itemsTitled(vera, 'login cookie bug'))[0];
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ askedBy: VERA.userId, name: 'update', args: { ref: '1', fields: { status: 'cancelled' } } }),
      });
      check(res.status === 202, `the dev tool call answered ${res.status}`);
      const card = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'update' && m.metadata.status === 'waiting'), 20000, 'the update card');
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: card.metadata.summary }).last();
      await veraCard.waitFor({ timeout: 20000 });
      await veraCard.getByTestId('assistant-action-confirm').click();
      const failed = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card.metadata.actionId && m.metadata.status === 'failed'), 25000, 'the card going to failed');
      check(/full name/i.test(failed.metadata.resultText ?? ''), `the failed card says "${failed.metadata.resultText}", not the exact-name sentence`);
      await waitFor(async () => /Failed/.test(await nora.page.getByTestId('assistant-action-card').filter({ hasText: card.metadata.summary }).last().getByTestId('assistant-action-status').innerText().catch(() => '')), 15000, 'the other person seeing Failed');
      const after = (await itemsTitled(vera, 'login cookie bug'))[0];
      check(before && after && before.id === after.id, 'the work item is gone or changed');
      check((await myTurns(vera)).length === 0, 'a turn is still waiting');
      await shot(vera.page, '9g-card-failed');
      return `failed for both: "${failed.metadata.resultText}"`;
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

    // ── P. Proposals (docs/meeting-consent-design.md, package 2): a read-only card in the call chat, answers in the footer deck ──
    let eli = null;
    const PROPOSAL_1 = 'Cut over the smallest tenants first';
    const PROPOSAL_2 = 'Eli owns the cutover runbook';
    const PROPOSAL_4 = 'Move the cutover review to Thursdays';
    const PROPOSAL_5 = 'Drop the legacy login page after the cutover';
    const PROPOSAL_H = 'Keep the old tenants read-only for a week';
    /** "Recorded · <statement>", or "Recorded as decided · …" / "Recorded as waiting for the owner's decision · …" (how it was made). */
    const recorded = (statement) => new RegExp(`Recorded(?: as decided| as waiting for the owner's decision)? · ${statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const propose = async (body) => {
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-proposals`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      check(res.status === 201, `the dev creator answered ${res.status}`);
      return (await res.json()).proposal?.id ?? body.id;
    };
    const card = (p, id) => p.page.locator(`[data-testid="assistant-proposal-card"][data-proposal-id="${id}"]`).last();
    const cardState = (p, id, state) => waitFor(async () => (await card(p, id).getAttribute('data-state').catch(() => null)) === state, 20000, `${p.who.userId}: the card reading ${state}`);
    const deckOf = (p) => p.page.getByTestId('nova-proposal-ask');
    const askFor = async (p, statement) => { await deckOf(p).filter({ hasText: statement }).waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure(`${p.who.userId}: no deck prompt for "${statement}"`); }); };
    /** A digit pressed in the deck: the prompt's keys act only while focus is in it (`keypad: 'deck'`), never page-wide. */
    const digit = async (p, key, deck = deckOf(p)) => { await deck.locator('[data-composer-prompt-option]').first().focus(); await p.page.keyboard.press(key); };
    /** A digit pressed with focus nowhere in particular (the page body), as a stray key on the call would be. */
    const strayDigit = async (p, key) => { await p.page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined)); await p.page.keyboard.press(key); };
    const inDeck = (p) => p.page.evaluate(() => !!document.activeElement?.closest('[data-testid="nova-proposal-ask"]'));
    const proposalsOf = async (p) => (await (await p.api.get(asApi(p, 'proposals'))).json()).proposals;

    await step('P1: a third person joins the running call from the footer Huddle on the initiative page', async () => {
      eli = await person({ userId: 'u-eli', role: 'sme' });
      const huddle = eli.page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' });
      await huddle.click({ timeout: 30000 });
      await eli.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      await waitFor(async () => (await stateOf(eli)).state === 'listening', 20000, 'the third person seeing Nova listening');
      return 'three people in the call';
    });

    await step('P2a: the lines Nova heard are shown to people who were in the call; a named person who was never in it sees the statement and who raised it, never the lines', async () => {
      const lines = (await (await vera.api.get(asApi(vera, 'transcript?limit=500'))).json()).lines ?? [];
      check(lines.length >= 2, `only ${lines.length} transcript lines to rest on`);
      const evidence = lines.slice(-2).map((l) => l.seq);
      const id = await propose({ id: 'walk-proposal-heard', statement: PROPOSAL_H, outcome: { kind: 'decision' }, executor: VERA.userId, named: ['u-theo'], evidence });
      const mine = (await proposalsOf(vera)).find((p) => p.id === id);
      check(mine?.heard?.length === 2 && mine.heard.every((h) => typeof h.text === 'string' && h.text.length > 0), `the attendee's heard lines: ${JSON.stringify(mine?.heard)}`);
      await card(vera, id).getByTestId('assistant-proposal-heard').waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure('the card shows no heard lines to an attendee'); });
      const away = await browser.newContext(); contexts.push(away);
      check((await away.request.post(`${PORTAL}/api/session/login`, { data: { userId: 'u-theo' } })).status() === 200, 'the absent person could not sign in');
      check((await away.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: 'sme' } })).status() === 200, 'the absent person has no orgiq role');
      const res = await away.request.get(asApi(null, 'proposals'));
      check(res.status() === 200, `the named person who was not there: ${res.status()}`);
      const theirs = (await res.json()).proposals;
      check(theirs.length === 1 && theirs[0].id === id && theirs[0].statement === PROPOSAL_H, `the absent person sees ${JSON.stringify(theirs.map((p) => p.id))}`);
      check(theirs[0].heard.length === 0 && theirs[0].evidence.length === 0, `the absent person was sent the lines: ${JSON.stringify(theirs[0].heard)}`);
      check(!lines.slice(-2).some((l) => JSON.stringify(theirs[0]).includes(l.text)), 'a heard line reached the absent person');
      check(theirs[0].source === 'dev' && theirs[0].askedBy === null, `who raised it: ${theirs[0].source}, ${JSON.stringify(theirs[0].askedBy)}`);
      // Out of the way for the steps that follow (Nova raised it, so anyone seated may).
      const gone_ = await vera.api.post(asApi(vera, `proposals/${id}/response`), { data: { response: 'not-a-decision' } });
      check(gone_.status() === 200, `dismissing it answered ${gone_.status()}`);
      await cardState(vera, id, 'dismissed');
      return `attendee: ${mine.heard.length} lines; absent: 0 lines, the statement only`;
    });

    let p1 = null;
    await step('P2: a decision proposal from the dev creator: one card in the call chat for all three (Proposal, the statement, record as a decision, who it needs, the executor waiting), no buttons', async () => {
      p1 = await propose({ id: 'walk-proposal-1', statement: PROPOSAL_1, outcome: { kind: 'decision' }, executor: VERA.userId });
      const msgs = await novaOf(vera, 'assistant-proposal');
      check(msgs.filter((m) => m.metadata.proposalId === p1).length === 1, `${msgs.length} cards for the proposal`);
      for (const p of [vera, nora, eli]) {
        await card(p, p1).waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure(`${p.who.userId}: no proposal card`); });
        await cardState(p, p1, 'open');
      }
      // The names and the outcome come from the proposals route, read on the state poll (5 s).
      await waitFor(async () => (await card(vera, p1).innerText()).includes('Record as a decision on'), 15000, 'the card filled from the proposals route');
      const text = await card(vera, p1).innerText();
      for (const want of ['Nova heard a decision', PROPOSAL_1, 'Record as a decision', 'Needs you (runs it) and one more person.', 'runs it', 'waiting']) check(text.includes(want), `the card lacks "${want}": ${text.replace(/\s+/g, ' ')}`);
      // Before anyone consents the card says how the decision will be recorded.
      await waitFor(async () => /It will be recorded as (decided|waiting for the initiative owner's decision)\./.test(await card(vera, p1).innerText()), 15000, 'the card saying how it will be recorded');
      // The card asks nothing itself: its only control is Answer, which opens the deck.
      const buttons = (await card(vera, p1).getByRole('button').allInnerTexts()).map((t) => t.trim());
      check(buttons.length === 1 && buttons[0] === 'Answer', `the card's controls: ${JSON.stringify(buttons)}`);
      const noraText = await card(nora, p1).innerText();
      check(noraText.includes('Needs Vera') && noraText.includes('(runs it) and one more person.'), `the second person's needs line: ${noraText.replace(/\s+/g, ' ')}`);
      for (const width of [1440, 1280]) { await vera.page.setViewportSize({ width, height: 900 }); await sleep(400); await card(vera, p1).scrollIntoViewIfNeeded(); await shot(vera.page, 'P2-proposal-card', width); }
      await vera.page.setViewportSize({ width: 1440, height: 900 });
      return text.replace(/\s+/g, ' ').slice(0, 200);
    });

    await step('P3: the deck prompt shows for each person without taking focus: "Nova heard a decision"; the executor\'s option is Consent (hers is not the last one needed), the others are told their answer is optional; Object… and Not a decision', async () => {
      for (const p of [vera, nora, eli]) {
        await askFor(p, PROPOSAL_1);
        const text = await deckOf(p).innerText();
        check(text.includes('Nova heard a decision'), `${p.who.userId}: no eyebrow: ${text}`);
        check(!(await inDeck(p)), `${p.who.userId}: the arriving prompt took keyboard focus`);
        check(await deckOf(p).getByRole('button', { name: /^\s*1?\s*Consent\s*$/ }).count() === 1, `${p.who.userId}: no plain "Consent" option: ${text.replace(/\s+/g, ' ')}`);
        check(!text.includes('Consent and record'), `${p.who.userId}: "Consent and record" while another consent is still needed`);
        check(text.includes('Object…') && text.includes('Not a decision'), `${p.who.userId}: options missing: ${text.replace(/\s+/g, ' ')}`);
        if (p !== vera) check(text.includes('Your answer is optional'), `${p.who.userId}: a bystander is asked as if needed: ${text.replace(/\s+/g, ' ')}`);
      }
      for (const width of [1440, 1280]) { await nora.page.setViewportSize({ width, height: 900 }); await sleep(400); await shot(nora.page, 'P3-deck-prompt', width); }
      await nora.page.setViewportSize({ width: 1440, height: 900 });
      return 'prompted all three';
    });

    await step('P4: Esc hides the prompt; the count on Nova\'s footer mark counts only what waits on you ("1 proposal" for the executor, none for a bystander) and reopens it; a bystander reopens it from the card\'s Answer; with three people and the count the footer row is one line at 1440 and 1280', async () => {
      check(await eli.page.getByTestId('nova-proposal-count').count() === 0, 'a bystander is counted a proposal that does not need them');
      await deckOf(eli).getByRole('button').first().focus();
      await eli.page.keyboard.press('Escape');
      await gone(eli.page, 'nova-proposal-ask');
      await card(eli, p1).getByTestId('assistant-proposal-answer').click();
      await askFor(eli, PROPOSAL_1);
      await deckOf(vera).getByRole('button').first().focus();
      await vera.page.keyboard.press('Escape');
      await gone(vera.page, 'nova-proposal-ask');
      const count = vera.page.getByTestId('nova-proposal-count');
      check((await count.getAttribute('aria-label')) === '1 proposal', `the count is named "${await count.getAttribute('aria-label')}"`);
      check((await count.innerText()).trim() === '1', `the badge reads "${await count.innerText()}"`);
      const lines = [];
      for (const width of [1440, 1280]) {
        await vera.page.setViewportSize({ width, height: 900 }); await sleep(700);
        // markLineStarts flags every slot that starts a line of the wrapping row: one flag is one line.
        // and the call bar keeps its controls on its own one line (no control dropped under another).
        const [starts, dockHeight] = await vera.page.evaluate(() => [
          document.querySelectorAll('[data-testid="shell-footer-row"] > [data-line-start]').length,
          Math.round(document.querySelector('[data-testid="shell-call-dock"]').getBoundingClientRect().height),
        ]);
        lines.push(`${width}: ${starts} line(s), call bar ${dockHeight}px`);
        check(starts === 1, `the footer row wraps onto ${starts} lines at ${width}`);
        check(dockHeight <= 40, `the call bar wraps inside itself at ${width} (${dockHeight}px tall)`);
        await shot(vera.page, 'P4-footer-three-people-count', width);
      }
      await vera.page.setViewportSize({ width: 1440, height: 900 });
      await count.click();
      await askFor(vera, PROPOSAL_1);
      return `hidden and reopened; ${lines.join(', ')}`;
    });

    await step('P5: a stray 1 on the page answers nothing; the second person presses 1 in the deck, then the executor\'s option reads Consent and record and her 1 runs it in her browser; the card ends recorded with a link to the decision for all three; no deck asks any more', async () => {
      await strayDigit(nora, '1'); await strayDigit(nora, 'Enter');
      await sleep(1500);
      check((await proposalsOf(nora)).find((p) => p.id === p1)?.responses.length === 0, 'a digit pressed outside the deck answered the proposal');
      await digit(nora, '1');
      await waitFor(async () => (await proposalsOf(nora)).find((p) => p.id === p1)?.responses.length === 1, 15000, 'the first consent');
      await cardState(vera, p1, 'open');
      await waitFor(async () => (await deckOf(vera).getByRole('button', { name: /^\s*1?\s*Consent and record\s*$/ }).count()) === 1, 15000, 'the executor\'s last consent reading "Consent and record"');
      await digit(vera, '1');
      for (const p of [vera, nora, eli]) await cardState(p, p1, 'done');
      const done = (await proposalsOf(vera)).find((p) => p.id === p1);
      check(done?.run?.by?.userId === VERA.userId && /^\/iq\/decisions\//.test(done?.run?.href ?? ''), `the run: ${JSON.stringify(done?.run)}`);
      check(results_.some((r) => r.by === VERA.userId && r.ok), 'the executor\'s browser posted no result');
      const chipsOf = async () => card(eli, p1).getByTestId('assistant-proposal-person').allInnerTexts();
      await waitFor(async () => (await chipsOf()).filter((t) => t.includes('· consented')).length === 2, 15000, 'two consented chips');
      for (const p of [vera, nora, eli]) {
        await waitFor(async () => recorded(PROPOSAL_1).test(await card(p, p1).innerText()), 15000, `${p.who.userId}: the card's closing line`);
        await card(p, p1).getByTestId('assistant-proposal-result-link').waitFor({ timeout: 15000 }).catch(() => { throw new StepFailure(`${p.who.userId}: no link to the decision`); });
        await gone(p.page, 'nova-proposal-ask');
        await gone(p.page, 'nova-proposal-count');
      }
      await card(vera, p1).scrollIntoViewIfNeeded(); await shot(vera.page, 'P5-proposal-recorded', 1440);
      return `run by ${done.run.by.name}; ${done.run.href}; chips ${(await chipsOf()).join(', ')}`;
    });

    await step('P5b: the card\'s link names the decision page, which says "Agreed in a call by" the two who consented', async () => {
      const href = await card(vera, p1).getByTestId('assistant-proposal-result-link').getAttribute('href');
      check(/^\/iq\/decisions\//.test(href ?? ''), `the link goes to ${href}`);
      const tab = await vera.context.newPage(); watch(tab, 'vera#decision');
      try {
        await tab.goto(`${PORTAL}${href}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await waitFor(async () => /Agreed in a call by/.test(await bodyText(tab)), 30000, 'the decision page saying "Agreed in a call by"');
        const text = await bodyText(tab);
        check(text.includes(PROPOSAL_1), 'the decision page does not show the statement');
        const agreed = /Agreed in a call by [^.]*\./.exec(text)?.[0] ?? '';
        await shot(tab, 'P5b-decision-page', 1440);
        return agreed;
      } finally { await tab.close(); }
    });

    await step('P5c: when the second person\'s consent is the last one needed it stops at consented: nothing runs until the executor\'s own "Run it now"', async () => {
      const p4 = await propose({ id: 'walk-proposal-4', statement: PROPOSAL_4, outcome: { kind: 'decision' }, executor: VERA.userId });
      await askFor(vera, PROPOSAL_4);
      await digit(vera, '1'); // "Consent": hers is not the last one
      await waitFor(async () => (await proposalsOf(vera)).find((p) => p.id === p4)?.responses.length === 1, 15000, 'the executor\'s consent');
      await askFor(nora, PROPOSAL_4);
      await digit(nora, '1');
      for (const p of [vera, nora]) await cardState(p, p4, 'consented');
      const resultsBefore = results_.length;
      await sleep(2500);
      check(results_.length === resultsBefore && (await proposalsOf(vera)).find((p) => p.id === p4)?.state === 'consented', 'it ran without the executor\'s click');
      check((await proposalsOf(vera)).find((p) => p.id === p4)?.you?.canRun === true && (await proposalsOf(nora)).find((p) => p.id === p4)?.you?.canRun === false, 'the run offer is not the executor\'s alone');
      await deckOf(vera).filter({ hasText: 'Ready: run it now' }).waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure('the executor is not asked to run it'); });
      check(await deckOf(vera).getByRole('button', { name: /Run it now/ }).count() === 1, 'no "Run it now" for the executor');
      check(await vera.page.getByTestId('nova-proposal-count').getAttribute('aria-label') === '1 proposal', 'the run offer is not counted as waiting on her');
      await gone(nora.page, 'nova-proposal-ask');
      await shot(vera.page, 'P5c-ready-run-it-now', 1440);
      await digit(vera, '1');
      for (const p of [vera, nora]) await cardState(p, p4, 'done');
      return 'consented, waited, then run by the executor';
    });

    let p2 = null;
    await step('P6: a second proposal naming the third person is objected with a one-line reason the deck labels as shared; the card reads objected with the reason for everyone', async () => {
      p2 = await propose({ id: 'walk-proposal-2', statement: PROPOSAL_2, outcome: { kind: 'decision' }, executor: VERA.userId, named: ['u-eli'] });
      await askFor(eli, PROPOSAL_2);
      await digit(eli, '2');
      await deckOf(eli).filter({ hasText: 'Why do you object? Everyone who can see this proposal will see your reason.' }).waitFor({ timeout: 10000 }).catch(() => { throw new StepFailure('the objection input is not labelled as shared'); });
      const input = deckOf(eli).getByRole('textbox');
      await input.fill("I'm out next week");
      await input.press('Enter');
      for (const p of [vera, nora, eli]) await cardState(p, p2, 'objected');
      await waitFor(async () => (await card(nora, p2).innerText()).includes("I'm out next week"), 15000, 'the reason on the card');
      // What clears it, and the way past it.
      await waitFor(async () => /Blocked until Eli\b.* withdraws the objection, or someone raises it again\./.test(await card(nora, p2).innerText()), 15000, 'the card saying what clears the objection');
      check(await card(nora, p2).getByTestId('assistant-proposal-raise').count() === 1, 'no "Raise it again" on the blocked card');
      return 'objected, reason shown, what clears it said';
    });

    await step('P7: the deck does not ask the objector again; they withdraw quietly from the card, and the card is open again for everyone', async () => {
      check(await deckOf(eli).filter({ hasText: PROPOSAL_2 }).count() === 0, 'the deck asks the objector about their own answer');
      await card(eli, p2).getByTestId('assistant-proposal-withdraw').click();
      for (const p of [vera, nora, eli]) await cardState(p, p2, 'open');
      return 'reopened';
    });

    await step('P8: "Not a decision" (3) from the second person removes it: the card reads so and no deck asks about it; the third person leaves', async () => {
      await askFor(nora, PROPOSAL_2);
      await digit(nora, '3');
      for (const p of [vera, nora, eli]) await cardState(p, p2, 'dismissed');
      // A short receipt for the person who did it, with Undo: it reopens for everyone, and is dismissed again.
      await waitFor(async () => (await card(nora, p2).innerText()).includes('Marked not a decision by you'), 15000, 'the receipt on the card');
      await card(nora, p2).getByTestId('assistant-proposal-undo').click();
      for (const p of [vera, nora, eli]) await cardState(p, p2, 'open');
      check(await card(vera, p2).getByTestId('assistant-proposal-undo').count() === 0, 'someone else may undo the dismissal');
      await askFor(nora, PROPOSAL_2);
      await digit(nora, '3');
      for (const p of [vera, nora, eli]) await cardState(p, p2, 'dismissed');
      for (const p of [vera, nora, eli]) await waitFor(async () => (await deckOf(p).filter({ hasText: PROPOSAL_2 }).count()) === 0, 12000, `${p.who.userId}'s deck letting go of the dismissed proposal`);
      await eli.page.getByTestId('call-dock-leave').first().click({ timeout: 10000 });
      await gone(eli.page, 'call-dock-leave', 20000);
      // Closing the browser too: a third face on the initiative's presence would widen the footer the later steps measure.
      await eli.context.close();
      return 'dismissed, undone and dismissed again; third person out';
    });

    await step('P8b: "Raise it again" on a blocked proposal: the old card reads raised again and a new open proposal with the same statement and outcome asks again', async () => {
      const p5 = await propose({ id: 'walk-proposal-5', statement: PROPOSAL_5, outcome: { kind: 'decision' }, executor: VERA.userId, named: [NORA.userId] });
      const objected = await nora.api.post(asApi(nora, `proposals/${p5}/response`), { data: { response: 'object', reason: 'Support still needs it' } });
      check(objected.status() === 200, `the objection answered ${objected.status()}`);
      await cardState(vera, p5, 'objected');
      await waitFor(async () => /Blocked until Nora\b.* withdraws the objection, or someone raises it again\./.test(await card(vera, p5).innerText()), 15000, 'what clears it');
      await card(vera, p5).getByTestId('assistant-proposal-raise').click();
      await cardState(vera, p5, 'dismissed');
      await waitFor(async () => (await card(vera, p5).innerText()).includes('Raised again as a new proposal'), 15000, 'the old card saying it was raised again');
      const fresh = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.statement === PROPOSAL_5 && p.id !== p5), 15000, 'the new proposal');
      check(fresh.state === 'open' && fresh.responses.length === 0 && fresh.outcome.kind === 'decision' && fresh.named.map((x) => x.userId).join() === NORA.userId, `the new one: ${JSON.stringify({ state: fresh.state, responses: fresh.responses })}`);
      await card(vera, fresh.id).waitFor({ timeout: 20000 });
      check(await card(vera, p5).getByTestId('assistant-proposal-raise').count() === 0, 'it may be raised again twice');
      // Out of the way for the steps that follow.
      check((await vera.api.post(asApi(vera, `proposals/${fresh.id}/response`), { data: { response: 'not-a-decision' } })).status() === 200, 'could not dismiss the new one');
      await cardState(vera, fresh.id, 'dismissed');
      return `raised again as ${fresh.id}`;
    });

    // ── P10. An asked write that names another person (package 7) is a proposal needing them, not the asker's card ──
    await step('P10: "create a work item ... assigned to Nora" asked by the inviter is a proposal card "Asked by" her needing Nora with her as executor, its outcome in words, and no action card; Nora may not drop it, the asker does', async () => {
      await inject(VERA.userId, 'Nova, I need a hand with one more thing.');
      await sleep(1500);
      const actionsBefore = (await novaOf(vera, 'assistant-action')).length;
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/assistant-tool-call`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askedBy: VERA.userId, name: 'create', args: { kind: 'work-item', fields: { title: 'Walk named runbook', assignee: 'Nora' } } }),
      });
      check(res.status === 202, `the dev tool call answered ${res.status}`);
      const asked = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'asked' && /Walk named runbook/.test(p.statement)), 15000, 'the asked proposal');
      check(asked.executor?.userId === VERA.userId && asked.named.map((x) => x.userId).join() === NORA.userId, `executor ${asked.executor?.userId}, named ${asked.named.map((x) => x.userId).join()}`);
      for (const p of [vera, nora]) await card(p, asked.id).waitFor({ timeout: 20000 });
      check((await novaOf(vera, 'assistant-action')).length === actionsBefore, 'an action card was posted for a write naming another person');
      // Who asked, and what will be written, in words.
      check(asked.askedBy?.userId === VERA.userId && /^Create a work item titled "Walk named runbook", owned by /.test(asked.outcome?.summary ?? ''), `asked by ${asked.askedBy?.userId}; "${asked.outcome?.summary}"`);
      await waitFor(async () => /Asked by Vera/.test(await card(nora, asked.id).getByTestId('assistant-proposal-eyebrow').innerText()), 15000, 'the card naming who asked');
      check(!/Run create/.test(await card(nora, asked.id).innerText()), 'the card names the tool');
      // Only the asker may drop a proposal they asked for.
      const notYours = await nora.api.post(asApi(nora, `proposals/${encodeURIComponent(asked.id)}/response`), { data: { response: 'not-a-decision' } });
      check(notYours.status() === 403, `someone other than the asker dropped it: ${notYours.status()}`);
      const gone2 = await vera.api.post(asApi(vera, `proposals/${encodeURIComponent(asked.id)}/response`), { data: { response: 'not-a-decision' } });
      check(gone2.status() === 200, `the asker's drop answered ${gone2.status()}`);
      for (const p of [vera, nora]) await cardState(p, asked.id, 'dismissed');
      return `proposal ${asked.state} -> dismissed; "${asked.statement}"`;
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

    // ── 7b. Nova's voice (package 7b): off by default, on by an inviter, played in both browsers, muted per person ──
    // The page counts what it scheduled in data-voice-* attributes on the mark; headless sound is not asserted.
    const voiceOf = async (p) => {
      const a = await p.page.getByTestId('nova-mark').first().evaluate((el) => ({
        on: el.getAttribute('data-voice') === 'true', muted: el.getAttribute('data-voice-muted') === 'true',
        frames: Number(el.getAttribute('data-voice-frames')), ignored: Number(el.getAttribute('data-voice-ignored')), lastSeq: Number(el.getAttribute('data-voice-last-seq')),
      }));
      return a;
    };
    const watchSpeaking = (p) => p.page.evaluate(() => {
      const el = document.querySelector('[data-testid="nova-mark"]');
      window.__novaSeen = { speaking: false, listeningAfter: false };
      new MutationObserver(() => {
        const t = (el.innerText || '').trim();
        if (/Nova is speaking/.test(t)) window.__novaSeen.speaking = true;
        else if (window.__novaSeen.speaking && /Nova is listening/.test(t)) window.__novaSeen.listeningAfter = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    const ask = async () => { await inject(VERA.userId, 'Nova, what is two plus two?'); };
    const voiceWords = async (p) => (await (await p.api.get(asApi(p, 'state'))).json());

    await step('7b-a: voice is off by default: after a spoken request the asker\'s page scheduled no frames and the server relayed none', async () => {
      const before = await voiceOf(vera);
      check(before.on === false, 'voice reads on before anyone turned it on');
      await ask();
      await sleep(4000);
      const after = await voiceOf(vera);
      check(after.frames === 0, `${after.frames} frames played with voice off`);
      const st = await voiceWords(vera);
      check(st.voice === false && (st.voiceFramesRelayed ?? 0) === 0, `state: voice=${st.voice} relayed=${st.voiceFramesRelayed}`);
      return 'no frames with voice off';
    });

    await step('7b-b: the inviter turns the voice on: both see the notice in the chat and the mark says so', async () => {
      await novaMenu(vera, "Turn Nova's voice on");
      for (const p of [vera, nora]) {
        await waitFor(async () => (await voiceOf(p)).on, 15000, `${p.who.userId} seeing voice on`);
        await waitFor(async () => /turned Nova's voice on/.test(await bodyText(p.page)), 15000, `${p.who.userId} seeing the notice`);
        const label = await p.page.getByTestId('nova-mark').first().getAttribute('aria-label');
        check(/Nova's voice is on/.test(label ?? ''), `the mark does not say voice is on: "${label}"`);
      }
      await vera.page.getByTestId('nova-mark').click();
      check(await vera.page.getByRole('menuitem', { name: "Turn Nova's voice off" }).isVisible(), 'no "Turn Nova\'s voice off" item');
      check(await vera.page.getByRole('menuitem', { name: 'Mute Nova for me' }).isVisible(), 'no "Mute Nova for me" item');
      await shot(vera.page, '7b-voice-menu');
      await vera.page.keyboard.press('Escape');
      return 'voice on: notice and mark in both pages';
    });

    await step('7b-c: a spoken request: both pages schedule frames with increasing seq, the mark reads "Nova is speaking" and goes back to listening', async () => {
      await watchSpeaking(vera); await watchSpeaking(nora);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      for (const [p, b] of [[vera, v0], [nora, n0]]) {
        await waitFor(async () => (await voiceOf(p)).frames > b.frames, 20000, `${p.who.userId} scheduling frames`);
      }
      await sleep(2500);
      for (const [p, b] of [[vera, v0], [nora, n0]]) {
        const a = await voiceOf(p);
        check(a.frames - b.frames >= 5, `${p.who.userId} scheduled only ${a.frames - b.frames} frames`);
        check(a.lastSeq > b.lastSeq, `${p.who.userId}: seq did not rise (${b.lastSeq} -> ${a.lastSeq})`);
        const seen = await p.page.evaluate(() => window.__novaSeen);
        check(seen.speaking, `${p.who.userId}: the mark never read "Nova is speaking"`);
        check(seen.listeningAfter, `${p.who.userId}: the mark did not return to "Nova is listening"`);
        await waitMark(p.page, /^Nova is listening$/);
      }
      return `frames in both pages, seq ${(await voiceOf(vera)).lastSeq}`;
    });

    await step('7b-c2: while frames play the mark reads "Nova is speaking" (screenshot)', async () => {
      const v0 = await voiceOf(vera);
      await ask();
      await waitMark(vera.page, /^Nova is speaking$/, 20000);
      // At once: the mark holds "speaking" only 400 ms after the last frame, so `shot`'s settle delay would miss it.
      await vera.page.screenshot({ path: path.join(SHOTS, '7b-speaking-1280.png') });
      await waitFor(async () => (await voiceOf(vera)).frames > v0.frames, 5000, 'frames');
      await waitMark(vera.page, /^Nova is listening$/);
      return 'speaking mark captured';
    });

    await step('7b-d: the second person mutes Nova: on the next request their page plays nothing and the asker\'s still does; unmute brings it back', async () => {
      await novaMenu(nora, 'Mute Nova for me');
      await waitFor(async () => (await voiceOf(nora)).muted, 5000, 'the mute');
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await waitFor(async () => (await voiceOf(vera)).frames > v0.frames, 20000, 'the asker\'s frames');
      await sleep(3000);
      check((await voiceOf(nora)).frames === n0.frames, 'a muted page scheduled frames');
      await novaMenu(nora, 'Unmute Nova for me');
      await waitFor(async () => !(await voiceOf(nora)).muted, 5000, 'the unmute');
      const n1 = await voiceOf(nora); const v1 = await voiceOf(vera);
      await sleep(1500);
      await ask();
      await waitFor(async () => (await voiceOf(nora)).frames > n1.frames, 20000, 'frames after unmute');
      check((await voiceOf(vera)).frames > v1.frames, 'the asker stopped hearing Nova');
      return 'muted page silent, others unaffected, unmute restores';
    });

    await step('7b-e: paused: a request plays nothing on either page; resume brings it back', async () => {
      await sleep(2500);
      await novaMenu(vera, 'Pause Nova');
      await waitMark(vera.page, /^Nova is paused$/); await waitMark(nora.page, /^Nova is paused$/);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await sleep(4000);
      check((await voiceOf(vera)).frames === v0.frames && (await voiceOf(nora)).frames === n0.frames, 'frames were scheduled while Nova was paused');
      await novaMenu(vera, 'Resume Nova');
      await waitMark(vera.page, /^Nova is listening$/); await waitMark(nora.page, /^Nova is listening$/);
      return 'nothing scheduled while paused';
    });

    await step('7b-f: voice off: a request plays nothing and both pages say so', async () => {
      await novaMenu(vera, "Turn Nova's voice off");
      for (const p of [vera, nora]) await waitFor(async () => !(await voiceOf(p)).on, 15000, `${p.who.userId} seeing voice off`);
      await sleep(1500);
      const v0 = await voiceOf(vera); const n0 = await voiceOf(nora);
      await ask();
      await sleep(4000);
      check((await voiceOf(vera)).frames === v0.frames && (await voiceOf(nora)).frames === n0.frames, 'frames were scheduled with voice off');
      await barFits(vera.page, 'the bar with the voice items', 1280);
      return 'nothing scheduled with voice off';
    });

    // ── 6. Dismiss ──
    let expiryCard = null;
    await step('6a: a write card nobody confirms stays waiting for both people', async () => {
      await inject(VERA.userId, 'Nova, create a work item for the expiry audit.');
      expiryCard = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.tool?.name === 'create' && m.metadata.summary.includes('expiry audit')), 20000, 'the card');
      check(expiryCard.metadata.status === 'waiting', `the card is ${expiryCard.metadata.status}`);
      for (const p of [vera, nora]) await p.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last().waitFor({ timeout: 20000 });
      return 'waiting for both';
    });

    const PROPOSAL_3 = 'Freeze schema changes during the cutover';
    let p3 = null;
    await step('P9: a third proposal for the executor: the second person consents in the call and it waits for her', async () => {
      p3 = await propose({ id: 'walk-proposal-3', statement: PROPOSAL_3, outcome: { kind: 'decision' }, executor: VERA.userId });
      await askFor(nora, PROPOSAL_3);
      await digit(nora, '1');
      await waitFor(async () => (await proposalsOf(nora)).find((p) => p.id === p3)?.responses.length === 1, 15000, 'the consent');
      for (const p of [vera, nora]) await cardState(p, p3, 'open');
      await askFor(vera, PROPOSAL_3);
      return 'open, waiting for the executor';
    });

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
      const againError = (await again.json().catch(() => ({}))).error;
      check(againError === 'Nova has already left this call and cannot rejoin it.', `the re-invite refusal reads "${againError}"`);
      check(await vera.page.getByTestId('nova-roster-entry').count() === 0, 'Nova stayed in the roster');
      await barFits(vera.page, 'the bar after dismissal', 1280);
      await shot(vera.page, '6-left');
      // An unfinished proposal moves to the meeting page: the footer asks no more, and it waits 72 hours.
      await gone(vera.page, 'nova-proposal-ask');
      const open = (await proposalsOf(vera)).find((p) => p.id === p3);
      check(open?.state === 'open' && typeof open.expiresAt === 'number' && open.expiresAt - Date.now() > 71 * 3600_000, `the open proposal after the dismissal: ${JSON.stringify({ state: open?.state, expiresAt: open?.expiresAt })}`);
      return 'left; re-invite 409; the open proposal expires in 72 h';
    });

    await step('6b: with Nova dismissed the unconfirmed card reads Expired for both, says Nova was dismissed (not that its asker failed to confirm), and nothing was created', async () => {
      const expired = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === expiryCard.metadata.actionId && m.metadata.status === 'expired'), 20000, 'the card going to expired');
      check(expired.metadata.resultText === 'Nova was dismissed before this was done.', `the expired card says "${expired.metadata.resultText}"`);
      for (const p of [vera, nora]) {
        const card = p.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last();
        await waitFor(async () => /Expired/.test(await card.getByTestId('assistant-action-status').innerText().catch(() => '')), 15000, `${p.who.userId} seeing Expired`);
        check(await card.getByTestId('assistant-action-confirm').count() === 0, `${p.who.userId} still has Confirm on an expired card`);
      }
      check((await itemsTitled(vera, 'expiry audit')).length === 0, 'an expired card created the work item');
      await shot(vera.page, '6b-card-expired');
      return `expired for both: "${expired.metadata.resultText}"`;
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
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...videoOpts() });
      labelVideos(context, LAYLA.userId);
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

    await step('12: after the dismissal Nova leaves one minutes card in the call chat, in its own voice: "Meeting minutes", the summary, the counts of decisions (the decision consented through a proposal included), action items and proposals, no path in its text, and a link element "Open the meeting page" that goes to the meeting page', async () => {
      const msg = await waitFor(async () => (await chatMessages(vera)).find((m) => m.metadata?.kind === 'assistant-notice' && m.metadata?.minutes), 20000, 'the minutes message in the call chat');
      check(msg.userId === 'agent:nova' || msg.metadata?.assistant === true, 'the minutes message is not Nova\'s');
      const counts = msg.metadata.minutes;
      check(['decisions', 'actionItems', 'proposals'].every((k) => Number.isInteger(counts[k])), `no counts on the message: ${JSON.stringify(counts)}`);
      // P5 recorded a decision through a consented proposal before the dismissal: the count holds it, on top of the minutes' own decision lines.
      const minutes = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      const agreed = (minutes.proposals ?? []).filter((p) => p.outcome === 'decision' && ['consented', 'running', 'done'].includes(p.state)).length;
      check(agreed >= 1, `no decision was consented through a proposal before the minutes: ${JSON.stringify(minutes.proposals)}`);
      check(counts.decisions === minutes.decisions.length + agreed, `the card counts ${counts.decisions} decisions; the minutes hold ${minutes.decisions.length} and ${agreed} through proposals`);
      check(counts.actionItems === minutes.actionItems.length && counts.proposals === (minutes.proposals ?? []).length, `the counts ${JSON.stringify(counts)} differ from the minutes`);
      check(!msg.message.includes('/iq/meetings'), `the text still carries a path: "${msg.message}"`);
      check(msg.metadata?.meetingCallId === callId, `the message carries meetingCallId ${msg.metadata?.meetingCallId}, not ${callId}`);
      check(/ said: /.test(msg.message), `no summary in "${msg.message}"`);
      const all = (await chatMessages(vera)).filter((m) => m.metadata?.minutes);
      check(all.length === 1, `${all.length} minutes messages were posted`);
      const card = vera.page.getByTestId('assistant-minutes-card').last();
      await card.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no minutes card'); });
      check((await card.getByTestId('assistant-minutes-title').innerText()).trim() === 'Meeting minutes', 'the minutes card has no "Meeting minutes" title');
      check((await card.getByTestId('assistant-minutes-summary').innerText()).trim().length > 0, 'the minutes card shows no summary');
      const shown = (await card.getByTestId('assistant-minutes-counts').innerText()).replace(/\s+/g, ' ');
      check(shown.includes(`${counts.decisions} decision`) && shown.includes(`${counts.actionItems} action item`) && shown.includes(`${counts.proposals} proposal`), `the card shows "${shown}" for ${JSON.stringify(counts)}`);
      check(await card.evaluate((el) => el.closest('[data-testid="chat-message"]')?.getAttribute('data-voice') === 'assistant'), 'the minutes card is not in a row in Nova\'s voice');
      // Nova's cards carry its tint against the plain replies: the minutes card, and every action and proposal card in the chat.
      const tones = await vera.page.locator('[data-testid="assistant-minutes-card"], [data-testid="assistant-action-card"], [data-testid="assistant-proposal-card"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-tone')));
      check(tones.length >= 3 && tones.every((t) => t === 'assistant'), `Nova's cards are not all tinted: ${JSON.stringify(tones)}`);
      await card.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(vera.page, '12-chat-minutes', width);
      const expected = `/iq/meetings/${encodeURIComponent(callId)}`;
      const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
      await link.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no meeting link under the closing notice'); });
      check(await link.evaluate((el) => el.tagName) === 'A', 'the meeting link is not an anchor');
      check((await link.getAttribute('href')) === expected, `the link goes to ${await link.getAttribute('href')}, not ${expected}`);
      check(/^Open the meeting page$/.test((await link.innerText()).trim()), `the link reads "${await link.innerText()}"`);
      check(await vera.page.getByTestId('assistant-notice-meeting-link').count() === 1, 'more than one meeting link in the chat');
      await link.click();
      await vera.page.waitForURL((u) => u.pathname === expected, { timeout: 20000 }).catch(() => { throw new StepFailure(`clicking the link did not open ${expected}: ${vera.page.url()}`); });
      await seen(vera.page, 'meeting-page', 30000);
      await vera.page.goBack({ waitUntil: 'domcontentloaded' });
      await vera.page.getByTestId('shell-footer-row').waitFor({ timeout: 30000 });
      return `"${msg.message.slice(0, 160)}"; ${shown}; link ${expected}`;
    });

    // The minutes steps read in a fresh tab of each person, so the first tabs stay in the call until step 18.
    const veraM = { who: VERA, page: await vera.context.newPage() }; const noraM = { who: NORA, page: await nora.context.newPage() };
    watch(veraM.page, 'vera#m'); watch(noraM.page, 'nora#m');
    await step('13: the meeting page renders for an attendee at 1440 and 1280 with the summary, the action item for the work item made in the call (by its title) and the transcript with speaker names', async () => {
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-page', 30000);
      await seen(veraM.page, 'meeting-summary');
      await seen(veraM.page, 'meeting-action-items');
      const out = [];
      for (const width of [1440, 1280]) {
        await fitsWidth(veraM.page, 'the meeting page', width);
        const text = await bodyText(veraM.page);
        check(/Nova invited by /.test(text), 'the header does not say who invited Nova');
        check(/summary/i.test(text) && /decisions/i.test(text) && /action items/i.test(text) && /transcript/i.test(text), `a section is missing at ${width}: ${text.slice(0, 300)}`);
        const summary = (await veraM.page.getByTestId('meeting-summary').innerText()).trim();
        check(summary.length > 10, 'the summary is empty');
        const items = (await veraM.page.getByTestId('meeting-action-items').innerText()).replace(/\s+/g, ' ');
        check(/login cookie bug/i.test(items), `the action items do not hold the work item created in the call (by its title): "${items}"`);
        check((await itemsTitled(vera, 'login cookie bug')).length === 1, 'the work item the action item names does not exist exactly once');
        // Speaker names, not ids: the transcript lines were injected for u-nora and u-vera.
        check(/Nora/.test(text), 'Nora is not named in the transcript');
        check(!/\bu-nora\b|\bu-vera\b/.test(text), 'a raw user id shows on the page');
        check(text.includes('After resume: kept again.'), 'a transcript line is missing');
        out.push(`${width}: ok`);
      }
      await veraM.page.setViewportSize({ width: 1280, height: 900 });
      await veraM.page.evaluate(() => window.scrollTo(0, 0));
      await sleep(400);
      await veraM.page.screenshot({ path: path.join(SHOTS, '13-meeting-page-1280.png'), fullPage: false });
      return out.join(', ');
    });

    await step('13a: the meeting page says what Nova covered (its listening time, a pause, a count of people not transcribed, never their names) and how long the meeting is kept and who can delete it sooner', async () => {
      const api = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      check(api.coverage && typeof api.coverage.listenedSeconds === 'number', `the minutes carry no coverage: ${JSON.stringify(api.coverage)}`);
      const meta = (await veraM.page.getByTestId('meeting-meta').innerText()).replace(/\s+/g, ' ');
      check(/Nova listened for (under a minute|\d+ min|\d+ h)/.test(meta), `the meta line does not say how long Nova listened: "${meta}"`);
      if (api.coverage.pausedSeconds >= 60) check(/paused for \d/.test(meta), `Nova paused ${api.coverage.pausedSeconds}s but the meta line says "${meta}"`);
      const n = api.coverage.untranscribed;
      check(n > 0 ? meta.includes(n === 1 ? '1 person was not transcribed' : `${n} people were not transcribed`) : !/not transcribed/.test(meta), `${n} not transcribed, the meta line says "${meta}"`);
      check(!/\bu-[a-z]+\b/.test(meta), 'an id shows in the meta line');
      // The retention the server knows, from the end time; the inviter reads "You can delete it sooner".
      check(typeof api.keptUntil === 'number' && api.keptUntil > api.endedAt + 86_400_000, `keptUntil is ${api.keptUntil} for a meeting that ended ${api.endedAt}`);
      const kept = (await veraM.page.getByTestId('meeting-kept').innerText()).trim();
      check(/^Kept until \d{1,2} [A-Z][a-z]{2,3} \d{4}\. You can delete it sooner\.$/.test(kept), `the inviter reads "${kept}"`);
      return `"${meta}"; "${kept}"`;
    });

    await step('13a2: written minutes cannot be written again: no "Write the minutes again" on the page, the API refuses, and the empty-section wording stays for minutes that were written', async () => {
      const api = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      check(api.writer !== 'none' && api.rewrite && api.rewrite.possible === false, `the minutes say ${JSON.stringify({ writer: api.writer, rewrite: api.rewrite })}`);
      check(await veraM.page.getByTestId('meeting-rewrite-button').count() === 0, 'written minutes offer "Write the minutes again"');
      check(!(await bodyText(veraM.page)).includes('Not available because the minutes could not be written'), 'written minutes say they could not be written');
      const again = await vera.api.post(asApi(vera, 'minutes/rewrite'), { data: {} });
      const body = await again.json().catch(() => ({}));
      check(again.status() === 409 && body.code === 'MINUTES_WRITTEN', `asking for written minutes again answered ${again.status()} ${JSON.stringify(body)}`);
      return 'no button; API 409 MINUTES_WRITTEN';
    });

    await step('13a3: each attendee\'s bell holds one "Minutes from <meeting> are ready" that opens the meeting page', async () => {
      const api = await (await nora.api.get(asApi(nora, 'minutes'))).json();
      const title = `Minutes from ${api.callName} are ready`;
      await noraM.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(noraM.page, 'activity-bell', 30000);
      let lines = [];
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        await noraM.page.getByTestId('activity-bell').first().click();
        const panel = noraM.page.locator('[role="dialog"]').last();
        await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
        const all = panel.getByRole('tab', { name: /^All/ });
        if (await all.count()) await all.first().click().catch(() => undefined);
        lines = (await panel.innerText().catch(() => '')).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('Minutes from '));
        if (lines.length) break;
        await noraM.page.keyboard.press('Escape');
        await sleep(1500);
      }
      check(lines.filter((l) => l === title).length === 1, `the bell holds ${JSON.stringify(lines)}, not one "${title}"`);
      check(!lines.some((l) => /login cookie|canary|rollout/i.test(l)), 'the notification carries words of the meeting');
      await noraM.page.keyboard.press('Escape');
      return `"${title}"`;
    });

    await step('13b: the meeting page lists the proposals with the call\'s card; the executor is asked there, consents (1), it runs in her browser on that page and the card ends recorded with its link', async () => {
      await seen(veraM.page, 'meeting-proposals', 20000);
      const cardM = card(veraM, p3);
      await cardM.waitFor({ timeout: 15000 }).catch(() => { throw new StepFailure('no card for the open proposal on the meeting page'); });
      check((await cardM.getAttribute('data-state')) === 'open', `the card is ${await cardM.getAttribute('data-state')}`);
      check(await card(veraM, p1).getAttribute('data-state') === 'done', 'the recorded proposal is not listed as done');
      // The meeting page asks in its own composer's deck (the page's command host), with the call's own prompt.
      const deckM = veraM.page.getByTestId('collection-command-host');
      await deckM.filter({ hasText: PROPOSAL_3 }).waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure('the meeting page does not ask about the open proposal'); });
      const ask = await deckM.innerText();
      check(ask.includes('Consent and record') && !ask.includes('Not a decision'), `the meeting page's prompt: ${ask.replace(/\s+/g, ' ')}`);
      await shot(veraM.page, '13b-meeting-proposal-ask', 1280);
      await digit(veraM, '1', deckM);
      await cardState(veraM, p3, 'done');
      await waitFor(async () => recorded(PROPOSAL_3).test(await cardM.innerText()), 20000, 'the closing line on the meeting page');
      await cardM.getByTestId('assistant-proposal-result-link').waitFor({ timeout: 15000 });
      check(results_.some((r) => r.by === 'vera#m' && r.ok), 'the meeting page posted no result');
      const minutes = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      const listed = (minutes.proposals ?? []).find((p) => p.id === p3);
      check(listed?.state === 'done' && listed.consentedBy.length === 2, `the minutes list it as ${JSON.stringify(listed)}`);
      await cardM.scrollIntoViewIfNeeded(); await shot(veraM.page, '13b-meeting-proposal-recorded', 1280);
      return `recorded on the meeting page; minutes: ${listed.state}, consented by ${listed.consentedBy.join(' and ')}`;
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
      // Someone who was not in the call is never told that a record existed: the same neutral sentence as for a meeting that never was.
      check(text.includes('There is no meeting record here. It may have been deleted, removed after the retention period, or you were not in that call.'), `the not-found page reads "${text.slice(0, 300)}"`);
      return 'API 404 x2; "Meeting not found" page';
    });

    await step('15: the Meetings list shows the meeting to an attendee (the row found by its own title), table first, and not to the outsider', async () => {
      await veraM.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'iq-meetings-table', 30000);
      const listed = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      const own = listed.meetings.find((m) => m.callId === callId);
      check(own && typeof own.callName === 'string' && own.callName.length > 0, `the API list has no title for this call: ${JSON.stringify(listed).slice(0, 200)}`);
      const row = veraM.page.getByTestId('iq-meetings-table').getByText(own.callName, { exact: true }).first();
      await row.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new StepFailure('the meeting is not in the list'); });
      for (const width of [1440, 1280]) {
        await fitsWidth(veraM.page, 'the Meetings list', width);
        const top = await row.evaluate((el) => el.getBoundingClientRect().top).catch(() => null);
        check(top !== null && top < 600, `the first row starts at ${top}px: the table is not above the fold at ${width}`);
      }
      const text = await bodyText(veraM.page);
      check(/Nora/.test(text), 'the list does not name the people');
      await veraM.page.setViewportSize({ width: 1280, height: 900 });
      await sleep(400);
      await veraM.page.screenshot({ path: path.join(SHOTS, '15-meetings-list-1280.png'), fullPage: false });
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

    // People's own messages in the call chat before the delete, so 17b can check the delete left them alone.
    let peopleBeforeDelete = null;
    await step('17: only the inviter sees Delete; deleting (after the confirm step) tells the people who were there it was deleted, makes the transcript 404, and leaves the outsider a plain 404', async () => {
      peopleBeforeDelete = (await chatMessages(vera)).filter((m) => m.userId !== 'agent:nova' && m.metadata?.assistant !== true).map((m) => m.id);
      await noraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(noraM.page, 'meeting-page', 30000);
      check(await noraM.page.getByTestId('meeting-delete').count() === 0, 'a person who did not invite Nova is offered Delete');
      const keptForNora = (await noraM.page.getByTestId('meeting-kept').innerText()).trim();
      check(/^Kept until .+\. .+ can delete it sooner\.$/.test(keptForNora) && !keptForNora.includes('You can'), `an attendee who did not invite Nova reads "${keptForNora}"`);
      const refused = await nora.api.delete(asApi(nora, 'minutes'));
      check(refused.status() === 403, `a non-inviter deleting answered ${refused.status()}`);
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-delete', 30000);
      await veraM.page.getByTestId('meeting-delete').click();
      await shot(veraM.page, '17-delete-prompt');
      await veraM.page.getByRole('button', { name: /Delete the meeting/ }).click();
      await veraM.page.waitForURL(/\/iq\/meetings$/, { timeout: 20000 }).catch(() => { throw new StepFailure('deleting did not return to the Meetings list'); });
      // The people who were there are told it was deleted (410); the transcript is gone (404); the outsider still gets the plain 404.
      for (const p of [vera, nora]) {
        const a = await p.api.get(asApi(p, 'minutes')); const b = await p.api.get(asApi(p, 'transcript'));
        const code = (await a.json().catch(() => ({}))).code;
        check(a.status() === 410 && code === 'MEETING_DELETED' && b.status() === 404, `${p.who.userId}: minutes ${a.status()} ${code}, transcript ${b.status()} after the delete`);
      }
      const outsiderAfter = await layla.api.get(asApi(layla, 'minutes'));
      check(outsiderAfter.status() === 404, `the outsider's minutes answered ${outsiderAfter.status()} after the delete`);
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-not-found', 30000);
      check((await bodyText(veraM.page)).includes('This meeting\'s record was deleted.'), 'the inviter\'s page does not say the record was deleted');
      const list = await (await vera.api.get(`${PORTAL}/api/meetings`)).json();
      check(!list.meetings.some((m) => m.callId === callId), 'the deleted meeting is still listed');
      return 'non-inviter: no button, 403; inviter: confirm, then "deleted" on the page, 410 minutes and 404 transcript for attendees, 404 for the outsider, gone from the list';
    });
    await step('17b: after the delete the call chat says it once: one plain line from Nova ("This record was deleted…"), no card, no words of the meeting, no link to the page, and people\'s messages stay', async () => {
      const all = await chatMessages(vera);
      const nova = all.filter((m) => m.userId === 'agent:nova' || m.metadata?.assistant === true);
      check(nova.length === 1, `Nova has ${nova.length} messages in the chat after the delete: ${JSON.stringify(nova.map((m) => m.message)).slice(0, 300)}`);
      check(nova[0].message === 'This record was deleted by the person who invited Nova.', `Nova's line reads "${nova[0].message}"`);
      check(!['assistant-action', 'assistant-proposal'].includes(nova[0].metadata?.kind) && nova[0].metadata?.askedBy === undefined, `the line is still a card: ${JSON.stringify(nova[0].metadata)}`);
      const peopleAfter = all.filter((m) => m.userId !== 'agent:nova' && m.metadata?.assistant !== true).map((m) => m.id);
      check(peopleBeforeDelete !== null && JSON.stringify(peopleAfter) === JSON.stringify(peopleBeforeDelete), `people's messages changed with the delete: ${JSON.stringify(peopleBeforeDelete)} before, ${JSON.stringify(peopleAfter)} after`);
      const blob = JSON.stringify(nova);
      for (const word of ['login cookie bug', 'two tab audit', 'expiry audit', 'nightly export', 'meetingCallId']) check(!blob.toLowerCase().includes(word.toLowerCase()), `"${word}" is still in Nova's messages`);
      await sleep(3500); // the page's own refresh
      check(await vera.page.getByTestId('assistant-notice-meeting-link').count() === 0, 'the chat still shows a link to the deleted meeting page');
      const shownLines = await vera.page.getByText('This record was deleted by the person who invited Nova.', { exact: true }).count();
      check(shownLines === 1, `the open chat shows the deleted line ${shownLines} times`);
      check(await vera.page.getByTestId('assistant-action-card').count() === 0 && await vera.page.getByTestId('assistant-proposal-card').count() === 0, 'the open chat still draws Nova\'s cards');
      return `one line "${nova[0].message}", shown once; ${peopleAfter.length} people's messages kept`;
    });
    // ── 18. Both people leave; the footer renders on; no page error in the whole walk ──
    await step('18: both people leave the call: the footer still renders with the call gone, and no page error happened in the whole walk', async () => {
      const ended = [];
      // (When the first person leaves a two-person call the call can end for the second, whose button then reads Dismiss.)
      for (const p of [vera, nora]) {
        const leave = p.page.getByRole('button', { name: /^(Leave|Dismiss)$/ });
        const present = await leave.waitFor({ timeout: p === vera ? 20000 : 4000 }).then(() => true, () => false);
        if (!present && p === vera) throw new StepFailure(`${p.who.userId}: no Leave button on the page`);
        if (present) await leave.click(); else ended.push(p.who.userId);
        await p.page.getByRole('button', { name: 'Leave', exact: true }).waitFor({ state: 'detached', timeout: 20000 }).catch(() => { throw new StepFailure(`${p.who.userId}: the page still shows Leave after leaving`); });
        await sleep(2500); // long enough for a state poll to run with the call gone
        check(await p.page.getByTestId('shell-footer-row').isVisible(), `${p.who.userId}: the footer row is gone after leaving`);
        check(await p.page.getByTestId('nova-bar').count() === 0, `${p.who.userId}: Nova's controls are still drawn after leaving`);
        await shot(p.page, `18-after-leave-${p.who.userId}`);
      }
      check(allErrors.length === 0, `page errors in the walk: ${allErrors.join(' | ')}`);
      return `both are out of the call${ended.length ? ` (the call had already ended for ${ended.join(', ')})` : ''}; footer row present; zero page errors`;
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
