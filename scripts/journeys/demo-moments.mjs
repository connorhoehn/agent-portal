#!/usr/bin/env node
// The five demo moments of docs/demo-script.md §1 (Halyard, Auth Migration), each performed twice: by hand
// (clicks and keys) and by voice on the scripted session (MOCK_VOICE=1, PUT /api/voice/mock-script). How to run it
// and what each moment asserts: docs/journeys.md.
//
//   PORTAL_URL=http://localhost:5166 MIDDLEWARE_URL=http://127.0.0.1:3966 node scripts/journeys/demo-moments.mjs
//     [--only M1,M3] [--mode hand|voice] [--out <dir>]
//
// Env: PORTAL_URL (vite, proxying /api to the middleware), MIDDLEWARE_URL (the middleware itself: health and
// POST /api/__mock/reset), CHROMIUM_PATH (a Chromium or headless-shell binary; else Playwright's own, found through
// PLAYWRIGHT_BROWSERS_PATH), OUT_DIR (default: a fresh directory under the OS temp dir).
//
// Each run (moment × mode) starts from seeded state (POST /api/__mock/reset), signs its persona in through the
// session API, and records per step: pass/fail, milliseconds, the /api requests and WebSocket frames sent, the `say`
// line each voice result carried (asserted terse: one sentence, at most 25 words) and a screenshot. It writes
// results.json and results.md to the out dir and exits 0 only when every step of every run passed (1 otherwise,
// 2 when the stack is not reachable).
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
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'demo-moments-'));
const ONLY = new Set((flag('--only') ?? 'M1,M2,M3,M4,M5').split(',').map((s) => s.trim().toUpperCase()));
const MODES = (flag('--mode') ? [flag('--mode')] : ['hand', 'voice']);
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const PERSONAS = { vera: { userId: 'u-vera', role: 'org-leader' }, nora: { userId: 'u-nora', role: 'sme' } };
const INITIATIVE = '/iq/projects/p-auth-migration';
const DECISION = 'd-cognito-cutover';
const OPTION = 'Riskiest two tenants first';
const MESSAGE = 'The cutover order is decided; rehearsal Thursday.';
const BUG = 'Logout leaves the legacy shim cookie alive';
const RUNBOOK = 'Tenant-by-tenant cutover runbook with rollback';
const SPRINT9_STORIES = ['BFF authorization-code + PKCE flow behind the middleware', 'JWKS verification with kid-rotation handling', 'Inventory every consumer still on the SAML shim'];
const IAM_PEOPLE = ['Simone Chang', 'Diego Ortiz', 'Vera Green', 'Joy Chen', 'Nora DaSilva'];
/** How far down the person results the five must all be. */
const IAM_TOP = 7;
const MAX_SAY_WORDS = 25;

// ── plumbing ─────────────────────────────────────────────────────────────────

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

/** A `say` line is terse: one sentence, at most MAX_SAY_WORDS words. Returns the reason it is not, else null. */
function sayProblem(say) {
  if (typeof say !== 'string' || !say.trim()) return 'no say line';
  const words = say.trim().split(/\s+/).length;
  if (words > MAX_SAY_WORDS) return `${words} words (at most ${MAX_SAY_WORDS})`;
  const sentences = say.trim().split(/(?<=[.!?])\s+(?=["“A-Z0-9])/).filter(Boolean);
  if (sentences.length > 1) return `${sentences.length} sentences`;
  return null;
}

async function reachable() {
  for (const [name, url] of [['middleware', `${MIDDLEWARE}/api/health`], ['portal', `${PORTAL}/`]]) {
    try { const r = await fetch(url); if (r.status >= 500) throw new Error(`HTTP ${r.status}`); } catch (e) { return `${name} at ${url}: ${e.message}`; }
  }
  return null;
}

async function resetMock() {
  const r = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  if (r.status !== 200) throw new Error(`POST /api/__mock/reset answered ${r.status}`);
}

/** A signed-in context for a persona: the session API through the portal, so the cookie is the portal's. */
async function signIn(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const login = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
  if (login.status() !== 200) throw new Error(`login ${who.userId}: ${login.status()}`);
  const role = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
  if (role.status() !== 200) throw new Error(`role ${who.role}: ${role.status()}`);
  // The scripted session's frames (portal lib/voice/client.ts MOCK_FRAME_EVENT), kept for the say lines.
  await ctx.addInitScript(() => {
    window.__voiceFrames = [];
    window.addEventListener('voice-mock-frame', (e) => window.__voiceFrames.push(e.detail));
  });
  return ctx;
}

/** The /api requests and the WebSocket frames a page sends, read per step. */
function recorder(page) {
  const log = [];
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    log.push(`${r.request().method()} ${u.replace(PORTAL, '').replace(MIDDLEWARE, '')} ${r.status()}`);
  });
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const text = typeof f.payload === 'string' ? f.payload : '';
    let type = 'frame', channel = '';
    try {
      const j = JSON.parse(text);
      type = j.type ?? j.action ?? j.event ?? 'frame';
      const c = j.channel ?? j.channelId ?? j.payload?.channel ?? j.data?.channel;
      if (typeof c === 'string') channel = ` ${c}`;
    } catch { /* binary or not JSON */ }
    // Heartbeats and typing say nothing about what the step did.
    if (!/^(ping|pong|heartbeat|typing)$/i.test(type)) log.push(`WS ${type}${channel}`);
  }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  return { mark: () => log.length, since: (n) => log.slice(n), errors };
}

