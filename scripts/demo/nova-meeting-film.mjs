#!/usr/bin/env node
// "Nova in the meeting": a demo film of the meeting assistant inside a call, recorded headless on the default mock world and
// edited with ffmpeg. One command records and composes:
//
//   node scripts/demo/nova-meeting-film.mjs --out <dir>
//
// It starts its own mock middleware (:3945) and portal (:5145), refuses ports already in use, signs three fictional people
// into one call on the Observability Platform initiative (the media server is stubbed exactly as
// scripts/journeys/meeting-assistant.mjs does), records each person's browser at 1440x900 with Playwright, and drives
// thirteen scenes at a viewer's pace. Every spoken line is synthesised with macOS `say` (one voice per person, one for
// Nova) before it is "heard": the line is handed to the mock transcript injector when the speech ends. It writes
// <dir>/timeline.json (scenes, shots, which views, speech and click times, each in wall-clock ms and in ms on each
// person's video), stops what it started, then runs scripts/demo/nova-film-compose.py to cut, caption and mix
// <dir>/nova-in-the-meeting.mp4. Nothing is injected into the product pages: captions, labels and click rings exist
// only in the edited video.
//
// Options: --record-only (no compose), --compose-only (reuse <dir>/timeline.json), --check (one frame per scene in <dir>/check), --max-minutes <n> (Nova's ceiling, so
// the "min left" mark shows by scene 11; default 14.5). Env: FILM_OUT may stand in for --out.
//
// What the mock world cannot say for itself: the scripted stand-in for the live model answers only fixed phrases
// (middleware/src/lib/meeting-assistant/scripted-session.ts). So the one spoken question with a free answer (scene 4)
// ends with the name ("..., Nova?"), which the detector treats as addressed with the request still to come; nothing
// follows, so the stand-in answers nothing, and the story's answer is posted through the mock-only assistant-message
// route, the same posting function the live session uses. Everything else is the product's own path: the budget read,
// the action cards, the named write, the decision watcher, voice, pause, extend, dismiss, minutes and delete.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = flag('--out') ?? process.env.FILM_OUT;
if (!OUT) { console.error('usage: nova-meeting-film.mjs --out <dir> [--record-only | --compose-only] [--max-minutes <n>]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const COMPOSE = path.join(ROOT, 'scripts', 'demo', 'nova-film-compose.py');

function compose() {
  const r = spawn('python3', [COMPOSE, '--out', OUT, ...(args.includes('--check') ? ['--check'] : [])], { stdio: 'inherit' });
  return new Promise((resolve) => r.on('exit', (c) => resolve(c ?? 1)));
}
if (args.includes('--compose-only')) process.exit(await compose());

const MW_PORT = 3945;
const PORTAL_PORT = 5145;
const PORTAL = `http://localhost:${PORTAL_PORT}`;
const MIDDLEWARE = `http://127.0.0.1:${MW_PORT}`;
const MAX_MINUTES = Number(flag('--max-minutes') ?? 14.5);
const INITIATIVE = '/iq/projects/p-observability';
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
const STAND_IN_SFU = 'http://meeting-assistant.test';

// ── The cast: fictional people of the mock world, each with a voice ──
const CAST = {
  vera: { userId: 'u-vera', role: 'org-leader', name: 'Vera Green', label: 'Vera Green · org leader', voice: 'Samantha' },
  nora: { userId: 'u-nora', role: 'sme', name: 'Nora DaSilva', label: 'Nora DaSilva · initiative owner', voice: 'Karen' },
  eli: { userId: 'u-eli', role: 'sme', name: 'Eli Garcia', label: 'Eli Garcia · subject expert', voice: 'Daniel' },
  layla: { userId: 'u-layla', role: 'sme', name: 'Layla Hassan', label: 'Layla Hassan · not in the call', voice: 'Tessa' },
  nova: { name: 'Nova', voice: 'Moira' },
};

// ── The story's words. The first line each person says becomes their sentence in the minutes' summary, so those come
// first and carry the topic. No "agreed", "let's go with", "I'll take" or "can you own" outside scenes 8 and 9 (the decision
// watcher's trigger), and "I'll" only where an action item is meant. ──
const SAY = {
  greet: ['vera', 'Thanks, both of you. I am bringing Nova in, so we get minutes out of this.'],
  s3a: ['vera', 'The ingest launch is on the twenty-first, and on-call is drowning in alerts.'],
  s3b: ['nora', 'Most of last week\'s pages came from two checks: disk space and deploy latency.'],
  s3c: ['eli', 'The deploy latency alert fires on every rollout, so people have learned to ignore it.'],
  s3d: ['vera', 'That is what worries me. A real page could get lost in that noise.'],
  s4q: ['vera', 'Before we change anything, how many of last week\'s pages were noise, Nova?'],
  s4r: ['nora', 'Two thirds. That matches what the night shift told me.'],
  s5q: ['nora', 'Nova, how much budget do I have left?'],
  s5r: ['nora', 'Good, there is room for the extra dashboards.'],
  s6q: ['vera', 'Nova, create a work item for raising the deploy latency alert threshold to five minutes.'],
  s7q: ['vera', 'Nova, create a work item for rewriting the paging runbook and assign it to Nora.'],
  s7r: ['nora', 'Happy to own that one.'],
  s8a: ['nora', 'Let\'s go with paging only on customer facing alerts until the launch.'],
  s8b: ['eli', 'Agreed. Everything else can wait for the morning review.'],
  s9a: ['vera', 'And let\'s go with muting the disk space alerts for all of launch week.'],
  s9b: ['nora', 'Sounds good to me.'],
  s9c: ['eli', 'I have to object to that one.'],
  s10q: ['vera', 'Nova, create a work item for a launch week on-call rota.'],
  s11a: ['eli', 'While it is paused: the vendor quote came in high, and I would rather keep that out of the minutes.'],
  s11b: ['eli', 'I\'ll draft the new paging thresholds by Thursday.'],
  s12a: ['vera', 'That is everything. Thanks, Nova.'],
};
const ANSWER_4 = 'Last week on-call got 64 pages. 41 of them were disk space or deploy latency alerts that cleared on their own within ten minutes.';
const OBJECTION_9 = 'Disk alerts caught the March outage. Mute them for a day, not a week.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class FilmFailure extends Error {}
const must = (cond, msg) => { if (!cond) throw new FilmFailure(msg); };

// ── Speech: every line synthesised once, before the recording starts, so its length paces the scene ──
const AUDIO = path.join(OUT, 'audio');
fs.mkdirSync(AUDIO, { recursive: true });
let clipNo = 0;
function synth(who, text) {
  clipNo += 1;
  const file = path.join(AUDIO, `${String(clipNo).padStart(3, '0')}-${who}.aiff`);
  execFileSync('say', ['-v', CAST[who].voice, '-r', '172', '-o', file, text]);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
  return { file: path.relative(OUT, file), durMs: Math.round(dur * 1000) };
}
const CLIPS = {};
for (const [id, [who, text]] of Object.entries(SAY)) CLIPS[id] = { who, text, ...synth(who, text) };

// ── The stack: its own mock middleware and portal, as scripts/journeys/run-demo-moments.mjs starts them ──
const answers = (port, host) => new Promise((resolve) => {
  const sock = net.connect({ port, host });
  sock.setTimeout(1000);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
});
const portFree = async (port) => !(await answers(port, '127.0.0.1')) && !(await answers(port, '::1'));
function devMockEnv() {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'middleware', 'package.json'), 'utf8')).scripts['dev:mock'];
  const env = {};
  for (const tok of script.split(/\s+/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(tok); if (!m) break; env[m[1]] = m[2]; }
  return env;
}
const started = [];
function start(name, cmd, argv, cwd, env, log) {
  const out = fs.openSync(log, 'w');
  const child = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], detached: true });
  started.push({ name, child });
}
function stopAll() { for (const { child } of started.splice(0)) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } } }
process.on('SIGINT', () => { stopAll(); process.exit(130); });
process.on('SIGTERM', () => { stopAll(); process.exit(143); });
async function waitUp(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* not yet */ } await sleep(1000); }
  return false;
}

