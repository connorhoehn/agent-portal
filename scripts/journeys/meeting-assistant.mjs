#!/usr/bin/env node
// The call assistant's call UI (docs/meeting-assistant-design.md, package 3), walked in a browser on the default mock
// world with no media, no microphone and no paid session:
//   1 Invite Nova is offered to a person in a call    2 inviting: "Nova is listening" for both, Nova in the roster
//   3 the notice shows to the second person only      4 nothing stored before the acknowledgement, lines after it
//   5 pause and resume from the second person         7 nothing clipped or scrolling in the call bar at 1280 (run before 6)
//   6 dismiss: the mark goes, the chip says why, "Invite Nova again" beside it (Nova can be invited back)
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
//   R1 to R4 (Nova invited back, run after 13b): a third person joins again; "Invite Nova again" beside the left chip on one footer line
//     with three people; the inviter uses it, the chat says Nova is back, the others owe the acknowledgement again and their words are
//     not kept until they give it; something is said; Nova is dismissed; the minutes hold both periods, the earlier items in place.
//   R3b, R5: the second person's live transcript stays open across that dismissal; Nova is invited back a third time, the view listens
//     again, and when Nova leaves again the line said just before is read into it (one more read after every leave, not only the first).
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
      // The session records (as the platform API's default does), so the call block shows its recording indicator.
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who.userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'meeting-assistant-signalling-only', recording: { enabled: true, reason: 'default' } } });
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
  // A Nova card's look: its layout (you / others / done / muted), whether it is one row, its height, and whether its surface is opaque.
  const cardLook = (loc) => loc.evaluate((el) => {
    const bg = getComputedStyle(el).backgroundColor;
    const alpha = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(',').map((x) => x.trim())[3];
    const oklab = /\/\s*([\d.]+%?)\s*\)$/.exec(bg)?.[1];
    const a = alpha !== undefined ? Number(alpha) : oklab !== undefined ? (oklab.endsWith('%') ? Number(oklab.slice(0, -1)) / 100 : Number(oklab)) : 1;
    return { layout: el.getAttribute('data-layout'), collapsed: el.getAttribute('data-collapsed') === 'true', height: Math.round(el.getBoundingClientRect().height), opaque: a >= 0.99, bg };
  });
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
      // In-call 9: a late joiner reads the standing facts in the menu instead of the chat history they missed.
      await nora.page.getByTestId('nova-mark').click();
      const facts = (await nora.page.getByTestId('nova-facts').innerText().catch(() => '')).replace(/\s+/g, ' ');
      await nora.page.keyboard.press('Escape');
      check(/Invited by .+/.test(facts) && /voice is off/.test(facts) && /Anyone here can pause or dismiss Nova/.test(facts), `the menu does not state who invited, the voice and who may pause or dismiss: "${facts}"`);
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
      const secondary = (await nora.page.getByTestId('nova-notice-secondary').innerText()).trim();
      check(secondary === 'Dismiss Nova for everyone', `the notice's dismissal does not say it is for everyone: "${secondary}"`);
      check(/Nova writes minutes for the people in the call/.test(text) && /^.*Nova is listening to this call\./.test(text), `the notice is not the agreed banner copy: "${text}"`);
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

    // ── L0. The live transcript for someone who has not acknowledged: other people's lines, and why their own are missing ──
    await step('L0: someone who has not acknowledged opens "Show transcript" from Nova\'s menu: the pane opens on the live transcript, which says their own words are not transcribed until they acknowledge; Back to chat returns to the thread', async () => {
      await nora.page.getByTestId('nova-mark').click();
      const item = nora.page.getByRole('menuitem', { name: /Show transcript/ });
      check(await item.isVisible(), 'no Show transcript in Nova\'s menu');
      check(/What Nova is hearing, as it hears it/.test(await item.innerText()), `Show transcript does not say what it shows: "${await item.innerText()}"`);
      await item.click();
      await seen(nora.page, 'live-transcript');
      const note = (await nora.page.getByTestId('live-transcript-not-acked').innerText()).trim();
      check(note === 'Your own words are not transcribed until you acknowledge Nova\'s notice.', `the not-acknowledged sentence reads "${note}"`);
      const state = (await nora.page.getByTestId('live-transcript-state').innerText()).trim();
      check(state === 'Nova is listening', `the transcript's state reads "${state}"`);
      await nora.page.getByTestId('live-transcript-back').click();
      await gone(nora.page, 'live-transcript');
      await seen(nora.page, 'huddle-thread');
      return `"${note}"`;
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
      // The long join notice is a quiet notice block, not a paragraph squeezed into a pill: its first sentence, the rest behind "More".
      const joinBlock = vera.page.getByTestId('assistant-notice-block').filter({ hasText: /joined at .+ invitation\./ }).first();
      await joinBlock.waitFor({ state: 'visible', timeout: 15000 }).catch(() => { throw new StepFailure('the join notice is not a notice block'); });
      const joinLook = await joinBlock.evaluate((el) => ({ inPill: !!el.closest('[data-testid="chat-assistant-notice"]'), open: !!el.querySelector('details[open]') }));
      check(!joinLook.inPill, 'the join notice is still inside a pill');
      check(!joinLook.open && !(await joinBlock.getByTestId('assistant-notice-rest').isVisible()), 'the join notice shows its whole paragraph before "More"');
      check(/^Nova joined at .+ invitation\.$/.test((await joinBlock.getByTestId('assistant-notice-line').innerText()).trim()), 'the join notice does not lead with its first sentence');
      await joinBlock.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(vera.page, 'C7-join-notice', width);
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

    // ── L1. The live transcript: lines appear as they are said, follow the newest, stop following when scrolled up ──
    await step('L1: the inviter opens the live transcript from Nova\'s menu: the thread gives way to "Live transcript · Nova is listening", a line just said appears without a reload under its speaker, scrolling up stops following and offers "Jump to latest", and Back to chat returns to the same thread and composer (screenshots at 1440 and 1280)', async () => {
      const noraName = (await (await nora.api.get(`${PORTAL}/api/session/me`)).json()).name;
      const panel = vera.page.getByTestId('live-transcript-panel');
      const geo = () => vera.page.evaluate(() => {
        const el = document.querySelector('[data-testid="live-transcript-panel"] [data-seg-index]')?.parentElement;
        return el ? { top: Math.round(el.scrollTop), max: Math.round(el.scrollHeight - el.clientHeight) } : null;
      });
      const linesShown = async () => Number(await vera.page.getByTestId('live-transcript').getAttribute('data-lines'));
      // The pane's composer, marked so Back to chat can show it is the same one (kept mounted, not rebuilt).
      const composer = vera.page.getByRole('textbox', { name: 'Huddle message' });
      const hadComposer = (await composer.count()) > 0;
      if (hadComposer) await composer.first().evaluate((el) => el.setAttribute('data-live-transcript-marker', 'kept'));
      await novaMenu(vera, /Show transcript/);
      await seen(vera.page, 'live-transcript');
      check(!(await chatPanel(vera).isVisible()), 'the chat thread still shows under the transcript');
      const head = (await panel.locator('header').first().innerText()).replace(/\s+/g, ' ').trim();
      check(/^Live transcript/.test(head) && /Nova is listening/.test(head) && /Back to chat/.test(head), `the transcript's header reads "${head}"`);
      await waitFor(async () => (await linesShown()) > 0, 10000, 'the stored lines in the transcript');
      const said = `Live check: the staging cutover moves to the ${Date.now() % 100000}th build.`;
      await inject(NORA.userId, said);
      const row = panel.locator('[data-seg-index]').filter({ hasText: said });
      await row.waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new StepFailure('the line just said did not appear without a reload'); });
      const rowText = (await row.innerText()).replace(/\s+/g, ' ');
      check(rowText.includes(noraName), `the line is not under its speaker ${noraName}: "${rowText}"`);
      // Enough lines to scroll: the view follows the newest while the reader is at the bottom.
      const batch = Array.from({ length: 18 }, (_, i) => ({ userId: i % 2 ? VERA.userId : NORA.userId, text: `Status round ${i + 1}: the build on the staging lane is green.` }));
      const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) });
      check(res.status < 300, `the injector answered ${res.status}`);
      await panel.locator('[data-seg-index]').filter({ hasText: 'Status round 18:' }).waitFor({ state: 'visible', timeout: 10000 }).catch(() => { throw new StepFailure('the batch of lines did not appear'); });
      await sleep(300);
      const atEnd = await geo();
      check(atEnd && atEnd.max > 0 && atEnd.max - atEnd.top <= 24, `the view did not follow the newest line: ${JSON.stringify(atEnd)}`);
      check(await vera.page.getByTestId('transcript-jump-latest').count() === 0, 'Jump to latest shows while following');
      // Scrolled up: it stops following and offers one way back.
      await vera.page.evaluate(() => { const el = document.querySelector('[data-testid="live-transcript-panel"] [data-seg-index]')?.parentElement; if (el) el.scrollTop = 0; });
      await seen(vera.page, 'transcript-jump-latest', 5000);
      check(await vera.page.getByTestId('transcript-jump-latest').count() === 1, 'more than one Jump to latest');
      const before = await linesShown();
      await inject(VERA.userId, 'Status round 19: still green while the reader looks back.');
      await waitFor(async () => (await linesShown()) > before, 10000, 'the next line while scrolled up');
      const held = await geo();
      check(held && held.top <= 24, `the view jumped down while the reader was scrolled up: ${JSON.stringify(held)}`);
      for (const width of [1440, 1280]) { await shot(vera.page, 'L1-live-transcript-scrolled', width); await barFits(vera.page, 'the bar with the transcript open', width); }
      await vera.page.getByTestId('transcript-jump-latest').click();
      await gone(vera.page, 'transcript-jump-latest', 5000);
      const back = await geo();
      check(back && back.max - back.top <= 24, `Jump to latest did not reach the newest line: ${JSON.stringify(back)}`);
      for (const width of [1440, 1280]) await shot(vera.page, 'L1-live-transcript', width);
      await vera.page.getByTestId('nova-mark').click();
      check(await vera.page.getByRole('menuitem', { name: 'Hide transcript' }).isVisible(), 'the menu does not offer Hide transcript while the view is on');
      await vera.page.keyboard.press('Escape');
      await vera.page.getByTestId('live-transcript-back').click();
      await gone(vera.page, 'live-transcript');
      await seen(vera.page, 'huddle-thread');
      if (hadComposer) check(await composer.first().getAttribute('data-live-transcript-marker') === 'kept', 'Back to chat brought back a different composer');
      return `"${head}"; "${rowText.slice(0, 90)}"; followed ${JSON.stringify(atEnd)}, held ${JSON.stringify(held)}; composer ${hadComposer ? 'kept' : 'owned by the page'}`;
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
      // One anatomy: a header, the record's name as the headline, ONE plain-words line saying where it lands, no raw `key: value` rows.
      check((await veraCard.getByTestId('assistant-action-eyebrow').innerText()).trim() === 'Action · asked by Vera Green', `the card's header reads "${await veraCard.getByTestId('assistant-action-eyebrow').innerText()}"`);
      check(/login cookie bug/.test(await veraCard.getByTestId('assistant-action-summary').innerText()), `the card's headline: "${cardText}"`);
      await waitFor(async () => /^Creates a work item in .+/.test((await veraCard.getByTestId('assistant-action-does').innerText().catch(() => '')).trim()), 15000, 'the card saying where the work item lands');
      check(!/\bkind:|\btitle:|Initiative:/.test(await veraCard.innerText()), `the card shows raw fields: "${(await veraCard.innerText()).replace(/\s+/g, ' ')}"`);
      check(!(await veraCard.getByTestId('assistant-action-detail').isVisible().catch(() => false)), 'the exact fields are not behind the closed "Details"');
      check(/Waiting for Vera/.test(await noraCard.innerText()), `the other person's card does not say who it waits for: "${await noraCard.innerText()}"`);
      // State decides the look: the asker's card stands out in Nova's accent; the other person's sits on the plain surface; both opaque.
      const [lookV, lookN] = [await cardLook(veraCard), await cardLook(noraCard)];
      check(lookV.layout === 'you' && lookN.layout === 'others', `the waiting card's layouts: asker ${lookV.layout}, other ${lookN.layout}`);
      check(lookV.opaque && lookN.opaque, `a card lets the dot field through: ${lookV.bg} / ${lookN.bg}`);
      // The card already says who it waits for: Nova's "I have asked Vera Green to confirm." is not posted to the chat as well.
      await sleep(2500);
      const asked = (await chatMessages(vera)).filter((m) => /I have asked .+ to confirm/.test(String(m.message)));
      check(asked.length === 0, `the chat repeats the card: ${JSON.stringify(asked.map((m) => m.message))}`);
      check(await vera.page.getByTestId('huddle-thread').getByText(/I have asked .+ to confirm/).count() === 0, 'the chat shows "I have asked … to confirm." under the card');
      for (const width of [1440, 1280]) { await veraCard.scrollIntoViewIfNeeded(); await shot(vera.page, 'C1-card-waiting-asker', width); await noraCard.scrollIntoViewIfNeeded(); await shot(nora.page, 'C2-card-waiting-other', width); }
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
      // Finished, the card folds to ONE row: the mark, what was done in plain words; Show opens the whole card with the result sentence.
      await waitFor(async () => /Done/.test(await noraCard.getByTestId('assistant-action-status').innerText()) && (await cardLook(noraCard)).collapsed, 15000, 'the other person\'s card folding to a done row');
      const resultLine = (await noraCard.getByTestId('assistant-action-row-text').innerText()).trim();
      check(resultLine === 'Created “the login cookie bug”', `the done row reads "${resultLine}"`);
      const doneLook = await cardLook(noraCard);
      check(doneLook.height <= 48, `the done card is not one row: ${doneLook.height}px tall`);
      await noraCard.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(nora.page, 'C3-card-done-row', width);
      await noraCard.getByTestId('assistant-action-expand').click();
      await waitFor(async () => !(await cardLook(noraCard)).collapsed, 5000, 'Show opening the whole card');
      await noraCard.getByTestId('assistant-action-more').locator('summary').click();
      check((await noraCard.getByTestId('assistant-action-result').innerText()).trim().length > 0, 'the opened card has no result sentence');
      await noraCard.getByTestId('assistant-action-collapse').click();
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
      // Declined, the card is one muted row with the reason.
      const declinedLook = await cardLook(noraCard);
      check(declinedLook.collapsed && declinedLook.layout === 'muted' && declinedLook.height <= 48, `the declined card is not one muted row: ${JSON.stringify(declinedLook)}`);
      check(/declined it, so nothing was done\./.test(await noraCard.getByTestId('assistant-action-row-text').innerText()), 'the declined row gives no reason');
      await noraCard.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(nora.page, 'C4-card-declined-row', width);
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
      // In-call 10: the toast stays until closed (an info toast used to go after 5 s) and offers the bell where the answer is kept.
      await sleep(6500);
      check(await toast.isVisible(), 'the private toast went away on its own');
      const toastCard = vera.page.locator('[role="status"]').filter({ hasText: /only you can see this/i }).first();
      await toastCard.getByTestId('toast-action').click();
      await seen(vera.page, 'activity-bell-popover', 5000);
      // (The bell's own row may carry the same words, so the toast card itself is what must be gone.)
      check(await vera.page.locator('[role="status"]').filter({ has: vera.page.getByTestId('toast-action') }).filter({ hasText: /only you can see this/i }).count() === 0, '"Open notifications" did not close the toast');
      await vera.page.keyboard.press('Escape');
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
    const askFor = async (p, statement) => {
      await deckOf(p).filter({ hasText: statement }).waitFor({ timeout: 20000 }).catch(async () => {
        // Say what this person's proposals route holds, so a missing prompt can be told from a stale or refused read.
        const res = await p.api.get(asApi(p, 'proposals')).catch(() => null);
        const list = res && res.ok() ? (await res.json()).proposals.map((x) => `${x.id}:${x.state}:${x.you?.response ?? '-'}:${(x.missing?.people ?? []).join('+')}+${x.missing?.more}`).join(', ') : `HTTP ${res?.status()}`;
        const deck = await deckOf(p).innerText({ timeout: 2000 }).catch(() => '(no deck)');
        const page = await p.page.evaluate(() => ({ decks: document.querySelectorAll('[data-composer-prompt-deck]').length, store: JSON.stringify(Object.fromEntries(Object.entries(sessionStorage).filter(([k]) => k.startsWith('nova-proposal')))), count: document.querySelector('[data-testid="nova-proposal-count"]')?.getAttribute('aria-label') ?? null })).catch((e) => ({ err: String(e) }));
        const cardText = await p.page.locator('[data-testid="assistant-proposal-card"]').filter({ hasText: statement }).last().innerText({ timeout: 2000 }).catch(() => '(no card)');
        page.card = cardText.replace(/\s+/g, ' ').slice(0, 300);
        throw new StepFailure(`${p.who.userId}: no deck prompt for "${statement}"; route: ${list}; deck: ${deck.replace(/\s+/g, ' ').slice(0, 160)}; page: ${JSON.stringify(page)}`);
      });
    };
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

    await step('G1: with three people the call block is a gallery of three tiles side by side (You first, names, no "+2"), no recording banner on a line of its own, and the recording dot on its meta line named with the whole warning (screenshots at 1440 and 1280)', async () => {
      const blockSel = '[data-testid="shell-call-media"][data-expanded="true"] section[data-call-dock]';
      if (!(await vera.page.locator(blockSel).first().isVisible().catch(() => false))) await vera.page.getByTestId('shell-call-dock-chat').click();
      await vera.page.locator(blockSel).first().waitFor({ timeout: 20000 });
      const tilesNow = async () => vera.page.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => `${b.getAttribute('data-layout')}:${b.querySelectorAll('[data-peer-id]').length} tiles [${[...b.querySelectorAll('[data-peer-id]')].map((t) => `${t.getAttribute('data-peer-id')}=${t.getAttribute('aria-label') ?? t.tagName}`).join(', ')}] "${b.querySelector('[data-testid="call-dock-meta"]')?.textContent ?? ''}" ${b.querySelector('[data-variant]')?.getAttribute('data-variant') ?? ''}`).join(' | '), blockSel);
      // Seats are the people in the call; an invitee who never answered the huddle's ring keeps a "ringing" placeholder tile after them (2.436.0).
      await waitFor(async () => (await vera.page.locator(`${blockSel} [data-peer-id]:not([data-ringing="true"])`).count()) === 3, 20000, 'three tiles in the call block')
        .catch(async (e) => { throw new StepFailure(`${e.message}: ${await tilesNow()}`); });
      const seenAt = [];
      for (const width of [1440, 1280]) {
        await vera.page.setViewportSize({ width, height: 900 }); await sleep(700);
        const r = await vera.page.evaluate((sel) => {
          const block = document.querySelector(sel);
          const tiles = [...block.querySelectorAll('[data-peer-id]')];
          const seats = tiles.filter((t) => t.getAttribute('data-ringing') !== 'true');
          const rects = tiles.map((t) => t.getBoundingClientRect());
          const media = block.closest('[data-testid="shell-call-media"]');
          const dot = block.querySelector('[data-testid="call-recording-indicator-dot"]');
          return {
            layout: block.getAttribute('data-layout'),
            count: seats.length,
            ringing: tiles.filter((t) => t.getAttribute('data-ringing') === 'true').map((t) => t.getAttribute('aria-label')),
            first: seats[0]?.getAttribute('aria-label') ?? '',
            names: seats.map((t) => t.querySelector('[data-tile-label] span')?.textContent ?? ''),
            sizes: [...new Set(rects.map((b) => `${Math.round(b.width)}x${Math.round(b.height)}`))],
            tops: [...new Set(rects.map((b) => Math.round(b.top)))],
            overlap: rects.some((b, i) => i > 0 && b.left < rects[i - 1].right - 1 && Math.round(b.top) === Math.round(rects[i - 1].top)),
            plus: block.querySelectorAll('[data-testid$="-wrapped"], [data-testid$="-overflow"]').length,
            banner: [...document.querySelectorAll('[data-testid="recording-consent"], [data-placement="line"]')].length
              + [...(media?.querySelectorAll('[role="alert"], [data-testid$="-notice"]') ?? [])].filter((el) => /record/i.test(el.textContent ?? '')).length,
            dotName: dot?.getAttribute('aria-label') ?? null,
            dotFocusable: dot?.getAttribute('tabindex') === '0',
            dotInMeta: !!dot?.closest('[data-testid="call-dock-meta-line"]'),
            meta: block.querySelector('[data-testid="call-dock-meta"]')?.textContent ?? '',
            height: Math.round(block.getBoundingClientRect().height),
          };
        }, blockSel);
        check(r.layout === 'compact', `the block's layout is ${r.layout} at ${width}`);
        check(r.count === 3, `${r.count} seated tiles for three people at ${width}`);
        check(r.first === 'You' || r.first.startsWith('You,'), `the first tile is "${r.first}" at ${width}`);
        check(r.names.every((n) => n.trim().length > 0) && r.names[0] === 'You', `tile names ${JSON.stringify(r.names)} at ${width}`);
        check(r.sizes.length === 1, `the tiles differ in size at ${width}: ${r.sizes.join(', ')}`);
        check(r.tops.length === 1 && !r.overlap, `the three tiles are not side by side on one line at ${width} (tops ${r.tops.join(', ')})`);
        check(r.plus === 0, `a +N shows for three people at ${width}`);
        check(r.banner === 0, `a recording banner takes a line of its own at ${width}`);
        check(r.dotName === 'Recording. By attending you agree to be included.', `the recording dot is named "${r.dotName}" at ${width}`);
        check(r.dotFocusable && r.dotInMeta, `the recording dot is ${r.dotFocusable ? '' : 'not focusable'}${r.dotInMeta ? '' : ' not on the meta line'} at ${width}`);
        // The stand-in SFU never connects media, so the meta line may still read "Connecting…"; the tiles are the seats.
        check(/^3 people · |^Connecting/.test(r.meta), `the meta line reads "${r.meta}" at ${width}`);
        check(r.height <= 120, `the call block is ${r.height}px tall at ${width}`);
        seenAt.push(`${width}: ${r.count} tiles ${r.sizes[0]} (${r.names.join(', ')}${r.ringing.length ? `; then ${r.ringing.join(', ')}` : ''}), block ${r.height}px, "${r.meta}" + dot`);
        await shot(vera.page, 'G1-call-block-three', width);
        await vera.page.locator(blockSel).first().screenshot({ path: path.join(SHOTS, `G1-call-block-only-${width}.png`) });
      }
      await vera.page.setViewportSize({ width: 1440, height: 900 });
      return seenAt.join('; ');
    });

    await step('P2a: the lines Nova heard are shown to people who were in the call; a named person who was never in it sees the statement and who raised it, never the lines', async () => {
      const lines = (await (await vera.api.get(asApi(vera, 'transcript?limit=500'))).json()).lines ?? [];
      check(lines.length >= 2, `only ${lines.length} transcript lines to rest on`);
      const evidence = lines.slice(-2).map((l) => l.seq);
      const id = await propose({ id: 'walk-proposal-heard', statement: PROPOSAL_H, outcome: { kind: 'decision' }, executor: VERA.userId, named: ['u-theo'], evidence });
      const mine = (await proposalsOf(vera)).find((p) => p.id === id);
      check(mine?.heard?.length === 2 && mine.heard.every((h) => typeof h.text === 'string' && h.text.length > 0), `the attendee's heard lines: ${JSON.stringify(mine?.heard)}`);
      // The heard lines sit behind "What Nova heard", closed by default.
      await card(vera, id).getByTestId('assistant-proposal-more').waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure('the card has no "What Nova heard" for an attendee'); });
      check(!(await card(vera, id).getByTestId('assistant-proposal-heard').isVisible()), 'the heard lines show before "What Nova heard" is opened');
      check((await card(vera, id).getByTestId('assistant-proposal-more').locator('summary').innerText()).includes('What Nova heard'), 'the disclosure is not "What Nova heard"');
      await card(vera, id).getByTestId('assistant-proposal-more').locator('summary').click();
      await card(vera, id).getByTestId('assistant-proposal-heard').waitFor({ timeout: 5000 }).catch(() => { throw new StepFailure('the card shows no heard lines to an attendee'); });
      const away = await browser.newContext(); contexts.push(away);
      check((await away.request.post(`${PORTAL}/api/session/login`, { data: { userId: 'u-theo' } })).status() === 200, 'the absent person could not sign in');
      check((await away.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: 'member' } })).status() === 200, 'the absent person has no orgiq role');
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
      // People are faces: one avatar per person, each named with their answer; the card waits on Vera, so it is the full card in Nova's accent.
      const people = card(vera, p1).getByTestId('assistant-proposal-person');
      check(await people.count() >= 1 && await card(vera, p1).getByTestId('assistant-proposal-people').locator('[data-testid="assistant-proposal-person"] > *').count() >= 1, 'the proposal card has no avatars');
      check((await people.allInnerTexts()).some((t) => /Vera Green · waiting · runs it/.test(t)), `the avatars' names: ${JSON.stringify(await people.allInnerTexts())}`);
      const lookP = await cardLook(card(vera, p1));
      check(lookP.layout === 'you' && lookP.opaque, `the card waiting on Vera: ${JSON.stringify(lookP)}`);
      // The card asks nothing itself: its only control is Answer, which opens the deck.
      const buttons = (await card(vera, p1).getByRole('button').allInnerTexts()).map((t) => t.trim());
      check(buttons.length === 1 && buttons[0] === 'Answer', `the card's controls: ${JSON.stringify(buttons)}`);
      // Before anyone consents the card says how the decision will be recorded, behind its closed disclosure.
      const more = card(vera, p1).getByTestId('assistant-proposal-more');
      check(!(await card(vera, p1).getByTestId('assistant-proposal-records').isVisible().catch(() => false)), 'how it will be recorded shows before the disclosure is opened');
      await more.locator('summary').click();
      await waitFor(async () => /It will be recorded as (decided|waiting for the initiative owner's decision)\./.test(await card(vera, p1).innerText()), 15000, 'the card saying how it will be recorded');
      for (const width of [1440, 1280]) { await card(vera, p1).scrollIntoViewIfNeeded(); await shot(vera.page, 'C5-proposal-needs-you-open', width); }
      await more.locator('summary').click();
      // The second person's card fills on their own poll: their needs line names the executor, not "you".
      await waitFor(async () => { const t = await card(nora, p1).innerText(); return t.includes('Needs Vera') && t.includes('(runs it) and one more person.'); }, 15000, 'the second person\'s needs line naming the executor');
      for (const width of [1440, 1280]) { await vera.page.setViewportSize({ width, height: 900 }); await sleep(400); await card(vera, p1).scrollIntoViewIfNeeded(); await shot(vera.page, 'P2-proposal-card', width); await shot(vera.page, 'C5-proposal-needs-you', width); }
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
      // Recorded, the card is one row; Show opens it to the faces with their answers.
      await waitFor(async () => (await cardLook(card(eli, p1))).collapsed, 15000, 'the recorded card folding to one row');
      const recLook = await cardLook(card(eli, p1));
      check(recLook.layout === 'done' && recLook.height <= 48, `the recorded card is not one row: ${JSON.stringify(recLook)}`);
      await card(eli, p1).getByTestId('assistant-proposal-expand').click();
      await waitFor(async () => (await chipsOf()).filter((t) => t.includes('· consented')).length === 2, 15000, 'two consented chips');
      const chipsSeen = (await chipsOf()).join(', ');
      await card(eli, p1).getByTestId('assistant-proposal-collapse').click();
      for (const p of [vera, nora, eli]) {
        await waitFor(async () => recorded(PROPOSAL_1).test(await card(p, p1).innerText()), 15000, `${p.who.userId}: the card's closing line`);
        await card(p, p1).getByTestId('assistant-proposal-result-link').waitFor({ timeout: 15000 }).catch(() => { throw new StepFailure(`${p.who.userId}: no link to the decision`); });
        await gone(p.page, 'nova-proposal-ask');
        await gone(p.page, 'nova-proposal-count');
      }
      await card(vera, p1).scrollIntoViewIfNeeded(); await shot(vera.page, 'P5-proposal-recorded', 1440);
      return `run by ${done.run.by.name}; ${done.run.href}; chips ${chipsSeen}`;
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
        // In-call 8: the voice is seen on the bar without opening the menu.
        await waitFor(async () => (await p.page.getByTestId('nova-voice-chip').innerText().catch(() => '')).trim() === 'Voice on', 10000, `${p.who.userId} seeing "Voice on" on the bar`);
        // "Click to hear Nova" is decided before any reply: shown exactly when this browser holds sound until a click. Headless
        // Chromium after the walk's clicks lets sound start, so it is absent here; a browser that blocks would show it now.
        const blocks = await p.page.evaluate(async () => { const c = new AudioContext(); const s = c.state; await c.close(); return s === 'suspended'; });
        await waitFor(async () => (await p.page.getByTestId('nova-enable-sound').count()) === (blocks ? 1 : 0), 5000, `${p.who.userId}: "Click to hear Nova" ${blocks ? 'missing' : 'shown'} before any reply, with sound ${blocks ? 'blocked' : 'allowed'}`);
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
      // In-call 8: the mute shows on the bar, and is kept for this call only (not for every later call).
      await waitFor(async () => (await nora.page.getByTestId('nova-voice-chip').innerText().catch(() => '')).trim() === 'Muted for you', 5000, '"Muted for you" on the bar');
      check((await vera.page.getByTestId('nova-voice-chip').innerText()).trim() === 'Voice on', 'the mute showed for the other person');
      const keys = await nora.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('orgiq.novaMuted')));
      check(keys.length === 1 && keys[0] === `orgiq.novaMuted:${callId}`, `the mute is not kept per call: ${JSON.stringify(keys)}`);
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
      // In-call 4: the card says when it expires, and the asker's footer count includes it and jumps to it.
      for (const p of [vera, nora]) {
        const card = p.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last();
        const t = await waitFor(async () => (await card.getByTestId('assistant-action-expires').innerText().catch(() => '')).trim() || null, 15000, `${p.who.userId} seeing the card's expiry`);
        check(/^expires in (9|10) min$/.test(t), `${p.who.userId}: the card's expiry reads "${t}"`);
      }
      const badge = vera.page.getByTestId('nova-proposal-count');
      await waitFor(async () => (await badge.getAttribute('data-cards').catch(() => null)) === '1', 15000, 'the asker\'s footer count including the card');
      check(/1 card waiting for your confirmation/.test((await badge.getAttribute('aria-label')) ?? ''), `the count does not say a card waits: "${await badge.getAttribute('aria-label')}"`);
      check((await nora.page.getByTestId('nova-proposal-count').getAttribute('data-cards').catch(() => '0')) !== '1', 'the other person\'s count includes a card that waits on the asker');
      await badge.click();
      const veraCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last();
      await waitFor(async () => veraCard.getByTestId('assistant-action-confirm').evaluate((el) => el === document.activeElement).catch(() => false), 5000, 'the count jumping to the card\'s Confirm');
      await shot(vera.page, '6a-card-waiting-count');
      return 'waiting for both; expiry shown; the count jumps to the card';
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

    await step('6: dismiss: asked once and kept on Cancel; then the mark goes, the bar says who dismissed Nova and offers "Invite Nova again" beside it (Nova can be invited back)', async () => {
      // In-call 3: the dismissal is asked once, naming its effect; keeping Nova changes nothing.
      await novaMenu(nora, 'Dismiss Nova for everyone');
      await seen(nora.page, 'nova-dismiss-ask');
      const question = (await nora.page.getByTestId('nova-dismiss-ask').innerText()).replace(/\s+/g, ' ');
      check(/Nova leaves the call for everyone\. Anyone who can invite Nova can invite it back later\./.test(question), `the dismissal question does not name its effect: "${question}"`);
      check((await stateOf(nora)).state === 'listening', 'choosing Dismiss in the menu dismissed Nova before the question was answered');
      await shot(nora.page, '6-dismiss-ask');
      await nora.page.getByTestId('nova-dismiss-ask').getByRole('button', { name: /Keep Nova/ }).click();
      await gone(nora.page, 'nova-dismiss-ask');
      check((await stateOf(nora)).state === 'listening', 'keeping Nova dismissed it');
      await novaMenu(nora, 'Dismiss Nova for everyone');
      await nora.page.getByTestId('nova-dismiss-ask').getByRole('button', { name: /Dismiss Nova for everyone/ }).click();
      await seen(nora.page, 'nova-left');
      await seen(vera.page, 'nova-left');
      for (const p of [vera, nora]) {
        // Around 1: the chip says who dismissed Nova (and no longer that it cannot come back); beside it, the way back.
        const why = (await p.page.getByTestId('nova-left').innerText()).trim();
        check(/^.+ dismissed Nova\.$/.test(why) && !why.startsWith('Someone'), `the left chip does not say who dismissed Nova: "${why}"`);
        check(await p.page.getByTestId('nova-mark').count() === 0, 'the listening mark stayed');
        check(await p.page.getByTestId('nova-invite').count() === 0, 'the first "Invite Nova" came back');
        check(await p.page.getByTestId('nova-menu').count() === 0, 'Nova controls stayed');
        await seen(p.page, 'nova-invite-again');
        check((await p.page.getByTestId('nova-invite-again').innerText()).trim() === 'Invite Nova again', 'the button does not read "Invite Nova again"');
      }
      // The server says Nova may be invited back (it is not used here: the minutes steps below read the first period's minutes; R1 to R4 do it).
      const standing = (await stateOf(vera)).rejoin;
      check(standing === 'allowed', `the state says rejoin ${standing}, not allowed`);
      check(await vera.page.getByTestId('nova-roster-entry').count() === 0, 'Nova stayed in the roster');
      await barFits(vera.page, 'the bar after dismissal', 1280);
      await shot(vera.page, '6-left');
      // An unfinished proposal moves to the meeting page: the footer asks no more, and it waits 72 hours.
      await gone(vera.page, 'nova-proposal-ask');
      const open = (await proposalsOf(vera)).find((p) => p.id === p3);
      check(open?.state === 'open' && typeof open.expiresAt === 'number' && open.expiresAt - Date.now() > 71 * 3600_000, `the open proposal after the dismissal: ${JSON.stringify({ state: open?.state, expiresAt: open?.expiresAt })}`);
      return 'left; "Invite Nova again" offered; the open proposal expires in 72 h';
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
      const expiredCard = vera.page.getByTestId('assistant-action-card').filter({ hasText: 'expiry audit' }).last();
      const expLook = await cardLook(expiredCard);
      check(expLook.collapsed && expLook.layout === 'muted', `the expired card is not one muted row: ${JSON.stringify(expLook)}`);
      check(/Nova was dismissed before this was done\./.test(await expiredCard.getByTestId('assistant-action-row-text').innerText()), 'the expired row gives no reason');
      await expiredCard.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(vera.page, 'C4-card-expired-row', width);
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
      const out = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        // On a failure, name the outermost elements that reach past the right edge, so the cause is in the message.
        const past = [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > w + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > w + 1));
        return { over: document.documentElement.scrollWidth - w, past: past.slice(0, 4).map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${String(el.className).slice(0, 60)}`) };
      });
      check(out.over <= 1, `${label} scrolls sideways at ${width} by ${out.over}px: ${out.past.join(' | ')}`);
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
      // The text is the summary's lead sentence (never a "<name> said: …" echo of the lines, never the bullets).
      check(msg.message.trim().length > 10 && !/ said: /.test(msg.message) && !msg.message.includes('\n- '), `the minutes text is not the summary's lead: "${msg.message}"`);
      const all = (await chatMessages(vera)).filter((m) => m.metadata?.minutes);
      check(all.length === 1, `${all.length} minutes messages were posted`);
      const card = vera.page.getByTestId('assistant-minutes-card').last();
      await card.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no minutes card'); });
      check((await card.getByTestId('assistant-minutes-title').innerText()).trim() === 'Minutes', 'the minutes card has no "Minutes" header');
      check((await card.getByTestId('assistant-minutes-status').innerText()).trim() === 'Ready', 'the minutes card has no "Ready" pill');
      check((await card.getByTestId('assistant-minutes-summary').innerText()).trim().length > 0, 'the minutes card shows no summary');
      const shown = (await card.getByTestId('assistant-minutes-counts').innerText()).replace(/\s+/g, ' ');
      check(/^\d+ decisions? · \d+ action items? · \d+ proposals?$/.test(shown.trim()), `the counts are not one readable line: "${shown}"`);
      check(shown.includes(`${counts.decisions} decision`) && shown.includes(`${counts.actionItems} action item`) && shown.includes(`${counts.proposals} proposal`), `the card shows "${shown}" for ${JSON.stringify(counts)}`);
      check(await card.evaluate((el) => el.closest('[data-testid="chat-message"]')?.getAttribute('data-voice') === 'assistant'), 'the minutes card is not in a row in Nova\'s voice');
      // Every Nova card is opaque (the dialogue's dot field never shows through); finished and closed ones are single rows; Nova's
      // accent is kept for the one that waits on the viewer.
      const looks = await vera.page.locator('[data-testid="assistant-minutes-card"], [data-testid="assistant-action-card"], [data-testid="assistant-proposal-card"]')
        .evaluateAll((els) => els.map((el) => ({ layout: el.getAttribute('data-layout'), collapsed: el.getAttribute('data-collapsed'), tone: el.getAttribute('data-tone'), bg: getComputedStyle(el).backgroundColor })));
      const alphaOf = (bg) => { const rgba = /rgba?\(([^)]+)\)/.exec(bg)?.[1].split(',').map((x) => x.trim())[3]; const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(bg)?.[1];
        return rgba !== undefined ? Number(rgba) : slash !== undefined ? (slash.endsWith('%') ? Number(slash.slice(0, -1)) / 100 : Number(slash)) : 1; };
      const seeThrough = looks.filter((l) => alphaOf(l.bg) < 0.99);
      check(looks.length >= 3 && seeThrough.length === 0, `Nova's cards let the dot field through: ${JSON.stringify(seeThrough)}`);
      check(looks.every((l) => (l.tone === 'assistant') === (l.layout === 'you')), `Nova's accent is not kept for the cards waiting on the viewer: ${JSON.stringify(looks)}`);
      check(looks.filter((l) => l.layout === 'done' || l.layout === 'muted').every((l) => l.collapsed === 'true'), `a finished or closed card is not a row: ${JSON.stringify(looks)}`);
      await card.scrollIntoViewIfNeeded();
      for (const width of [1440, 1280]) await shot(vera.page, '12-chat-minutes', width);
      const expected = `/iq/meetings/${encodeURIComponent(callId)}`;
      const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
      await link.waitFor({ state: 'visible', timeout: 20000 }).catch(() => { throw new StepFailure('the chat shows no meeting link under the closing notice'); });
      check(await link.evaluate((el) => el.tagName) === 'BUTTON', 'the minutes card opens the meeting with something other than a button');
      check(/^Open the meeting$/.test((await link.innerText()).trim()), `the button reads "${await link.innerText()}"`);
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
      // The transcript is last and collapsed: "Transcript · N lines"; it opens in place.
      const transcriptBox = veraM.page.getByTestId('meeting-transcript');
      check(!(await transcriptBox.evaluate((el) => el.open === true)), 'the transcript is open before anyone asked for it');
      check(/^Transcript · \d+ lines?$/.test((await transcriptBox.locator('summary').innerText()).trim()), `the transcript reads "${(await transcriptBox.locator('summary').innerText()).trim()}"`);
      await transcriptBox.locator('summary').click();
      const out = [];
      for (const width of [1440, 1280]) {
        await fitsWidth(veraM.page, 'the meeting page', width);
        const text = await bodyText(veraM.page);
        check(/invited by Vera/.test(text), 'the header does not say who invited Nova');
        check(/summary/i.test(text) && /decisions/i.test(text) && /action items/i.test(text) && /transcript/i.test(text), `a section is missing at ${width}: ${text.slice(0, 300)}`);
        const summary = (await veraM.page.getByTestId('meeting-summary').innerText()).trim();
        check(summary.length > 10, 'the summary is empty');
        // A short summary: a lead and at most four bullets, never a "<name> said: …" echo of the transcript.
        check(!/said:/.test(summary), `the summary echoes the transcript: "${summary.slice(0, 200)}"`);
        check(await veraM.page.getByTestId('meeting-summary').locator('li').count() <= 4, 'the summary has more than four bullets');
        // No red Delete at the top: it lives in the header's menu, and only for the inviter.
        check(await veraM.page.getByRole('button', { name: /Delete this meeting/ }).count() === 0, 'a Delete button shows at the top of the page');
        check(await veraM.page.getByTestId('meeting-actions').count() === 1, 'the inviter has no header menu');
        // The people as faces in the meta line.
        check(await veraM.page.getByTestId('meeting-meta').getByTestId('meeting-people').count() === 1, 'the meta line does not show the people as avatars');
        // Faces are portraits where the directory has one (the walk's people all do), not initials.
        check(await veraM.page.getByTestId('meeting-people').locator('img').count() >= 2, 'the people in the header are initials, not portraits');
        // A done action never reads as its tool ("Ran create"); the full outcome sentence lives in the proposal's detail.
        const does = await veraM.page.getByTestId('meeting-proposals').innerText();
        check(!does.includes('Record as a decision on') && /Decision · /.test(does), 'the proposals table repeats the full outcome sentence');
        const items = (await veraM.page.getByTestId('meeting-action-items').innerText()).replace(/\s+/g, ' ');
        check(!/\bRan [a-z]+\b/.test(items), `an action item reads as a tool run: "${items}"`);
        check(/login cookie bug/i.test(items), `the action items do not hold the work item created in the call (by its title): "${items}"`);
        check((await itemsTitled(vera, 'login cookie bug')).length === 1, 'the work item the action item names does not exist exactly once');
        // Speaker names, not ids: the transcript lines were injected for u-nora and u-vera.
        check(/Nora/.test(text), 'Nora is not named in the transcript');
        check(!/\bu-nora\b|\bu-vera\b/.test(text), 'a raw user id shows on the page');
        check(text.includes('After resume: kept again.'), 'a transcript line is missing');
        // The proposals are table rows, one per proposal, and the page stays bounded: eight proposals are eight rows, not eight cards.
        const api = await (await vera.api.get(asApi(vera, 'proposals'))).json();
        const rows = await veraM.page.getByTestId('meeting-proposals').locator('tbody tr').count();
        check(rows === api.proposals.length && await veraM.page.getByTestId('meeting-proposal-row').count() === api.proposals.length, `${rows} proposal rows for ${api.proposals.length} proposals`);
        check(await veraM.page.getByTestId('assistant-proposal-card').count() === 0, 'the meeting page still draws proposal cards');
        await transcriptBox.locator('summary').click(); // closed again, to measure the page without the transcript
        // The page scrolls inside the shell's column: measure that scroller (the nearest scrolling ancestor), not the document.
        // The height of the page's content, from its title to the end of the collapsed transcript, whatever scrolls it.
        const tall = await veraM.page.evaluate(() => {
          // Every scroller above the page back to its top (the header is sticky, so scrolling the title into view is not enough).
          for (let n = document.querySelector('[data-testid="meeting-summary"]'); n; n = n.parentElement) n.scrollTop = 0;
          window.scrollTo(0, 0);
          const top = document.querySelector('[data-testid="meeting-page"] h1')?.getBoundingClientRect().top ?? 0;
          const end = document.querySelector('[data-testid="meeting-transcript"]')?.getBoundingClientRect().bottom ?? 0;
          return Math.round(end - top);
        });
        check(tall <= 2200, `the page is ${tall}px tall with ${api.proposals.length} proposals (eight rows should fit in about two screens)`);
        await transcriptBox.locator('summary').click();
        out.push(`${width}: ${rows} proposal rows, ${tall}px`);
      }
      await transcriptBox.locator('summary').click();
      for (const width of [1440, 1280]) {
        await veraM.page.setViewportSize({ width, height: 900 });
        // Back to the top of the page's own scroller, then a second shot one screen further down.
        // Set every scroller above the summary to `dy` (0 is the top; the header is sticky, so scrolling the title into view is not enough).
        const scrollTo = (dy) => veraM.page.evaluate((y) => { for (let n = document.querySelector('[data-testid="meeting-summary"]'); n; n = n.parentElement) if (n.scrollHeight > n.clientHeight) n.scrollTop = y; window.scrollTo(0, 0); }, dy);
        await scrollTo(0); await sleep(400);
        await veraM.page.screenshot({ path: path.join(SHOTS, `13-meeting-page-${width}.png`), fullPage: false });
        await scrollTo(600); await sleep(400);
        await veraM.page.screenshot({ path: path.join(SHOTS, `13-meeting-page-${width}-lower.png`), fullPage: false });
        await scrollTo(0);
      }
      return out.join(', ');
    });

    await step('13a: the meeting page says what Nova covered (its listening time, a pause, a count of people not transcribed, never their names) and how long the meeting is kept and who can delete it sooner', async () => {
      const api = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      check(api.coverage && typeof api.coverage.listenedSeconds === 'number', `the minutes carry no coverage: ${JSON.stringify(api.coverage)}`);
      const meta = (await veraM.page.getByTestId('meeting-meta').innerText()).replace(/\s+/g, ' ');
      check(/Nova listened (under a minute|\d+ min|\d+ h)/.test(meta), `the meta line does not say how long Nova listened: "${meta}"`);
      const quiet = (await veraM.page.getByTestId('meeting-kept').innerText()).replace(/\s+/g, ' ');
      if (api.coverage.pausedSeconds >= 60) check(/Nova paused for \d/.test(quiet), `Nova paused ${api.coverage.pausedSeconds}s but the quiet line says "${quiet}"`);
      const n = api.coverage.untranscribed;
      check(n > 0 ? quiet.includes(n === 1 ? '1 person was not transcribed' : `${n} people were not transcribed`) : !/not transcribed/.test(quiet), `${n} not transcribed, the quiet line says "${quiet}"`);
      check(!/not transcribed/.test(meta), 'the coverage count is on the main meta line, not the quiet one');
      check(!/\bu-[a-z]+\b/.test(meta + quiet), 'an id shows in the meta lines');
      // The retention the server knows, from the end time; the inviter reads "You can delete it sooner".
      check(typeof api.keptUntil === 'number' && api.keptUntil > api.endedAt + 86_400_000, `keptUntil is ${api.keptUntil} for a meeting that ended ${api.endedAt}`);
      const kept = (await veraM.page.getByTestId('meeting-kept').innerText()).replace(/\s+/g, ' ').trim();
      check(/^Kept until \d{1,2} [A-Z][a-z]{2,3} \d{4} · You can delete it sooner\b/.test(kept), `the inviter reads "${kept}"`);
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
      const rowOf = (id) => veraM.page.locator(`[data-testid="meeting-proposal-row"][data-proposal-id="${id}"]`);
      const cardM = rowOf(p3);
      await cardM.waitFor({ timeout: 15000 }).catch(() => { throw new StepFailure('no row for the open proposal on the meeting page'); });
      check((await cardM.getAttribute('data-state')) === 'open', `the row is ${await cardM.getAttribute('data-state')}`);
      check(await rowOf(p1).getAttribute('data-state') === 'done', 'the recorded proposal is not listed as done');
      // The open proposal waits on Vera, so it heads "Needs you" with its one action.
      check((await veraM.page.getByTestId('meeting-needs-you').innerText()).includes(PROPOSAL_3), 'the open proposal is not under "Needs you"');
      // The meeting page asks in its own composer's deck (the page's command host), with the call's own prompt.
      const deckM = veraM.page.getByTestId('collection-command-host');
      await deckM.filter({ hasText: PROPOSAL_3 }).waitFor({ timeout: 20000 }).catch(() => { throw new StepFailure('the meeting page does not ask about the open proposal'); });
      const ask = await deckM.innerText();
      check(ask.includes('Consent and record') && !ask.includes('Not a decision'), `the meeting page's prompt: ${ask.replace(/\s+/g, ' ')}`);
      await shot(veraM.page, '13b-meeting-proposal-ask', 1280);
      // With the prompt showing, the page's end scrolls clear of it: the last proposal row and the collapsed Transcript header sit
      // fully above the deck (and the footer) once the page is scrolled to its end, at both widths.
      const clear = [];
      for (const width of [1440, 1280]) {
        await veraM.page.setViewportSize({ width, height: 900 });
        await sleep(500);
        const r = await veraM.page.evaluate(() => {
          const rows = document.querySelectorAll('[data-testid="meeting-proposal-row"]');
          const last = rows[rows.length - 1];
          const head = document.querySelector('[data-testid="meeting-transcript"] summary');
          // The document itself never scrolls (the shell is one screen tall): measure that before anything is scrolled.
          window.scrollTo(0, 0);
          const docOver = document.documentElement.scrollHeight - innerHeight;
          // On a failure, name what reaches below the screen with no clipping ancestor (what makes the document taller).
          const clipped = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (getComputedStyle(a).overflowY !== 'visible' || getComputedStyle(a).overflowX !== 'visible') return true; } return false; };
          const out = (el) => { const pos = getComputedStyle(el).position; return pos === 'absolute' || pos === 'fixed' ? true : !clipped(el); };
          const past = docOver > 1 ? [...document.querySelectorAll('body *')].filter((el) => { const b = el.getBoundingClientRect(); return b.height > 0 && b.bottom > innerHeight + 1 && out(el); })
            .slice(0, 8).map((el) => `${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? ''}](${getComputedStyle(el).position}).${String(el.className).slice(0, 60)} "${(el.textContent ?? '').slice(0, 30)}" in ${el.parentElement?.tagName.toLowerCase()}.${String(el.parentElement?.className ?? '').slice(0, 40)} ${Math.round(el.getBoundingClientRect().top)}..${Math.round(el.getBoundingClientRect().bottom)}`) : [];
          // Every scroller above the page to its end (the header is sticky, so one scrollIntoView is not the test).
          for (let n = head?.parentElement; n && n !== document.body; n = n.parentElement) if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
          const deck = document.querySelector('[data-testid="collection-command-host"]')?.getBoundingClientRect();
          const foot = document.querySelector('[data-testid="shell-footer"]')?.getBoundingClientRect();
          const floor = Math.min(deck?.top ?? innerHeight, foot?.top ?? innerHeight);
          const box = (el) => { const b = el?.getBoundingClientRect(); return b ? { top: Math.round(b.top), bottom: Math.round(b.bottom) } : null; };
          let scroller = null;
          for (let n = head?.parentElement; n; n = n.parentElement) if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) { scroller = n; break; }
          const sb = scroller?.getBoundingClientRect();
          return { docOver, past, floor: Math.round(floor), row: box(last), head: box(head), deckTop: Math.round(deck?.top ?? -1), footTop: Math.round(foot?.top ?? -1),
            scroller: sb ? { top: Math.round(sb.top), bottom: Math.round(sb.bottom), testid: scroller.getAttribute('data-testid') ?? scroller.className.slice(0, 60) } : null };
        });
        await shot(veraM.page, '13b-meeting-end-with-prompt', width);
        check(r.docOver <= 1, `at ${width} with the prompt showing the document scrolls by ${r.docOver}px: ${JSON.stringify(r)}`);
        check(r.row && r.head, `the last proposal row or the Transcript header is missing: ${JSON.stringify(r)}`);
        check(r.row.bottom <= r.floor + 1 && r.head.bottom <= r.floor + 1, `at ${width} the page's end stays behind the prompt: ${JSON.stringify(r)}`);
        check(r.row.top >= (r.scroller?.top ?? 0) - 1, `at ${width} the last proposal row is above its scroller: ${JSON.stringify(r)}`);
        clear.push(`${width}: row ends ${r.row.bottom}, transcript ${r.head.bottom}, deck ${r.deckTop}, scroller ${JSON.stringify(r.scroller)}, footer ${r.footTop}`);
      }
      await digit(veraM, '1', deckM);
      await waitFor(async () => (await cardM.getAttribute('data-state').catch(() => null)) === 'done', 20000, 'the row reading done');
      // The row opens its detail: how it ended, with its link.
      await cardM.click();
      const detail = veraM.page.getByTestId('meeting-proposal-detail');
      await waitFor(async () => recorded(PROPOSAL_3).test(await detail.innerText().catch(() => '')), 20000, 'the closing line in the proposal detail');
      await detail.getByTestId('meeting-proposal-result-link').waitFor({ timeout: 15000 });
      check(results_.some((r) => r.by === 'vera#m' && r.ok), 'the meeting page posted no result');
      const minutes = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      const listed = (minutes.proposals ?? []).find((p) => p.id === p3);
      check(listed?.state === 'done' && listed.consentedBy.length === 2, `the minutes list it as ${JSON.stringify(listed)}`);
      await shot(veraM.page, '13b-meeting-proposal-recorded', 1280);
      await veraM.page.getByTestId('meeting-proposal-detail-close').click();
      return `recorded on the meeting page; minutes: ${listed.state}, consented by ${listed.consentedBy.join(' and ')}; end clear of the prompt (${clear.join('; ')})`;
    });

    // ── R. Nova invited back into the call it left (after the first period's minutes steps, which read the first period) ──
    let rejoinBefore = null;
    await step('R1: a third person joins again; each person sees why Nova left and "Invite Nova again" beside it, and the footer is one line at 1440 and 1280 with three people (screenshots)', async () => {
      eli = await person({ userId: 'u-eli', role: 'sme' });
      await eli.page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' }).click({ timeout: 30000 });
      await eli.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
      for (const p of [vera, nora, eli]) {
        await seen(p.page, 'nova-left', 20000);
        await seen(p.page, 'nova-invite-again', 20000);
        const why = (await p.page.getByTestId('nova-left').innerText()).trim();
        check(/^.+ dismissed Nova\.$/.test(why) && !/cannot rejoin/.test(why), `${p.who.userId}'s chip reads "${why}"`);
      }
      for (const width of [1440, 1280]) {
        const r = await barFits(vera.page, 'the bar after the dismissal with three people', width);
        await shot(vera.page, 'R1-left-invite-again', width);
        check(r.novaWidth > 0, `Nova's controls are not on the footer row at ${width}`);
      }
      const m = await (await vera.api.get(asApi(vera, 'minutes'))).json();
      rejoinBefore = m.actionItems.map((i) => ({ text: i.text, workItemCreated: i.workItemCreated === true, workItemHref: i.workItemHref ?? null }));
      check(rejoinBefore.length >= 1, 'the first minutes hold no action items to keep in place');
      return `three people; ${rejoinBefore.length} earlier action items`;
    });

    await step('R2: the inviter uses "Invite Nova again": Nova listens again for everyone, the chat has one notice that it is back at her invitation, and the others owe the acknowledgement again (the notice shows again, saying Nova was invited back)', async () => {
      await vera.page.getByTestId('nova-invite-again').click();
      await waitMark(vera.page, /^Nova is listening$/, 20000);
      await gone(vera.page, 'nova-invite-again');
      const st = await stateOf(vera);
      check(st.state === 'listening' && st.invitedBy === VERA.userId && st.period === 2, `the state after inviting Nova back: ${JSON.stringify({ state: st.state, invitedBy: st.invitedBy, period: st.period })}`);
      check(st.mustAck.includes(NORA.userId) && st.mustAck.includes('u-eli') && !st.mustAck.includes(VERA.userId), `who owes the acknowledgement: ${JSON.stringify(st.mustAck)}`);
      check(st.voice === false, 'the voice did not reset to off');
      const back = await waitFor(async () => (await novaOf(vera, 'assistant-notice')).filter((m) => /^Nova is back in this call at .+'s invitation and is listening again\./.test(m.message)), 15000, 'the notice that Nova is back');
      check(back.length === 1, `${back.length} notices say Nova is back`);
      // Nora had closed the first notice in 3b: a new period shows it again.
      await seen(nora.page, 'nova-notice', 20000);
      const title = (await nora.page.getByTestId('nova-notice').innerText()).replace(/\s+/g, ' ');
      check(/invited Nova back into this call/.test(title), `the notice does not say Nova was invited back: "${title.slice(0, 160)}"`);
      check((await stateOf(nora)).youMustAck === true, 'the second person does not owe a new acknowledgement');
      await shot(nora.page, 'R2-notice-again');
      return `"${back[0].message.slice(0, 120)}"`;
    });

    await step('R3: the second person\'s words are not kept before she acknowledges again; after she does, they are; the meeting page says Nova is back and what it hears is added', async () => {
      const before = 'Before acknowledging again: the rejoin draft is private.';
      await inject(NORA.userId, before);
      check(!(await stored(vera, before, 3500)), 'a line from a person who had not acknowledged again was stored');
      await nora.page.getByTestId('nova-notice-acknowledge').click();
      await gone(nora.page, 'nova-notice');
      check((await stateOf(nora)).youMustAck === false, 'the acknowledgement did not take');
      const said = 'Nora will draft the rejoin summary.';
      await inject(NORA.userId, said);
      check(await stored(vera, said, 10000), 'a line after the new acknowledgement was not stored');
      check(!(await transcript(vera)).includes(before), 'the line from before the acknowledgement appeared later');
      // The third person leaves again (a third face on the initiative's presence would widen the footer the later steps measure).
      await eli.page.getByTestId('call-dock-leave').first().click({ timeout: 10000 });
      await gone(eli.page, 'call-dock-leave', 20000);
      await eli.context.close();
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-addition-note', 30000);
      const note = (await veraM.page.getByTestId('meeting-addition-note').innerText()).trim();
      check(note === 'Nova is back in this call. What it hears now is added to these minutes when it leaves.', `the meeting page says "${note}"`);
      for (const width of [1440, 1280]) await shot(veraM.page, 'R3-meeting-back', width);
      return 'before: absent; after: stored; page note shown';
    });

    await step('R3b: the second person opens the live transcript from Nova\'s menu in the second period; it stays open through R4 and R5', async () => {
      await novaMenu(nora, /Show transcript/);
      await seen(nora.page, 'live-transcript');
      const head = (await nora.page.getByTestId('live-transcript-panel').locator('header').first().innerText()).replace(/\s+/g, ' ').trim();
      check(/^Live transcript/.test(head) && /Nova is listening/.test(head), `the transcript's header reads "${head}"`);
      await waitFor(async () => Number(await nora.page.getByTestId('live-transcript').getAttribute('data-lines')) > 0, 10000, 'the stored lines in the second person\'s transcript');
      return `"${head}"`;
    });

    await step('R4: Nova is dismissed again; the minutes hold both periods: the earlier action items at their places (the work item made in the call still linked), the new one after them, one more minutes card saying Nova added to them', async () => {
      await novaMenu(vera, 'Dismiss Nova for everyone');
      await vera.page.getByTestId('nova-dismiss-ask').getByRole('button', { name: /Dismiss Nova for everyone/ }).click();
      await seen(vera.page, 'nova-left', 20000);
      const m = await waitFor(async () => { const r = await (await vera.api.get(asApi(vera, 'minutes'))).json(); return r.additions === 1 ? r : null; }, 30000, 'the minutes being added to');
      const items = m.actionItems.map((i) => ({ text: i.text, workItemCreated: i.workItemCreated === true, workItemHref: i.workItemHref ?? null }));
      check(JSON.stringify(items.slice(0, rejoinBefore.length)) === JSON.stringify(rejoinBefore), `the earlier action items moved or changed: ${JSON.stringify(rejoinBefore)} then ${JSON.stringify(items.slice(0, rejoinBefore.length))}`);
      const done = rejoinBefore.findIndex((i) => /login cookie bug/i.test(i.text));
      check(done >= 0 && items[done].workItemCreated, `the work item made in the call is not linked at its place: ${JSON.stringify(items)}`);
      check(items.slice(rejoinBefore.length).some((i) => /draft the rejoin summary/i.test(i.text)), `the new action item is not after the earlier ones: ${JSON.stringify(items.slice(rejoinBefore.length))}`);
      check(m.backInCall === false && m.additionOwed === false, `the minutes say ${JSON.stringify({ backInCall: m.backInCall, additionOwed: m.additionOwed })}`);
      check(/After Nova was invited back/.test(m.summaryLead), `the summary does not cover both periods: "${m.summaryLead}"`);
      const cards = (await chatMessages(vera)).filter((x) => x.metadata?.kind === 'assistant-notice' && x.metadata?.minutes);
      check(cards.length === 2 && cards[1].metadata.minutes.added === true, `the minutes cards in the chat: ${JSON.stringify(cards.map((c) => c.metadata.minutes))}`);
      const card = vera.page.getByTestId('assistant-minutes-card').last();
      await waitFor(async () => (await card.getByTestId('assistant-minutes-title').innerText().catch(() => '')).trim() === 'Nova added to the minutes', 20000, 'the chat card saying Nova added to the minutes');
      check((await card.getByTestId('assistant-minutes-status').innerText()).trim() === 'Updated', 'the added card is not marked Updated');
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-action-items', 30000);
      check(/draft the rejoin summary/i.test(await veraM.page.getByTestId('meeting-action-items').innerText()), 'the meeting page does not show the new action item');
      check(await veraM.page.getByTestId('meeting-addition-note').count() === 0, 'the meeting page still says Nova is back');
      for (const width of [1440, 1280]) await shot(veraM.page, 'R4-meeting-both-periods', width);
      return `${rejoinBefore.length} earlier items in place, ${items.length - rejoinBefore.length} added; "${m.summaryLead.slice(0, 120)}"`;
    });

    await step('R5: the second person\'s transcript, open since the second period, says Nova left; Nova invited back a third time, it listens again; she acknowledges, says a line and dismisses Nova at once: after Nova has left the view shows that line (the read after a leave is made again in a later period)', async () => {
      const panel = nora.page.getByTestId('live-transcript-panel');
      const head = async () => (await panel.locator('header').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      check(await nora.page.getByTestId('live-transcript').isVisible(), 'the second person\'s live transcript closed with the dismissal');
      await waitFor(async () => /Nova has left; this is what it heard/.test(await head()), 20000, 'the open transcript saying Nova has left');
      await vera.page.getByTestId('nova-invite-again').click();
      await waitMark(vera.page, /^Nova is listening$/, 20000);
      await waitFor(async () => /Nova is listening/.test(await head()), 20000, 'the open transcript listening again');
      await seen(nora.page, 'nova-notice', 20000);
      await nora.page.getByTestId('nova-notice-acknowledge').click();
      await gone(nora.page, 'nova-notice');
      const last = `Third period: the rollout note goes out with build ${Date.now() % 100000}.`;
      await inject(NORA.userId, last);
      check(await stored(vera, last, 10000), 'the line before the third dismissal was not stored');
      await novaMenu(nora, 'Dismiss Nova for everyone');
      await nora.page.getByTestId('nova-dismiss-ask').getByRole('button', { name: /Dismiss Nova for everyone/ }).click();
      await seen(nora.page, 'nova-left', 20000);
      await panel.locator('[data-seg-index]').filter({ hasText: last }).waitFor({ state: 'visible', timeout: 10000 })
        .catch(() => { throw new StepFailure('after Nova left again the open transcript never showed the last line said before'); });
      const after = await head();
      check(/Nova has left; this is what it heard/.test(after), `after the third dismissal the transcript's header reads "${after}"`);
      await waitFor(async () => { const r = await (await vera.api.get(asApi(vera, 'minutes'))).json(); return r.additions === 2 ? r : null; }, 30000, 'the minutes being added to for the third period');
      await nora.page.getByTestId('live-transcript-back').click();
      await gone(nora.page, 'live-transcript');
      await seen(nora.page, 'huddle-thread');
      return `"${after}"; the last line shown after the leave`;
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
      // Faces, length and outcomes on the row; the second line is the summary's lead, never a "said:" echo.
      const table = veraM.page.getByTestId('iq-meetings-table');
      check(await table.getByTestId('iq-meetings-people').count() >= 1, 'the list shows no avatars for the people');
      check(await table.getByTestId('iq-meetings-people').first().locator('img').count() >= 2, 'the list shows initials, not portraits');
      const outcomes = (await table.getByTestId('iq-meetings-outcomes').first().innerText().catch(() => '')).trim();
      check(/^(\d+ decisions?|\d+ actions?|\d+ open|Nothing recorded)( · .+)*$/.test(outcomes), `the outcomes cell reads "${outcomes}"`);
      check(own.outcomes && Number.isInteger(own.outcomes.decisions) && typeof own.listenedSeconds === 'number', `the API row has no outcomes or length: ${JSON.stringify(own).slice(0, 300)}`);
      check(!/said:/.test(await table.innerText()), 'the list echoes the transcript');
      for (const width of [1440, 1280]) {
        await veraM.page.setViewportSize({ width, height: 900 });
        await sleep(400);
        await veraM.page.screenshot({ path: path.join(SHOTS, `15-meetings-list-${width}.png`), fullPage: false });
      }
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
      check(await noraM.page.getByTestId('meeting-delete').count() === 0 && await noraM.page.getByTestId('meeting-actions').count() === 0, 'a person who did not invite Nova is offered Delete');
      const keptForNora = (await noraM.page.getByTestId('meeting-kept').innerText()).replace(/\s+/g, ' ').trim();
      check(/^Kept until .+ · .+ can delete it sooner\b/.test(keptForNora) && !keptForNora.includes('You can'), `an attendee who did not invite Nova reads "${keptForNora}"`);
      const refused = await nora.api.delete(asApi(nora, 'minutes'));
      check(refused.status() === 403, `a non-inviter deleting answered ${refused.status()}`);
      await veraM.page.goto(MEETING(), { waitUntil: 'domcontentloaded', timeout: 40000 });
      await seen(veraM.page, 'meeting-actions', 30000);
      await veraM.page.getByTestId('meeting-actions').click();
      await seen(veraM.page, 'meeting-delete', 10000);
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