async function text(page, sel = 'body') {
  return page.evaluate((s) => (document.querySelector(s)?.innerText ?? '').replace(/\s+/g, ' ').trim(), sel);
}

/** Wait, bounded, until the selector's text matches; returns the text. */
async function waitText(page, sel, re, ms = 15000) {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    last = await text(page, sel).catch(() => '');
    if (re.test(last)) return last;
    await sleep(250);
  }
  throw new StepFailure(`${sel} never read ${re} in ${ms} ms (it read: "${last.slice(0, 200)}")`);
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}

async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await settle(page);
}

/** The voice results (function_call_output) the dock has handed the scripted session so far. */
async function voiceOutputs(page) {
  const frames = await page.evaluate(() => window.__voiceFrames ?? []);
  return frames.filter((f) => f.dir === 'out' && f.event?.type === 'response.item.create' && f.event.item?.type === 'function_call_output')
    .map((f) => { try { return JSON.parse(f.event.item.output); } catch { return { raw: String(f.event.item.output) }; } });
}

/** Wait, bounded, for the nth voice result. */
async function nthOutput(page, n, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const outs = await voiceOutputs(page);
    if (outs.length >= n) return outs[n - 1];
    await sleep(200);
  }
  throw new StepFailure(`the voice result ${n} never came back in ${ms} ms`);
}

/** Script the next voice session (MOCK_VOICE only) and start the dock. */
async function startVoice(page, turns) {
  const r = await page.context().request.put(`${PORTAL}/api/voice/mock-script`, { data: { turns } });
  check(r.status() === 204, `PUT /api/voice/mock-script answered ${r.status()} (is the middleware running with MOCK_VOICE=1?)`);
  // Each session's results are counted from its own start.
  await page.evaluate(() => { window.__voiceFrames = []; });
  await page.getByTestId('shell-voice-dock-start').click();
}

async function stopVoice(page) {
  const stop = page.getByTestId('shell-voice-dock-stop');
  if (await stop.count()) await stop.click().catch(() => undefined);
  await sleep(500);
}

/**
 * The say line a result carries, asserted terse and, when given, equal to the line docs/demo-script.md quotes;
 * returned for the record.
 */
function terseSay(out, label, expected) {
  check(out && out.kind !== 'refused' && out.kind !== 'failed', `${label}: the voice result was ${out?.kind}: ${out?.reason ?? out?.raw ?? ''}`);
  const problem = sayProblem(out.say);
  check(!problem, `${label}: the say line is not terse (${problem}): ${JSON.stringify(out.say)}`);
  if (expected) check(out.say === expected, `${label}: the voice says ${JSON.stringify(out.say)}, the demo script quotes ${JSON.stringify(expected)}`);
  return out.say;
}

// ── the moments ──────────────────────────────────────────────────────────────

const OPEN = { page: null, ref: null, kind: null, name: null, scope: null, tab: null, params: null };