for (const [port, what] of [[MW_PORT, 'middleware'], [PORTAL_PORT, 'portal']]) {
  if (!(await portFree(port))) { console.error(`port ${port} (${what}) is in use; nothing was started.`); process.exit(2); }
}
const WORK = path.join(OUT, 'work');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
start('middleware', process.execPath, [path.join(ROOT, 'middleware', 'node_modules', '.bin', 'tsx'), 'src/index.ts'], path.join(ROOT, 'middleware'), {
  ...devMockEnv(), PORT: String(MW_PORT), MOCK_VOICE: '1', VOICE_LOG_DIR: path.join(WORK, 'voice-log'), MOCK_PERSIST_PAIRINGS: '0',
  MEETING_ASSISTANT_ENABLED: 'true', MEETING_ASSISTANT_MAX_MINUTES: String(MAX_MINUTES),
}, path.join(WORK, 'middleware.log'));
start('portal', process.execPath, [path.join(ROOT, 'scripts', 'journeys', 'journey-vite.mjs'), '--port', String(PORTAL_PORT)], path.join(ROOT, 'portal'), {
  VITE_GATEWAY_URL: `http://localhost:${MW_PORT}`, API_PROXY_TARGET: `http://127.0.0.1:${MW_PORT}`,
}, path.join(WORK, 'portal.log'));
console.log(`film: middleware :${MW_PORT}, portal :${PORTAL_PORT}`);
if (!(await waitUp(`${MIDDLEWARE}/api/health`, 180_000) && await waitUp(`${PORTAL}/`, 180_000))) {
  console.error('film: the stack did not come up; see work/middleware.log and work/portal.log');
  stopAll();
  process.exit(2);
}

const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;

// ── The timeline the compose step reads ──
const timeline = { size: { width: 1440, height: 900 }, cast: {}, videos: {}, scenes: [], speech: [], clicks: [] };
for (const [k, c] of Object.entries(CAST)) timeline.cast[k] = { name: c.name, label: c.label ?? c.name, voice: c.voice };
let scene = null;
function beginScene(n, title, caption) { scene = { n, title, caption, shots: [] }; timeline.scenes.push(scene); console.log(`scene ${n}: ${title}`); }
/**
 * Ends the running shot (if any) and starts one with these views from now, or from `at` when the moment worth showing began
 * a little earlier than the script noticed it (the recordings run on, so a shot may start in the past after a skip).
 * `views`: [{ v: video id, crop?: name }].
 */
function cut(layout, views, { at } = {}) {
  const now = Date.now();
  const last = scene.shots.at(-1);
  if (last && last.to === null) last.to = now;
  const from = at !== undefined ? Math.max(at, last ? last.to : at) : now;
  scene.shots.push({ layout, views, from, to: null });
}
/** Ends the running shot without starting another: what follows until the next cut is left out of the film. */
function skip() { const last = scene.shots.at(-1); if (last && last.to === null) last.to = Date.now(); }
function endScene() { skip(); scene = null; }
/** A pause for the viewer: the state on screen stays this long. */
const hold = (ms = 3500) => sleep(ms);

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const RAW = path.join(OUT, 'raw');
fs.rmSync(RAW, { recursive: true, force: true });
let callId = null;
const pageErrors = [];