/** M1: Vera opens Auth Migration and walks its tabs. */
const M1 = {
  title: 'Open Auth Migration and walk its tabs', persona: 'vera',
  async hand(s, page) {
    await s('open Auth Migration from Initiatives', async () => {
      await go(page, '/iq/projects');
      await page.getByRole('link', { name: 'Auth Migration', exact: true }).first().click();
      await page.waitForURL(/\/iq\/projects\/p-auth-migration/, { timeout: 15000 });
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
    });
    await s('Work tab: the blocked runbook story and the open logout bug', async () => {
      await page.getByTestId('initiative-header-tab-work').click();
      const t = await waitText(page, '[data-testid=explorer-layout-pane]', /Tenant-by-tenant cutover runbook with rollback/);
      check(t.includes(BUG), 'the logout cookie bug is not on the Work tab');
    });
    await s('Decisions tab: the escalated cutover decision', async () => {
      await page.getByTestId('initiative-header-tab-decisions').click();
      const t = await waitText(page, '[data-testid=explorer-layout-pane]', /Cutover order for legacy SSO tenants/);
      check(/escalated/i.test(t), 'the cutover decision is not shown escalated');
    });
    await s('Docs tab: the cutover plan and the session-hygiene whiteboard', async () => {
      await page.getByTestId('initiative-header-tab-docs').click();
      const t = await waitText(page, '[data-testid=explorer-layout-pane]', /Tenant cutover plan/);
      check(/Session hygiene/i.test(t), 'the session-hygiene whiteboard is not on the Docs tab');
    });
    await s('the Discussion pane is #auth-migration: the rehearsal thread and Sienna\'s promise', async () => {
      // One conversation per initiative: the bound channel IS the Discussion pane (no separate initiative thread).
      await page.getByTestId('initiative-pane-tab-discussion').click();
      const t = await waitText(page, '[data-testid=initiative-pane-discussion]', /Second rehearsal failed at the flip/);
      check(/#auth-migration/.test(t), `the Discussion pane does not name #auth-migration: "${t.slice(0, 200)}"`);
      check(/Then I decide the order once the retry is clean/.test(t), "Sienna's promise is not in the Discussion pane");
    });
    await s('Agents tab', async () => {
      await page.getByTestId('initiative-header-tab-agents').click();
      await page.waitForURL(/tab=agents/, { timeout: 10000 });
      const t = await text(page, '[data-testid=explorer-layout-pane]');
      check(t.length > 40, `the Agents tab is empty: "${t}"`);
    });
  },
  async voice(s, page) {
    await s('voice: "Open Auth Migration." from Initiatives', async () => {
      await go(page, '/iq/projects');
      await startVoice(page, [
        { said: 'Open Auth Migration.', call: { name: 'open', arguments: { ...OPEN, kind: 'initiative', name: 'Auth Migration' } } },
        { said: 'Open decisions.', call: { name: 'open', arguments: { ...OPEN, scope: 'this-page', tab: 'decisions' } } },
      ]);
      const say = terseSay(await nthOutput(page, 1), 'open Auth Migration', 'Opened Auth Migration.');
      await page.waitForURL(/\/iq\/projects\/p-auth-migration/, { timeout: 10000 });
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
      return { say: [say] };
    });
    await s('voice: "Open decisions." opens the Decisions tab', async () => {
      const say = terseSay(await nthOutput(page, 2), 'open decisions', 'Showing decisions.');
      await page.waitForURL(/\/iq\/projects\/p-auth-migration\?(.*&)?tab=decisions/, { timeout: 10000 });
      await waitText(page, '[data-testid=explorer-layout-pane]', /Cutover order for legacy SSO tenants/);
      await stopVoice(page);
      return { say: [say] };
    });
  },
};

/** M2: decide the cutover order, Riskiest two tenants first. */
const M2 = {
  title: 'Decide the cutover order', persona: 'vera',
  async hand(s, page) {
    await s('open the decision from the Decisions tab', async () => {
      await go(page, `${INITIATIVE}?tab=decisions`);
      await page.getByRole('link', { name: 'Cutover order for legacy SSO tenants' }).first().click();
      await page.waitForURL(new RegExp(`/iq/decisions/${DECISION}`), { timeout: 15000 });
      await waitText(page, '[data-testid=collection-command-composer-prompts]', /Riskiest two tenants first/);
    });
    await s('keypad 2 then Enter at once in the docked composer', async () => {
      // "Why? One line, optional. Enter decides.": the Enter comes in the same tick as the 2, before the reason field
      // can have the focus (a real keyboard.press waits a round trip, which hides the gap); the page carries it there
      // (portal pages/decisions/keyCarry.ts) and it decides.
      const decided = page.waitForResponse((r) => r.url().includes(`/api/graph/decisions/${DECISION}/decide`), { timeout: 15000 });
      await page.evaluate(() => {
        for (const key of ['2', 'Enter']) (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      const r = await decided.catch(() => { throw new StepFailure('the Enter pressed right after 2 decided nothing'); });
      check(r.status() === 200, `POST /decide answered ${r.status()}`);
      check((await r.json()).outcome === OPTION, 'the decision was not recorded as the option alone');
    });
    await assertDecided(s, page);
  },
  async voice(s, page) {
    await s('voice: "Decide the cutover order: riskiest two tenants first." shows a click-only card', async () => {
      await go(page, `${INITIATIVE}?tab=decisions`);
      await startVoice(page, [
        { said: 'Decide the cutover order: riskiest two tenants first.', call: { name: 'decide', arguments: { ref: '1', decision: 'resolve', note: null, scope: 'this-page', option: OPTION } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      const card = page.getByTestId('voice-confirm-card');
      await card.waitFor({ timeout: 15000 });
      const t = await text(page, '[data-testid=voice-confirm-card]');
      check(t.includes(OPTION), `the card does not name the option: "${t}"`);
      check(/click confirm/i.test(t), `the card does not ask for a click: "${t}"`);
    });
    await s('the spoken "confirm" does not decide it; a click does', async () => {
      // A decision card is click-only (catalogue confirmBy: click): the spoken "Confirm." (cued on the card) is heard
      // and the voice is told to ask for the click (G40 click-required); the card stays open and nothing is sent.
      const heard = Date.now() + 8000;
      while (Date.now() < heard) {
        const frames = await page.evaluate(() => window.__voiceFrames ?? []);
        if (frames.some((f) => f.dir === 'in' && f.event?.type === 'session.input_transcript.delta' && f.event.delta === 'Confirm.')) break;
        await sleep(200);
      }
      await sleep(1000);
      check(await page.getByTestId('voice-confirm-card').count() === 1, 'the card closed on the spoken confirm');
      const decided = page.waitForResponse((r) => r.url().includes(`/api/graph/decisions/${DECISION}/decide`), { timeout: 15000 });
      await page.getByTestId('voice-confirm-card-confirm').click();
      const r = await decided;
      check(r.status() === 200, `POST /decide answered ${r.status()}`);
      const out = await nthOutput(page, 1);
      const say = terseSay(out, 'decide', `Resolved: "Cutover order for legacy SSO tenants" (Riskiest two tenants first); "${RUNBOOK}" is unblocked.`);
      await stopVoice(page);
      return { say: [say] };
    });
    await assertDecided(s, page);
  },
};

async function assertDecided(s, page) {
  await s('the record reads Decided … by Vera Green: Riskiest two tenants first', async () => {
    if (!page.url().includes(`/iq/decisions/${DECISION}`)) await go(page, `/iq/decisions/${DECISION}`);
    const t = await waitText(page, '[data-testid=decision-record]', /Decided .*by Vera Green/);
    check(t.includes(OPTION), `the record does not name the choice: "${t.slice(0, 300)}"`);
    const held = await waitText(page, '[data-testid=decision-held-work]', /Unblocked/i);
    check(held.includes(RUNBOOK), `the record does not say the runbook story was unblocked: "${held}"`);
  });
  await s('the runbook story is no longer blocked by a waiting decision', async () => {
    await go(page, INITIATIVE);
    const t = await waitText(page, '[data-testid=explorer-layout-pane]', /Auth Migration|points delivered/);
    check(!/Blocked on "Cutover order for legacy SSO tenants"/.test(t), 'the overview still shows the runbook story blocked on the cutover decision');
    check(!/Waiting on a decision/.test(t), 'the overview still lists a decision waiting');
  });
  await s('the Work tab and the story itself no longer read blocked; its history says why', async () => {
    await go(page, `${INITIATIVE}?tab=work&item=wi-auth-e2-s2`);
    const t = await waitText(page, '[data-testid=explorer-layout-pane]', new RegExp(RUNBOOK));
    check(!/Blocked on "Cutover order for legacy SSO tenants"/.test(t), 'the Work tab still shows the runbook story blocked on the cutover decision');
    const items = await page.context().request.get(`${PORTAL}/api/graph/projects/p-auth-migration/work`);
    const flat = []; const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.id && n.title) flat.push(n); for (const k of ['children', 'items']) if (n[k]) walk(n[k]); } };
    walk(await items.json());
    const story = flat.find((w) => w.id === 'wi-auth-e2-s2');
    check(story && !story.labels.includes('blocked') && !story.blockedReason, `the runbook story is still blocked: ${JSON.stringify(story && { labels: story.labels, blockedReason: story.blockedReason })}`);
    check(story.status === 'open', `the runbook story left its status: ${story.status}`);
    const feed = await (await page.context().request.get(`${PORTAL}/api/graph/work-items/wi-auth-e2-s2/comments`)).json();
    const line = (feed.comments ?? []).find((c) => c.isSystem && /^Unblocked: Cutover order for legacy SSO tenants decided: Riskiest two tenants first/.test(c.body));
    check(line, `the story's history has no "Unblocked: …" line: ${JSON.stringify((feed.comments ?? []).filter((c) => c.isSystem).map((c) => c.body))}`);
  });
}

/** M3: a deck of last sprint, Sprint 9 — OIDC core and its three merged stories. */
const M3 = {
  title: "A deck of this initiative's progress this past sprint", persona: 'vera',
  async hand(s, page) {
    await s('New › Presentation with the Focus field, Build deck', async () => {
      await go(page, `${INITIATIVE}?tab=docs`);
      await page.getByTestId('initiative-files-new').click();
      await page.getByRole('menuitem', { name: /Presentation/ }).click();
      const focus = page.getByTestId('initiative-deck-focus');
      await focus.waitFor({ timeout: 10000 });
      const field = (await focus.evaluate((e) => e.matches('input,textarea'))) ? focus : focus.locator('input,textarea').first();
      await field.fill("this initiative's progress this past sprint");
      await page.getByTestId('initiative-deck-submit').click();
    });
    await assertDeck(s, page);
  },
  async voice(s, page) {
    await s('voice: "Make a deck of this initiative\'s progress this past sprint." then "Confirm."', async () => {
      await go(page, INITIATIVE);
      await startVoice(page, [
        { said: "Make a deck of this initiative's progress this past sprint.", call: { name: 'queue_work', arguments: { kind: 'deck', target: 'this initiative', note: null, model: null, rows: null, scope: 'this-page', focus: 'progress this past sprint' } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
      const out = await nthOutput(page, 1, 30000);
      const say = terseSay(out, 'queue_work deck', 'The Auth Migration deck: done (focus: Sprint 9 — OIDC core (2026-10-18 to 2026-10-31)).');
      return { say: [say] };
    });
    await s('the job toast reads Done, and its Open opens the deck', async () => {
      const toast = await waitText(page, '[data-testid=toast-stack]', /The Auth Migration deck.*Done/i, 30000)
        .catch(() => { throw new StepFailure('no Done job toast for the deck'); });
      check(/Sprint 9 — OIDC core/.test(toast), `the toast does not name the sprint: "${toast}"`);
      await stopVoice(page);
      await page.getByTestId('job-toast-link').first().click();
      await page.waitForURL(/\/iq\/decks\//, { timeout: 20000 }).catch(() => { throw new StepFailure(`the toast's Open did not open the deck (still on ${page.url()})`); });
    });
    await assertDeck(s, page);
  },
};

async function assertDeck(s, page) {
  await s('the deck focuses Sprint 9 — OIDC core, its three stories done', async () => {
    await page.waitForURL(/\/iq\/decks\/[^/?#]+/, { timeout: 60000 });
    const t = await waitText(page, '[data-testid=initiative-deck-editor-deck-subtitle]', /Sprint 9/, 20000);
    check(/focus: Sprint 9 — OIDC core/.test(t), `the deck subtitle does not focus Sprint 9 — OIDC core: "${t}"`);
    const id = decodeURIComponent(page.url().match(/\/iq\/decks\/([^/?#]+)/)[1]);
    const deck = await page.context().request.get(`${PORTAL}/api/initiative-decks/${encodeURIComponent(id)}`);
    check(deck.status() === 200, `GET the deck answered ${deck.status()}`);
    const rev = (await deck.json()).activeRevisionId;
    const spec = await page.context().request.get(`${PORTAL}/api/initiative-decks/${encodeURIComponent(id)}/revisions/${encodeURIComponent(rev)}/spec`);
    check(spec.status() === 200, `GET the deck's spec answered ${spec.status()}`);
    const slides = (await spec.json()).slides ?? [];
    const sprints = slides.find((x) => x.id === 'sprints')?.bullets ?? [];
    const s9 = sprints.find((b) => b.startsWith('Sprint 9 — OIDC core'));
    check(s9 && /Done/.test(s9) && /3\/3 items · 16\/16 points/.test(s9), `the Sprints slide does not show Sprint 9 done with 3/3 items and 16/16 points: ${JSON.stringify(sprints)}`);
    // The three stories are the sprint's (seeded done); the deck counts them, it does not list them by name.
    const items = await page.context().request.get(`${PORTAL}/api/graph/projects/p-auth-migration/work`);
    const flat = []; const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.id && n.title) flat.push(n); for (const k of ['children', 'items']) if (n[k]) walk(n[k]); } };
    walk(await items.json());
    const done = flat.filter((w) => w.sprintId === 'spr-auth-s1' && w.status === 'done').map((w) => w.title);
    const missing = SPRINT9_STORIES.filter((title) => !done.includes(title));
    check(missing.length === 0 && done.length === 3, `Sprint 9's done stories are not the three the demo names: ${JSON.stringify(done)}`);
    return { sprintSlide: s9 };
  });
}

/** M4: tell #auth-migration the cutover order is decided. */
const M4 = {
  title: 'Tell #auth-migration the cutover order is decided', persona: 'vera',
  async hand(s, page) {
    await s("type the message in the initiative's own composer: its destination is #auth-migration", async () => {
      // One conversation per initiative: the composer's Discussion destination IS the bound channel.
      await go(page, INITIATIVE);
      const to = await waitText(page, '[data-testid=initiative-composer-recipient]', /#auth-migration|Initiative discussion/);
      check(/#auth-migration/.test(to), `the composer's destination is "${to}", not #auth-migration`);
      await page.locator('[data-testid=initiative-composer] [contenteditable=true]').first().click();
      await page.keyboard.type(MESSAGE);
      await page.keyboard.press('Enter');
      await waitText(page, '[data-testid=initiative-pane-discussion]', new RegExp(MESSAGE.replace(/[.;]/g, '.')), 15000);
    });
    await assertPosted(s, page);
  },
  async voice(s, page) {
    await s('voice: "Tell #auth-migration the cutover order is decided; rehearsal Thursday." then "Confirm."', async () => {
      await go(page, INITIATIVE);
      await startVoice(page, [
        { said: 'Tell #auth-migration the cutover order is decided; rehearsal Thursday.', call: { name: 'message', arguments: { target: { kind: 'channel', name: 'auth-migration' }, text: MESSAGE, thread: null, attach: null } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
      const out = await nthOutput(page, 1, 20000);
      const say = terseSay(out, 'message', 'Posted to #auth-migration.');
      await stopVoice(page);
      return { say: [say] };
    });
    await assertPosted(s, page);
  },
};

/** The Social bar's open goes to the initiative's bound channel, #auth-migration, in Communication. */
async function openBoundChannel(page) {
  await page.getByTestId('shell-social-open').click();
  await page.waitForURL(/\/iq\/communication\/channels\/auth-migration/, { timeout: 15000 });
  await waitText(page, '[data-testid=social-chat-panel-chat]', /Second rehearsal failed at the flip/);
}

async function assertPosted(s, page) {
  await s("the message is in #auth-migration after Nora's and Sienna's notes, with its receipt", async () => {
    if (!/\/iq\/communication\/channels\/auth-migration/.test(page.url())) await openBoundChannel(page);
    const t = await waitText(page, '[data-testid=social-chat-panel-chat]', new RegExp(MESSAGE.replace(/[.;]/g, '.')), 15000);
    const at = t.lastIndexOf(MESSAGE);
    check(at > t.indexOf('Second rehearsal failed at the flip'), "the message is not after Nora's rehearsal note");
    check(at > t.indexOf('I decide the order once the retry is clean'), "the message is not after Sienna's promise");
    check(await page.locator('[data-testid=social-chat-panel-chat] [data-testid=chat-message]').filter({ hasText: MESSAGE }).count() === 1, 'the message is not in the thread exactly once');
    const receipt = await waitText(page, '[data-testid=social-chat-panel-chat] [data-testid=chat-read-receipts]', /Sent|Read|Seen|Delivered/, 10000);
    return { receipt };
  });
}

/** M5: Nora sends the logout cookie bug to an agent, then asks who knows identity and access. */
const M5 = {
  title: 'Send the logout cookie bug to an agent; who knows identity and access?', persona: 'nora',
  async hand(s, page, run) {
    run.envelopeBefore = await envelopeSpent(page);
    run.runsBefore = await bugRuns(page);
    await s('open the logout bug on the Work tab and dispatch it from the composer', async () => {
      await go(page, `${INITIATIVE}?tab=work`);
      await page.getByText(BUG, { exact: true }).first().click();
      await page.waitForURL(/item=wi-auth-e2-b3/, { timeout: 15000 });
      await page.getByTestId('initiative-composer-prompts-option-dispatch').click();
      await waitText(page, '[data-testid=initiative-composer-prompts]', /Dispatch with these settings\?/);
      const sent = page.waitForResponse((r) => r.url().includes('/api/bots/dispatch-work'), { timeout: 15000 });
      await page.keyboard.press('Enter');
      const r = await sent;
      check(r.status() === 202, `POST /api/bots/dispatch-work answered ${r.status()}`);
    });
    await assertRun(s, page, run);
    await s('search: "Who knows identity and access?" on /iq/search, People', async () => {
      await go(page, '/iq/search');
      await page.getByTestId('search-rich-composer-input').click();
      await page.keyboard.type('Who knows identity and access?');
      await page.keyboard.press('Enter');
      await page.waitForURL(/q=/, { timeout: 10000 });
      await settle(page);
      // The People type, as the demo shows it.
      await page.getByText(/^People$/).first().click().catch(() => undefined);
      await settle(page);
      return { top: await assertIamPeople(page) };
    });
  },
  async voice(s, page, run) {
    run.envelopeBefore = await envelopeSpent(page);
    run.runsBefore = await bugRuns(page);
    await s('voice: "Send the logout cookie bug to an agent." then "Confirm."', async () => {
      await go(page, `${INITIATIVE}?tab=work&item=wi-auth-e2-b3`);
      await waitText(page, '[data-testid=explorer-layout-pane]', new RegExp(BUG));
      const sent = page.waitForResponse((r) => r.url().includes('/api/bots/dispatch-work'), { timeout: 30000 });
      await startVoice(page, [
        { said: 'Send the logout cookie bug to an agent.', call: { name: 'queue_work', arguments: { kind: 'dispatch', target: 'the logout cookie bug', note: null, model: null, rows: null, scope: 'this-page', focus: null } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
      const r = await sent;
      check(r.status() === 202, `POST /api/bots/dispatch-work answered ${r.status()}`);
      const out = await nthOutput(page, 1, 20000);
      return { say: [terseSay(out, 'queue_work dispatch', '"Logout leaves the legacy shim cookie alive": queued.')] };
    });
    await assertRun(s, page, run);
    await s('voice: "Who knows identity and access?"', async () => {
      await stopVoice(page);
      await startVoice(page, [
        { said: 'Who knows identity and access?', call: { name: 'search', arguments: { query: 'who knows identity and access', type: 'person', scope: null, sort: null, limit: null, answer: null, detail: null } } },
      ]);
      const out = await nthOutput(page, 1, 20000);
      const say = terseSay(out, 'search', '10 people, top: Priya Venkataraman; say "read them" for more.');
      const rows = (out.results ?? out.rows ?? []).map((r) => r.title ?? r.name);
      // The three rows the voice is handed are IAM people: the five, or Priya Venkataraman (Identity Governance Lead).
      const strangers = rows.filter((n) => ![...IAM_PEOPLE, 'Priya Venkataraman'].includes(n));
      check(rows.length === 3 && strangers.length === 0, `the voice result's rows are not the IAM people: ${JSON.stringify(rows)}`);
      // The full list: the page the result opened, else the same search the tool ran.
      let top;
      if (/\/iq\/search/.test(page.url())) top = await assertIamPeople(page);
      else {
        const r = await page.context().request.get(`${PORTAL}/api/search?q=${encodeURIComponent('who knows identity and access')}&type=person&limit=10`);
        const names = ((await r.json()).results ?? []).map((x) => x.title);
        const missing = IAM_PEOPLE.filter((n) => { const i = names.indexOf(n); return i < 0 || i >= IAM_TOP; });
        check(missing.length === 0, `not in the top ${IAM_TOP} people: ${missing.join(', ')} (got ${names.join(', ')})`);
        top = names.slice(0, IAM_TOP);
      }
      await stopVoice(page);
      return { say: [say], top };
    });
  },
};

async function bugRuns(page) {
  const r = await page.context().request.get(`${PORTAL}/api/bots/marketplace-runs?orgProjectId=p-auth-migration`);
  const j = await r.json();
  return (j.runs ?? j).filter((x) => x.workItemId === 'wi-auth-e2-b3');
}

async function envelopeSpent(page) {
  const r = await page.context().request.get(`${PORTAL}/api/sprints/envelopes`);
  const e = (await r.json()).envelopes?.find((x) => x.orgProjectId === 'p-auth-migration');
  return e ? { spent: e.spentUsd, remaining: e.remainingUsd, sprint: e.sprintName } : null;
}

async function assertRun(s, page, run) {
  await s('the run appears on the work item and finishes', async () => {
    // By hand the composer's job card follows it; by voice the dock's job toast does.
    if (run.mode === 'hand') await waitText(page, '[data-testid=initiative-composer-prompts]', /Agent working|Result ready|Finished/, 20000);
    else await waitText(page, '[data-testid=toast-stack]', new RegExp(`${BUG}.*(Queued|Running|Done)`), 20000);
    const end = Date.now() + 60000;
    let mine = [];
    while (Date.now() < end) {
      // The seed already holds one finished run of this bug (Vera's, three days ago): only the new one counts.
      mine = (await bugRuns(page)).filter((x) => !run.runsBefore.some((b) => b.id === x.id));
      if (mine.some((x) => x.status === 'done' && x.costUsd > 0)) break;
      await sleep(2000);
    }
    check(mine.length === 1, `expected one new run of the logout bug, found ${mine.length}`);
    check(mine[0].status === 'done', `the run is ${mine[0].status} after a minute`);
    if (run.mode === 'hand') await waitText(page, '[data-testid=initiative-composer-prompts]', /Result ready|Finished/, 15000);
    else await waitText(page, '[data-testid=toast-stack]', new RegExp(`${BUG}.*Done`), 15000);
    return { run: { status: mine[0].status, costUsd: mine[0].costUsd } };
  });
  await s("Nora's Sprint 10 envelope moves", async () => {
    const after = await envelopeSpent(page);
    check(run.envelopeBefore && after, 'no Auth Migration envelope for Nora');
    check(after.spent > run.envelopeBefore.spent, `the envelope did not move: $${run.envelopeBefore.spent} → $${after.spent}`);
    return { envelope: { sprint: after.sprint, before: run.envelopeBefore.spent, after: after.spent, remaining: after.remaining } };
  });
}

/** On /iq/search: the People results, the five in the top IAM_TOP. Returns the top names. */
async function assertIamPeople(page) {
  const r = await page.context().request.get(`${PORTAL}/api/search?q=${encodeURIComponent(new URL(page.url()).searchParams.get('q') ?? '')}&type=person&limit=10`);
  check(r.status() === 200, `GET /api/search answered ${r.status()}`);
  const names = ((await r.json()).results ?? []).map((x) => x.title);
  const shown = await text(page, 'main');
  const missing = IAM_PEOPLE.filter((n) => { const i = names.indexOf(n); return i < 0 || i >= IAM_TOP; });
  check(missing.length === 0, `not in the top ${IAM_TOP} people for "${new URL(page.url()).searchParams.get('q')}": ${missing.join(', ')} (got ${names.join(', ')})`);
  const notShown = IAM_PEOPLE.filter((n) => !shown.includes(n));
  check(notShown.length === 0, `the search page does not show: ${notShown.join(', ')}`);
  return names.slice(0, IAM_TOP);
}

const MOMENTS = { M1, M2, M3, M4, M5 };

// ── the run ──────────────────────────────────────────────────────────────────

async function runOne(browser, id, mode) {
  const m = MOMENTS[id];
  const run = { moment: id, title: m.title, mode, persona: PERSONAS[m.persona].userId, steps: [], ok: true, ms: 0 };
  const t0 = Date.now();
  await resetMock();
  const ctx = await signIn(browser, PERSONAS[m.persona]);
  await ctx.request.delete(`${PORTAL}/api/voice/mock-script`).catch(() => undefined);
  const page = await ctx.newPage();
  const rec = recorder(page);
  let n = 0;
  let stopped = false;
  const s = async (name, fn) => {
    if (stopped) { run.steps.push({ step: name, ok: false, skipped: true, ms: 0 }); return; }
    const mark = rec.mark();
    const start = Date.now();
    const row = { step: name, ok: true, ms: 0 };
    try {
      const info = await fn();
      if (info) Object.assign(row, info);
    } catch (e) {
      row.ok = false;
      row.error = String(e instanceof StepFailure ? e.message : e).slice(0, 600);
      run.ok = false;
      stopped = true;
    }
    row.ms = Date.now() - start;
    row.requests = rec.since(mark);
    if (rec.errors.length) row.pageErrors = rec.errors.splice(0);
    row.shot = path.join(OUT, 'shots', `${id}-${mode}-${String(++n).padStart(2, '0')}-${slug(name)}.png`);
    await page.screenshot({ path: row.shot }).catch(() => { row.shot = null; });
    run.steps.push(row);
    console.log(`  ${row.ok ? 'pass' : 'FAIL'} ${String(row.ms).padStart(6)} ms  ${name}${row.say ? `  say=${JSON.stringify(row.say)}` : ''}${row.error ? `\n         ${row.error}` : ''}`);
  };
  try {
    await m[mode](s, page, run);
  } catch (e) {
    run.ok = false;
    run.steps.push({ step: 'run', ok: false, error: String(e).slice(0, 600), ms: 0 });
  }
  run.ms = Date.now() - t0;
  delete run.envelopeBefore;
  delete run.runsBefore;
  await ctx.close();
  return run;
}

function markdown(runs) {
  const lines = ['| Moment | Mode | Result | Steps | Time (s) | Say lines |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of runs) {
    const says = r.steps.flatMap((x) => x.say ?? []).map((x) => `"${x}"`).join('<br>');
    lines.push(`| ${r.moment} ${r.title} | ${r.mode} | ${r.ok ? 'pass' : 'FAIL'} | ${r.steps.filter((x) => x.ok).length}/${r.steps.length} | ${(r.ms / 1000).toFixed(1)} | ${says} |`);
  }
  for (const r of runs.filter((x) => !x.ok)) {
    for (const st of r.steps.filter((x) => !x.ok && !x.skipped)) lines.push('', `- ${r.moment} ${r.mode}, "${st.step}": ${st.error}`);
  }
  return lines.join('\n') + '\n';
}

const unreachable = await reachable();
if (unreachable) { console.error(`not reachable: ${unreachable}`); process.exit(2); }
/**
 * The browser: CHROMIUM_PATH, else Playwright's own, else (Playwright's build of it not downloaded) the newest
 * headless shell or Chromium already in the browsers cache, so a machine with an older download still runs.
 */
function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try { if (fs.existsSync(chromium.executablePath())) return undefined; } catch { /* no expected build */ }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  const dirs = (() => { try { return fs.readdirSync(cache); } catch { return []; } })()
    .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-').pop()) - Number(a.split('-').pop()) || (a.includes('headless') ? -1 : 1));
  for (const d of dirs) {
    for (const sub of (() => { try { return fs.readdirSync(path.join(cache, d)); } catch { return []; } })()) {
      for (const exe of ['chrome-headless-shell', 'Chromium.app/Contents/MacOS/Chromium', 'chrome']) {
        const p = path.join(cache, d, sub, exe);
        if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
      }
    }
  }
  return undefined;
}
const executablePath = chromiumPath();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const runs = [];
try {
  for (const id of Object.keys(MOMENTS).filter((k) => ONLY.has(k))) {
    for (const mode of MODES) {
      console.log(`${id} ${mode}: ${MOMENTS[id].title}`);
      runs.push(await runOne(browser, id, mode));
    }
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ portal: PORTAL, middleware: MIDDLEWARE, at: new Date().toISOString(), runs }, null, 1));
fs.writeFileSync(path.join(OUT, 'results.md'), markdown(runs));
console.log(`\n${markdown(runs)}\nresults: ${path.join(OUT, 'results.json')}`);
process.exit(runs.every((r) => r.ok) ? 0 : 1);