/** A signed-in person with their own recorded browser (one video per page, keyed `who` or `who-2`...). */
async function person(key, { call = true, video = key } = {}) {
  const who = CAST[key];
  const dir = path.join(RAW, video);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
  must(login.status() === 200, `login ${who.userId}: ${login.status()}`);
  const role = await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
  must(role.status() === 200, `role ${who.role}: ${role.status()}`);
  if (call) {
    await context.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [PRE_JOIN_KEY]);
    await context.route('**/api/session/realtime-token', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: STAND_IN_SFU, videoUrl: null } });
    });
    await context.route(`${STAND_IN_SFU}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who.userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'film-signalling-only' } });
    });
  }
  const page = await context.newPage();
  timeline.videos[video] = { who: key, startMs: Date.now(), file: null };
  page.on('pageerror', (e) => pageErrors.push(`${video}: ${e.message}`));
  page.on('request', (rq) => { const m = /\/api\/calls\/([^/]+)\/chat(?:\?|$)/.exec(new URL(rq.url()).pathname + new URL(rq.url()).search); if (m && !callId) callId = decodeURIComponent(m[1]); });
  const p = { key, who, video, context, page, api: context.request };
  p.videoPath = page.video()?.path();
  return p;
}

// ── Helpers shared with the walk's setup (no assertions beyond what the story needs to go on) ──
const waitFor = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new FilmFailure(`${what} never happened`); await sleep(300); }
};
const asApi = (rest) => `${PORTAL}/api/calls/${encodeURIComponent(callId)}/assistant/${rest}`;
const chatMessages = async (p) => (await (await p.api.get(`${PORTAL}/api/calls/${encodeURIComponent(callId)}/chat?limit=100`)).json()).messages ?? [];
const novaOf = async (p, kind) => (await chatMessages(p)).filter((m) => m.metadata?.kind === kind);
const stateOf = async (p) => (await (await p.api.get(asApi('state'))).json());
const proposalsOf = async (p) => (await (await p.api.get(asApi('proposals'))).json()).proposals ?? [];
const markText = async (p) => (await p.page.getByTestId('nova-mark').first().innerText().catch(() => '')).trim();
const waitMark = (p, re, ms = 20000) => waitFor(async () => re.test(await markText(p)), ms, `${p.key}'s mark reading ${re}`);
async function devPost(route, body) {
  const res = await fetch(`${MIDDLEWARE}/api/dev/calls/${encodeURIComponent(callId)}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  must(res.status < 300, `the dev route ${route} answered ${res.status}`);
  return res.json().catch(() => ({}));
}
const inject = (userId, text) => devPost('transcript-lines', { userId, text });

/** A person speaks: the speech starts now and lasts its clip; the line is "heard" (injected) when it ends. */
async function speak(p, id, { heard = true, after = 700 } = {}) {
  const c = CLIPS[id];
  must(c && c.who === p.key, `line ${id} is not ${p.key}'s`);
  timeline.speech.push({ who: p.key, text: c.text, file: c.file, atMs: Date.now(), durMs: c.durMs, heard });
  await sleep(c.durMs);
  if (heard) await inject(p.who.userId, c.text);
  await sleep(after);
}
/** Nova speaks aloud (only once its voice is on in the product): the clip starts when the words reach the chat. */
function novaSpeaks(text, atMs) {
  const c = synth('nova', text);
  timeline.speech.push({ who: 'nova', text, file: c.file, atMs, durMs: c.durMs, heard: false });
  return c.durMs;
}
/** Shows the viewer what is about to be clicked: scroll into view, hover, a ring in the edited video, then the click. */
async function press(p, locator, { lead = 1100, click = true } = {}) {
  const el = locator.first();
  await el.waitFor({ state: 'visible', timeout: 30000 });
  await el.scrollIntoViewIfNeeded().catch(() => undefined);
  await el.hover().catch(() => undefined);
  const box = await el.boundingBox();
  if (box) timeline.clicks.push({ video: p.video, atMs: Date.now(), leadMs: lead, box: [box.x, box.y, box.width, box.height].map(Math.round) });
  await sleep(lead);
  if (click) await el.click();
}
async function menu(p, item) {
  await press(p, p.page.getByTestId('nova-mark'), { lead: 800 });
  await press(p, p.page.getByRole('menuitem', { name: item }), { lead: 900 });
}
async function openChat(p) {
  if (await p.page.getByTestId('huddle-thread').isVisible().catch(() => false)) return;
  await press(p, p.page.getByTestId('shell-call-dock-chat'), { lead: 600 });
  await p.page.getByTestId('huddle-thread').waitFor({ timeout: 20000 });
}
const proposalCard = (p, id) => p.page.locator(`[data-testid="assistant-proposal-card"][data-proposal-id="${id}"]`).last();
const cardState = (p, id, state) => waitFor(async () => (await proposalCard(p, id).getAttribute('data-state')) === state, 25000, `${p.key}: the proposal card reading ${state}`);
const deckOf = (p) => p.page.getByTestId('nova-proposal-ask');
const deckButton = (p, re) => deckOf(p).getByRole('button', { name: re });
/** Scrolls the call chat to its newest message, as a person following the conversation would. */
async function scrollChatToEnd(p) {
  await p.page.evaluate(() => {
    const el = document.querySelector('[data-testid="huddle-thread"]');
    if (!el) return;
    const up = []; for (let n = el.parentElement, i = 0; n && i < 3; n = n.parentElement, i += 1) up.push(n);
    for (const n of [el, ...el.querySelectorAll('*'), ...up]) {
      if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)) n.scrollTop = n.scrollHeight;
    }
  }).catch(() => undefined);
}
/** While the call runs, every seated person keeps their chat at the newest message (a deck prompt opening shrinks the pane). */
const following = new Set();
const follower = setInterval(() => { for (const p of following) void scrollChatToEnd(p); }, 700);
/** Puts away a deck prompt the person does not answer now (its Hide control, else Esc inside it). */
async function hidePrompt(p) {
  const hide = p.page.getByRole('button', { name: /^Hide$/ }).first();
  if (await hide.isVisible().catch(() => false)) { await hide.click().catch(() => undefined); await sleep(600); return; }
  const deck = p.page.getByTestId('nova-proposal-ask');
  if (await deck.isVisible().catch(() => false)) { await deck.getByRole('button').first().focus().catch(() => undefined); await p.page.keyboard.press('Escape'); await sleep(600); }
}
async function shotPng(p, name) { await p.page.screenshot({ path: path.join(OUT, 'shots', `${name}-${p.video}.png`) }).catch(() => undefined); }
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const V = (v, crop) => (crop ? { v, crop } : { v });
let vera, nora, eli, layla;
let exitCode = 0;
try {
  const reset = await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
  must(reset.status === 200, `mock reset answered ${reset.status}`);

  // ── Before the film: everyone signed in, on the initiative page ──
  vera = await person('vera');
  nora = await person('nora');
  for (const p of [vera, nora]) {
    await p.page.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.page.getByTestId('initiative-header').waitFor({ timeout: 60000 });
  }
  const me = await (await vera.api.get(`${PORTAL}/api/session/me`)).json();
  must(me.meetingAssistant === true, 'the assistant is not advertised (MEETING_ASSISTANT_ENABLED)');
  await sleep(2500);

  // ── 1. The call ──
  beginScene(1, 'The call', 'Vera, Nora and Eli meet in a call on the Observability Platform initiative. Vera invites Nova from the call bar.');
  cut('full', [V('vera')]);
  await hold(2500);
  await press(vera, vera.page.getByTestId('initiative-start-call'));
  await nora.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30000 });
  await vera.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
  await nora.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
  await waitFor(async () => callId, 15000, 'the call id on the wire');
  skip();
  eli = await person('eli');
  await eli.page.goto(`${PORTAL}${INITIATIVE}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await eli.page.getByTestId('initiative-header').waitFor({ timeout: 60000 });
  await eli.page.getByTestId('shell-footer-context').getByRole('button', { name: 'Huddle' }).click({ timeout: 30000 });
  await eli.page.getByTestId('shell-call-dock').waitFor({ timeout: 30000 });
  await openChat(nora); await openChat(eli);
  following.add(nora); following.add(eli);
  await sleep(2000);
  cut('full', [V('vera')]);
  await openChat(vera);
  following.add(vera);
  await hold(1500);
  await speak(vera, 'greet', { heard: false, after: 500 });
  await press(vera, vera.page.getByTestId('nova-invite'));
  await waitMark(vera, /^Nova is listening/);
  await hold(3500);
  await shotPng(vera, 's01');
  endScene();

  // ── 2. Everyone is told ──
  beginScene(2, 'Everyone is told', 'Nora and Eli see the transcription notice. Nova cannot hear them until each of them acknowledges it.');
  await nora.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  await eli.page.getByTestId('nova-notice').waitFor({ timeout: 20000 });
  cut('rows2', [V('nora', 'bottom'), V('eli', 'bottom')]);
  await hold(4500);
  await press(nora, nora.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(nora, /^Nova is listening/);
  await hold(1200);
  await press(eli, eli.page.getByTestId('nova-notice-acknowledge'));
  await waitMark(eli, /^Nova is listening/);
  await hold(3000);
  endScene();

  // ── 3. Nova listens ──
  beginScene(3, 'Nova listens', 'The team talks. Nova keeps a transcript with each speaker\'s name (it shows on the meeting page afterwards) and stays quiet: nobody has asked it anything.');
  cut('full', [V('eli')]);
  await hold(1000);
  await speak(vera, 's3a');
  await speak(nora, 's3b');
  await speak(eli, 's3c');
  await speak(vera, 's3d', { after: 1500 });
  endScene();

  // ── 4. A question, answered in the call chat ──
  beginScene(4, 'Ask Nova', 'Vera asks Nova a question aloud. The answer appears in the call chat for everyone, labelled with who asked.');
  cut('split', [V('vera', 'chat-top'), V('nora', 'chat-top')]);
  await hold(800);
  await speak(vera, 's4q', { after: 0 });
  await sleep(1800);
  await devPost('assistant-messages', { kind: 'reply', text: ANSWER_4, askedBy: CAST.vera.userId, askedByName: CAST.vera.name });
  await waitFor(async () => /Asked by Vera/.test(await nora.page.getByTestId('huddle-thread').innerText()), 15000, 'the answer on Nora\'s screen');
  await hold(4500);
  await speak(nora, 's4r', { after: 2000 });
  await shotPng(nora, 's04');
  endScene();

  // ── 5. A private answer ──
  beginScene(5, 'Only for the asker', 'Nora asks about her own budget. Only Nora sees the answer; the others see that it was answered privately.');
  cut('full', [V('nora', 'chat-top')]);
  await hold(600);
  await speak(nora, 's5q', { after: 0 });
  await nora.page.getByText(/only you can see this/i).first().waitFor({ timeout: 30000 });
  await hold(800);
  await shotPng(nora, 's05');
  await hold(3400);
  await waitFor(async () => /Answered privately for Nora/.test(await vera.page.getByTestId('huddle-thread').innerText()), 15000, 'the fixed line on Vera\'s screen');
  cut('split', [V('nora', 'chat-top'), V('vera', 'chat-top')]);
  await hold(3500);
  await speak(nora, 's5r', { after: 1200 });
  endScene();

  // ── 6. An action only the asker confirms ──
  beginScene(6, 'An action card', 'Vera asks for a work item. Nova shows a card that only Vera can confirm; Nora sees it waiting, with no buttons.');
  cut('split', [V('vera', 'chat-mid'), V('nora', 'chat-mid')]);
  await hold(600);
  await speak(vera, 's6q', { after: 0 });
  const card6 = await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => /deploy latency/.test(m.metadata.summary ?? '')), 25000, 'the action card');
  const veraCard6 = vera.page.getByTestId('assistant-action-card').filter({ hasText: /deploy latency/ }).last();
  const noraCard6 = nora.page.getByTestId('assistant-action-card').filter({ hasText: /deploy latency/ }).last();
  await veraCard6.waitFor({ timeout: 20000 }); await noraCard6.waitFor({ timeout: 20000 });
  await hold(4500);
  await shotPng(vera, 's06a');
  await press(vera, veraCard6.getByTestId('assistant-action-confirm'));
  await waitFor(async () => (await novaOf(vera, 'assistant-action')).find((m) => m.metadata.actionId === card6.metadata.actionId && m.metadata.status === 'done'), 30000, 'the card going to done');
  await waitFor(async () => /Done/.test(await noraCard6.getByTestId('assistant-action-status').innerText()), 15000, 'Nora\'s card reading done');
  await hold(4000);
  await shotPng(vera, 's06b');
  endScene();

  // ── 7. A write that names someone else ──
  beginScene(7, 'A write that needs Nora', 'Vera asks for a work item assigned to Nora. It becomes a proposal that needs Nora\'s consent; once she gives it, Vera\'s browser runs it.');
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(600);
  await speak(vera, 's7q', { after: 0 });
  const p7 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'asked' && /paging runbook/i.test(p.statement)), 25000, 'the asked proposal');
  await proposalCard(nora, p7.id).waitFor({ timeout: 20000 });
  for (const p of [vera, nora]) await deckOf(p).filter({ hasText: /paging runbook/i }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
  await hold(4000);
  cut('full', [V('nora', 'lower')]);
  await hold(2500);
  await shotPng(nora, 's07a');
  await speak(nora, 's7r', { after: 300 });
  await press(nora, deckButton(nora, /^\s*1?\s*Consent\b/));
  await waitFor(async () => (await proposalsOf(nora)).find((p) => p.id === p7.id)?.responses?.length >= 1, 15000, 'Nora\'s consent');
  await hold(1200);
  cut('full', [V('vera', 'lower')]);
  await deckOf(vera).filter({ hasText: /paging runbook/i }).waitFor({ timeout: 20000 });
  await hold(2200);
  await shotPng(vera, 's07b');
  await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
  await cardState(vera, p7.id, 'done');
  await sleep(800);
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(4000);
  await shotPng(vera, 's07c');
  endScene();

  // ── 8. Nova notices a decision ──
  beginScene(8, 'A decision, noticed', 'Nobody asks Nova anything. When the team agrees, a silent proposal appears at the next pause, and each person is asked in their own prompt.');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await hold(600);
  await speak(nora, 's8a');
  await speak(eli, 's8b', { after: 2500 });
  // The watcher waits for six quiet seconds; most of that pause is cut, and the film picks up just before the card arrives.
  skip();
  const p8 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'watcher' && p.state === 'open'), 45000, 'the watcher\'s proposal');
  const p8At = Date.now();
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: p8At - 1500 });
  await proposalCard(vera, p8.id).waitFor({ timeout: 20000 });
  for (const p of [vera, nora, eli]) await deckOf(p).filter({ hasText: p8.statement }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await hold(3500);
  cut('rows3', [V('vera', 'deck'), V('nora', 'deck'), V('eli', 'deck')]);
  await hold(4000);
  await shotPng(vera, 's08a'); await shotPng(nora, 's08a'); await shotPng(eli, 's08a');
  await press(vera, deckButton(vera, /^\s*1?\s*Consent\b/));
  await waitFor(async () => (await proposalsOf(vera)).find((p) => p.id === p8.id)?.responses?.length >= 1, 15000, 'Vera\'s consent');
  await hold(1500);
  await press(nora, deckButton(nora, /Consent and record/));
  await cardState(nora, p8.id, 'done');
  await waitFor(async () => (await proposalCard(nora, p8.id).getByTestId('assistant-proposal-result-link').count()) > 0, 15000, 'the link to the decision');
  await sleep(800);
  cut('split', [V('vera', 'chat-end'), V('nora', 'chat-end')]);
  await hold(4000);
  cut('full', [V('nora')]);
  await press(nora, proposalCard(nora, p8.id).getByTestId('assistant-proposal-result-link'));
  await waitFor(async () => /Agreed in a call by/.test(await nora.page.locator('body').innerText()), 30000, 'the decision page saying "Agreed in a call by"');
  await nora.page.getByText(/Agreed in a call by/).first().scrollIntoViewIfNeeded().catch(() => undefined);
  await hold(5000);
  await shotPng(nora, 's08b');
  endScene();
  await nora.page.goBack({ waitUntil: 'domcontentloaded' });
  await nora.page.getByTestId('initiative-header').waitFor({ timeout: 30000 });
  await openChat(nora);

  // ── 9. An objection (the watcher posts at most one proposal in two minutes: wait out of frame) ──
  while (Date.now() - p8At < 2 * 60_000 + 3000) await sleep(1000);
  beginScene(9, 'An objection', 'A second proposal. Eli objects with a reason everyone in the call can see, and the proposal stops.');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')]);
  await hold(600);
  await speak(vera, 's9a');
  await speak(nora, 's9b', { after: 2500 });
  skip();
  const p9 = await waitFor(async () => (await proposalsOf(vera)).find((p) => p.source === 'watcher' && p.state === 'open' && p.id !== p8.id), 45000, 'the second proposal');
  cut('split', [V('vera', 'chat-end'), V('eli', 'chat-end')], { at: Date.now() - 1500 });
  await proposalCard(eli, p9.id).waitFor({ timeout: 20000 });
  for (const p of [vera, eli]) await deckOf(p).filter({ hasText: p9.statement }).waitFor({ timeout: 20000 });
  cut('split', [V('vera', 'chat-deck'), V('eli', 'chat-deck')]);
  await hold(3500);
  cut('full', [V('eli', 'lower')]);
  await hold(1500);
  await speak(eli, 's9c', { after: 300 });
  await press(eli, deckButton(eli, /Object/));
  const input = deckOf(eli).getByRole('textbox');
  await input.waitFor({ timeout: 10000 });
  await hold(1200);
  await input.pressSequentially(OBJECTION_9, { delay: 40 });
  await hold(1500);
  await shotPng(eli, 's09a');
  await input.press('Enter');
  for (const p of [vera, nora, eli]) await cardState(p, p9.id, 'objected');
  await sleep(800);
  cut('split', [V('vera', 'chat-deck'), V('nora', 'chat-deck')]);
  await hold(5000);
  await shotPng(nora, 's09b');
  endScene();
  // Nobody else answers the objected proposal: its deck prompt is put away for everyone (Esc), so the footer is quiet again.
  for (const p of [vera, nora, eli]) {
    if (await deckOf(p).isVisible().catch(() => false)) { await deckOf(p).getByRole('button').first().focus().catch(() => undefined); await p.page.keyboard.press('Escape'); }
  }
  await sleep(1000);

  // ── 10. Nova's voice ──
  beginScene(10, 'Nova\'s voice', 'Vera turns Nova\'s voice on for the call. Nora mutes it for herself; for everyone else, Nova now answers aloud.');
  cut('full', [V('vera', 'corner')]);
  await hold(1200);
  await menu(vera, "Turn Nova's voice on");
  await waitFor(async () => (await vera.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on');
  await hold(3000);
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice')) === 'true', 15000, 'voice on for Nora');
  cut('full', [V('nora', 'corner')]);
  await hold(800);
  await menu(nora, 'Mute Nova for me');
  await waitFor(async () => (await nora.page.getByTestId('nova-mark').first().getAttribute('data-voice-muted')) === 'true', 8000, 'Nora\'s mute');
  await hold(2500);
  await shotPng(nora, 's10a');
  cut('rows2', [V('vera', 'mark-chat'), V('nora', 'mark-chat')]);
  await hold(800);
  const repliesBefore = (await novaOf(vera, 'assistant-reply')).length;
  await speak(vera, 's10q', { after: 0 });
  const reply10 = await waitFor(async () => (await novaOf(vera, 'assistant-reply')).slice(repliesBefore).find((m) => /confirm/i.test(m.message)), 25000, 'Nova\'s spoken reply');
  const spoken = novaSpeaks(reply10.message, Date.now());
  await shotPng(vera, 's10b');
  await hold(Math.max(3500, spoken + 1200));
  const card10 = vera.page.getByTestId('assistant-action-card').filter({ hasText: /on-call rota/ }).last();
  await press(vera, card10.getByTestId('assistant-action-confirm'));
  await waitFor(async () => /Done/.test(await card10.getByTestId('assistant-action-status').innerText()), 30000, 'the rota card going to done');
  await hold(3000);
  endScene();

  // ── 11. Pause, resume, time left ──
  beginScene(11, 'Pause and time left', 'Anyone can pause Nova; nothing is heard or kept while it is paused. Near its time limit the mark shows the time left, and Vera extends it.');
  cut('full', [V('eli', 'corner')]);
  await hold(1000);
  await menu(eli, 'Pause Nova');
  await waitMark(eli, /^Nova is paused/); await waitMark(vera, /^Nova is paused/);
  await hold(2000);
  await speak(eli, 's11a', { after: 1200 });
  await shotPng(eli, 's11a');
  await menu(eli, 'Resume Nova');
  await waitMark(eli, /^Nova is listening/); await waitMark(vera, /^Nova is listening/);
  await hold(1000);
  await speak(eli, 's11b', { after: 1200 });
  const state11 = await stateOf(vera);
  console.log(`  scene 11 state: listening ${state11.listeningSeconds}s of ${state11.ceilingSeconds}s`);
  cut('full', [V('vera', 'corner')]);
  const left = await waitFor(async () => /min left/.test(await markText(vera)), 20000, 'the time-left mark').catch(() => null);
  if (!left) console.log('  WARN: the mark shows no time left; adjust --max-minutes');
  await hold(3000);
  await shotPng(vera, 's11b');
  await menu(vera, 'Extend time');
  await waitFor(async () => !/min left/.test(await markText(vera)), 15000, 'the extension').catch(() => console.log('  WARN: the mark still shows time left after the extension'));
  await hold(3500);
  endScene();

  // ── 12. The minutes ──
  beginScene(12, 'The minutes', 'Vera dismisses Nova. Nova leaves its minutes: a summary, the proposals, the action items, and the transcript by speaker.');
  cut('full', [V('vera')]);
  await hold(800);
  await speak(vera, 's12a', { after: 400 });
  await menu(vera, 'Dismiss Nova');
  await vera.page.getByTestId('nova-left').waitFor({ timeout: 20000 });
  const link = vera.page.getByTestId('assistant-notice-meeting-link').last();
  await link.waitFor({ state: 'visible', timeout: 30000 });
  await hold(4000);
  await shotPng(vera, 's12a');
  await press(vera, link);
  await vera.page.getByTestId('meeting-page').waitFor({ timeout: 30000 });
  await vera.page.getByTestId('meeting-summary').waitFor({ timeout: 30000 });
  // The objected proposal still asks Vera on this page; she puts the prompt away before reading (out of frame).
  skip();
  following.delete(vera);
  await sleep(1500);
  await hidePrompt(vera);
  cut('full', [V('vera', 'meeting')]);
  await hold(4500);
  await shotPng(vera, 's12b');
  for (const id of ['meeting-proposals', 'meeting-action-items']) {
    const el = vera.page.getByTestId(id).first();
    if (await el.count()) { await el.evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })); await hold(4000); }
  }
  await vera.page.getByText('By speaker').first().evaluate((n) => n.scrollIntoView({ behavior: 'smooth', block: 'start' })).catch(() => undefined);
  await hold(5000);
  await shotPng(vera, 's12c');
  await vera.page.mouse.move(500, 300);
  await vera.page.mouse.wheel(0, 300);
  await hold(3500);
  skip();
  await vera.page.goto(`${PORTAL}/iq/meetings`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await vera.page.getByTestId('iq-meetings-table').waitFor({ timeout: 30000 });
  await sleep(1200);
  cut('full', [V('vera')]);
  await hold(4000);
  await shotPng(vera, 's12d');
  endScene();

  // ── 13. Who can see it, and deleting it ──
  layla = await person('layla', { call: false });
  beginScene(13, 'Who can see it', 'Layla was not in the call, so the meeting is not there for her. Vera deletes the record, and Nova\'s messages in the call chat are blanked.');
  cut('full', [V('layla', 'notfound')]);
  await layla.page.goto(`${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await layla.page.getByTestId('meeting-not-found').waitFor({ timeout: 30000 });
  await hold(4500);
  await shotPng(layla, 's13a');
  await vera.page.goto(`${PORTAL}/iq/meetings/${encodeURIComponent(callId)}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await vera.page.getByTestId('meeting-delete').waitFor({ timeout: 30000 });
  await sleep(1500);
  await hidePrompt(vera);
  cut('full', [V('vera')]);
  await hold(1200);
  await press(vera, vera.page.getByTestId('meeting-delete'));
  const confirmDelete = vera.page.getByRole('button', { name: /Delete the record/ }).last();
  await confirmDelete.waitFor({ timeout: 15000 });
  await hold(3000);
  await shotPng(vera, 's13b');
  await press(vera, confirmDelete);
  await vera.page.waitForURL(/\/iq\/meetings$/, { timeout: 20000 });
  await hold(3000);
  await waitFor(async () => !/Answered privately|deploy latency/.test(await nora.page.getByTestId('huddle-thread').innerText()), 30000, 'Nova\'s words leaving Nora\'s chat');
  cut('full', [V('nora', 'chat-end')]);
  await hold(6000);
  await shotPng(nora, 's13c');
  endScene();

  // Leave the call before the browsers close, so the videos end on a quiet page.
  for (const p of [eli, nora, vera]) await p.page.getByTestId('call-dock-leave').first().click({ timeout: 5000 }).catch(() => undefined);
  await sleep(1500);
} catch (e) {
  exitCode = 1;
  console.error(`film: ${e instanceof FilmFailure ? e.message : e.stack}`);
  if (scene) { skip(); console.error(`  (in scene ${scene.n})`); }
} finally {
  clearInterval(follower);
  for (const p of [vera, nora, eli, layla].filter(Boolean)) {
    await p.context.close().catch(() => undefined);
    timeline.videos[p.video].file = p.videoPath ? path.relative(OUT, await p.videoPath) : null;
  }
  await browser.close().catch(() => undefined);
  stopAll();
}
if (pageErrors.length) console.log(`page errors: ${pageErrors.slice(0, 5).join(' | ')}`);
// Each shot's span on each video it shows, in ms from that video's first frame.
for (const s of timeline.scenes) for (const sh of s.shots) {
  sh.onVideo = Object.fromEntries(sh.views.map(({ v }) => [v, [sh.from - timeline.videos[v].startMs, sh.to - timeline.videos[v].startMs]]));
}
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2));
console.log(`film: timeline written (${timeline.scenes.length} scenes, ${timeline.speech.length} spoken clips)`);
if (exitCode || args.includes('--record-only')) process.exit(exitCode);
process.exit(await compose());
