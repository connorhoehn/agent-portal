#!/usr/bin/env node
// The voice coverage journey (docs/voice-navigator-gaps.md, "Coverage (10 November)"): each capability the catalogue
// gained on 10 November, said hand-free on the scripted session (MOCK_VOICE=1, PUT /api/voice/mock-script) as the
// persona the Halyard story gives it, and proved end to end on the stack: the route the page's own button calls was
// hit, the page shows the change, and every result's `say` line is terse (one sentence, at most 25 words).
//
//   cd portal && npm run journey:voice-coverage [-- --only C1,C3 --out <dir>]
//   PORTAL_URL=http://localhost:5166 MIDDLEWARE_URL=http://127.0.0.1:3966 node scripts/journeys/voice-coverage.mjs
//
// Env and exit codes as scripts/journeys/demo-moments.mjs (0 every step passed, 1 a step failed, 2 unreachable).
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
const OUT = flag('--out') ?? process.env.OUT_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'voice-coverage-'));
const ONLY = new Set((flag('--only') ?? 'C1,C2,C3,C4,C5,C6,C7').split(',').map((s) => s.trim().toUpperCase()));
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });

const PERSONAS = {
  vera: { userId: 'u-vera', role: 'org-leader' }, nora: { userId: 'u-nora', role: 'sme' }, theo: { userId: 'u-theo', role: 'member' },
};
const P = 'p-auth-migration';
const INITIATIVE = `/iq/projects/${P}`;
const BUG = 'Logout leaves the legacy shim cookie alive';
const BUG_ID = 'wi-auth-e2-b3';
const MAX_SAY_WORDS = 25;

// ── plumbing (as demo-moments.mjs) ───────────────────────────────────────────

class StepFailure extends Error {}
const check = (cond, msg) => { if (!cond) throw new StepFailure(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

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

async function signIn(browser, who) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
  const login = await ctx.request.post(`${PORTAL}/api/session/login`, { data: { userId: who.userId } });
  if (login.status() !== 200) throw new Error(`login ${who.userId}: ${login.status()}`);
  const role = await ctx.request.post(`${PORTAL}/api/session/role`, { data: { tenant: 'orgiq', role: who.role } });
  if (role.status() !== 200) throw new Error(`role ${who.role}: ${role.status()}`);
  await ctx.addInitScript(() => {
    window.__voiceFrames = [];
    window.addEventListener('voice-mock-frame', (e) => window.__voiceFrames.push(e.detail));
  });
  return ctx;
}

function recorder(page) {
  const log = [];
  page.on('response', (r) => {
    const u = r.url();
    if (!u.includes('/api/')) return;
    log.push(`${r.request().method()} ${u.replace(PORTAL, '').replace(MIDDLEWARE, '')} ${r.status()}`);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  return { mark: () => log.length, since: (n) => log.slice(n), errors };
}

async function text(page, sel = 'body') {
  return page.evaluate((s) => (document.querySelector(s)?.innerText ?? '').replace(/\s+/g, ' ').trim(), sel);
}

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

async function go(page, p) {
  await page.goto(`${PORTAL}${p}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}

async function voiceOutputs(page) {
  const frames = await page.evaluate(() => window.__voiceFrames ?? []);
  return frames.filter((f) => f.dir === 'out' && f.event?.type === 'response.item.create' && f.event.item?.type === 'function_call_output')
    .map((f) => { try { return JSON.parse(f.event.item.output); } catch { return { raw: String(f.event.item.output) }; } });
}

async function nthOutput(page, n, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const outs = await voiceOutputs(page);
    if (outs.length >= n) return outs[n - 1];
    await sleep(200);
  }
  throw new StepFailure(`the voice result ${n} never came back in ${ms} ms`);
}

async function startVoice(page, turns) {
  const r = await page.context().request.put(`${PORTAL}/api/voice/mock-script`, { data: { turns } });
  check(r.status() === 204, `PUT /api/voice/mock-script answered ${r.status()} (is the middleware running with MOCK_VOICE=1?)`);
  await page.evaluate(() => { window.__voiceFrames = []; });
  await page.getByTestId('shell-voice-dock-start').click();
}

async function stopVoice(page) {
  const stop = page.getByTestId('shell-voice-dock-stop');
  if (await stop.count()) await stop.click().catch(() => undefined);
  await sleep(500);
}

/** The result's say line, asserted terse and (when given) matching; returned for the record. */
function terseSay(out, label, expected) {
  check(out && out.kind !== 'refused' && out.kind !== 'failed', `${label}: the voice result was ${out?.kind}: ${out?.reason ?? out?.raw ?? ''}`);
  const problem = sayProblem(out.say);
  check(!problem, `${label}: the say line is not terse (${problem}): ${JSON.stringify(out.say)}`);
  if (expected instanceof RegExp) check(expected.test(out.say), `${label}: the voice says ${JSON.stringify(out.say)}, expected ${expected}`);
  else if (expected) check(out.say === expected, `${label}: the voice says ${JSON.stringify(out.say)}, expected ${JSON.stringify(expected)}`);
  return out.say;
}

/** A refusal: the closed code and the `next` the model is told, never a figure. */
function refusal(out, label, code) {
  check(out && out.kind === 'refused', `${label}: expected a refusal, got ${out?.kind}`);
  if (code) check(out.code === code || out.reason?.length > 0, `${label}: refusal without code ${code}: ${JSON.stringify(out)}`);
  check(typeof out.next === 'string' && out.next.length > 20, `${label}: the refusal names no next step`);
  return out.reason;
}

const json = async (page, url) => {
  const r = await page.context().request.get(`${PORTAL}${url}`);
  check(r.status() === 200, `GET ${url} answered ${r.status()}`);
  return r.json();
};
const flat = (tree) => { const out = []; const walk = (n) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { if (n.id && n.title) out.push(n); if (n.children) walk(n.children); } }; walk(tree); return out; };
const workItem = async (page, id) => flat(await json(page, `/api/graph/projects/${P}/work`)).find((w) => w.id === id);
const NULLS = (keys) => Object.fromEntries(keys.map((k) => [k, null]));
const UPDATE_FIELDS = NULLS(['status', 'assignee', 'sprint', 'response', 'paused', 'reviewed', 'requeued', 'member', 'read', 'publish']);
const LIST = { kind: null, filter: null, scope: null, limit: null, detail: null };
const FILTER = { q: null, status: null, who: null, sprint: null, scope: null, since: null };
const CREATE_FIELDS = NULLS(['initiative', 'title', 'focus', 'type', 'on', 'text', 'name', 'query', 'startsOn', 'endsOn', 'description', 'privacy', 'item', 'justification', 'duration', 'time', 'thread', 'delegate', 'window', 'reason']);

/** A confirmed write: wait for the request the page's own button sends, then the say line. */
async function confirmed(page, n, urlPart, method, label, expected) {
  const sent = page.waitForResponse((r) => r.url().includes(urlPart) && r.request().method() === method, { timeout: 30000 });
  await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
  const r = await sent.catch(() => { throw new StepFailure(`${label}: no ${method} ${urlPart} after the spoken confirm`); });
  check(r.status() < 300, `${label}: ${method} ${urlPart} answered ${r.status()}`);
  return terseSay(await nthOutput(page, n, 20000), label, expected);
}

// ── the capabilities ─────────────────────────────────────────────────────────

/** C1: work items by voice on Auth Migration (Nora, the SME who works it). */
const C1 = {
  title: 'Work items by voice on an initiative', persona: 'nora',
  async run(s, page) {
    await s('voice: "What\'s left in this sprint?" reads the Work tab\'s own rows', async () => {
      await go(page, `${INITIATIVE}?tab=work`);
      await waitText(page, '[data-testid=explorer-layout-pane]', new RegExp(BUG));
      await startVoice(page, [
        { said: "What's left in this sprint?", call: { name: 'list', arguments: { ...LIST, kind: 'work-item', scope: 'this-page', filter: { ...FILTER, sprint: 'this', status: 'left' } } } },
        { said: 'Move the logout bug to in progress.', call: { name: 'update', arguments: { ref: 'the logout bug', fields: { ...UPDATE_FIELDS, status: 'in_progress' } } } },
        { said: 'Confirm.', on: 'card' },
        { said: 'Assign it to me.', call: { name: 'update', arguments: { ref: `work-item:${BUG_ID}`, fields: { ...UPDATE_FIELDS, assignee: 'me' } } } },
        { said: 'Confirm.', on: 'card' },
        { said: 'Take it out of the sprint.', call: { name: 'update', arguments: { ref: `work-item:${BUG_ID}`, fields: { ...UPDATE_FIELDS, sprint: 'none' } } } },
        { said: 'Confirm.', on: 'card' },
        { said: 'Put it back in this sprint.', call: { name: 'update', arguments: { ref: `work-item:${BUG_ID}`, fields: { ...UPDATE_FIELDS, sprint: 'this' } } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      const out = await nthOutput(page, 1);
      const say = terseSay(out, 'list this sprint', /^4 work items\b/);
      check(out.count === 4, `expected the 4 open items of Sprint 10, got ${out.count}`);
      return { say: [say] };
    });
    await s('"Move the logout bug to in progress." then "Confirm.": the drawer\'s PATCH', async () => {
      const say = await confirmed(page, 2, `/api/graph/work-items/${BUG_ID}`, 'PATCH', 'update status', `${BUG}: in progress.`);
      check((await workItem(page, BUG_ID)).status === 'in_progress', 'the bug is not in progress');
      return { say: [say] };
    });
    await s('"Assign it to me." then "Confirm.": the owner picker\'s PATCH, to Nora', async () => {
      const say = await confirmed(page, 3, `/api/graph/work-items/${BUG_ID}`, 'PATCH', 'update assignee', `${BUG}: assigned to Nora DaSilva.`);
      check((await workItem(page, BUG_ID)).assigneeName === 'Nora DaSilva', 'the bug is not Nora\'s');
      return { say: [say] };
    });
    await s('"Take it out of the sprint." then "Put it back in this sprint.": the sprint board\'s DELETE and PATCH', async () => {
      const out = await confirmed(page, 4, `/api/sprints/spr-auth-s2/items/${BUG_ID}`, 'DELETE', 'sprint out', `${BUG}: out of the sprint.`);
      const back = await confirmed(page, 5, '/api/sprints/spr-auth-s2/items', 'PATCH', 'sprint in', `${BUG}: in Sprint 10 — Session hygiene.`);
      check((await workItem(page, BUG_ID)).sprintId === 'spr-auth-s2', 'the bug is not back in Sprint 10');
      await stopVoice(page);
      return { say: [out, back] };
    });
    await s('voice: "Add a bug: logout skips the BFF revoke." on this initiative, then its brief and history', async () => {
      await go(page, `${INITIATIVE}?tab=work&item=${BUG_ID}`);
      await startVoice(page, [
        { said: 'Add a bug: logout skips the BFF revoke.', call: { name: 'create', arguments: { kind: 'work-item', fields: { ...CREATE_FIELDS, title: 'Logout skips the BFF revoke', type: 'bug', initiative: 'this-page' } } } },
        { said: 'Confirm.', on: 'card' },
        { said: "What's the brief on the logout bug?", call: { name: 'get', arguments: { ref: `work-item:${BUG_ID}`, part: 'brief', detail: null } } },
        { said: 'And its history?', call: { name: 'get', arguments: { ref: `work-item:${BUG_ID}`, part: 'history', detail: null } } },
      ]);
      const created = await confirmed(page, 1, '/api/graph/work-items', 'POST', 'create work item', 'Created the bug "Logout skips the BFF revoke" on Auth Migration.');
      check(flat(await json(page, `/api/graph/projects/${P}/work`)).some((w) => w.title === 'Logout skips the BFF revoke' && w.type === 'bug'), 'the bug is not on Auth Migration');
      const brief = terseSay(await nthOutput(page, 2), 'get brief', new RegExp(`^"${BUG}" is in progress, owned by Nora DaSilva`));
      const history = await nthOutput(page, 3);
      const histSay = terseSay(history, 'get history', /^\d+ histor/);
      check((history.rows ?? []).some((r) => /status changed from open to in progress/i.test(r.title ?? '')), `the history does not show the move: ${JSON.stringify(history.rows)}`);
      await stopVoice(page);
      return { say: [created, brief, histSay] };
    });
  },
};

const BUDGET = { scope: null, initiative: null, groupBy: null, period: null, sprint: null };
const usd = (v) => `$${Number(v).toFixed(2)}`;

/** C2: budgets and spend on Auth Migration, at the tier (Vera, the org leader who owns it). */
const C2 = {
  title: 'Budgets and spend at the tier', persona: 'vera',
  async run(s, page) {
    await s('voice: "How much is left on this initiative?" then "What did the agents spend this week?" then "And this sprint?"', async () => {
      await go(page, INITIATIVE);
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
      await startVoice(page, [
        { said: 'How much is left on this initiative?', call: { name: 'budget', arguments: { ...BUDGET, scope: 'initiative', initiative: 'this-page' } } },
        { said: 'What did the agents spend this week on Auth Migration?', call: { name: 'budget', arguments: { ...BUDGET, scope: 'initiative', initiative: 'Auth Migration', period: '7d' } } },
        { said: 'And how much is left in this sprint?', call: { name: 'budget', arguments: { ...BUDGET, scope: 'envelopes', initiative: 'this-page', sprint: 'this' } } },
      ]);
      const month = await json(page, `/api/spend/report?groupBy=actor&initiativeId=${P}`);
      const week = await json(page, `/api/spend/report?groupBy=actor&initiativeId=${P}&period=7d`);
      const allocated = month.initiative.allocation.effectiveAllocatedUsd;
      const left = month.initiative.reserve.discretionaryRemainingUsd;
      const a = terseSay(await nthOutput(page, 1), 'initiative left',
        `Auth Migration spent ${usd(month.initiative.allocation.spentUsd)} of its ${usd(allocated)} allocation this month; ${usd(left)} discretionary left.`);
      const b = terseSay(await nthOutput(page, 2), 'agents this week', new RegExp(`^Auth Migration spent \\${usd(week.totals.knownUsd)} in the last 7 days;`));
      const sprintEnv = month.initiative.envelopes.filter((e) => e.sprintId === 'spr-auth-s2');
      const sum = sprintEnv.reduce((x, e) => x + e.remainingUsd, 0);
      const c = terseSay(await nthOutput(page, 3), 'sprint envelopes', new RegExp(`^${sprintEnv.length} envelopes on Auth Migration, Sprint 10 — Session hygiene: \\${usd(sum)} left`));
      await stopVoice(page);
      return { say: [a, b, c] };
    });
  },
};

/** C2B: the same questions below the tier (Nora, an SME): refused with the access request, her own envelope said. */
const C2B = {
  title: 'Budgets below the tier', persona: 'nora',
  async run(s, page) {
    await s('voice: "How much is left on this initiative?" is refused with the access request; "my envelope" is said', async () => {
      await go(page, INITIATIVE);
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
      await startVoice(page, [
        { said: 'How much is left on this initiative?', call: { name: 'budget', arguments: { ...BUDGET, scope: 'initiative', initiative: 'this-page' } } },
        { said: "What's left on my envelope this sprint?", call: { name: 'budget', arguments: { ...BUDGET, scope: 'envelopes', initiative: 'this-page', sprint: 'this' } } },
      ]);
      const no = await nthOutput(page, 1);
      const reason = refusal(no, 'below the tier', 'role');
      check(no.code === 'role', `the refusal's code is ${no.code}, not role`);
      check(/access/i.test(no.next ?? ''), `the next step names no access request: ${no.next}`);
      check(!/\$\d/.test(JSON.stringify(no)), 'a figure leaked into the refusal');
      const mine = terseSay(await nthOutput(page, 2), 'own envelope', '1 envelope of yours on Auth Migration, Sprint 10 — Session hygiene: $15.00 left of $15.00.');
      await stopVoice(page);
      return { say: [reason, mine] };
    });
  },
};

const GET = { ref: null, part: null, detail: null };
const QUEUE = { kind: null, target: null, note: null, model: null, rows: null, scope: null, focus: null };

/** C3: runs and agents on Auth Migration (Nora, who may dispatch). */
const C3 = {
  title: 'Agent runs and a re-run', persona: 'nora',
  async run(s, page) {
    await s('voice: "What have the agents run on this initiative?", "On the logout bug?", "Tell me about that run."', async () => {
      await go(page, `${INITIATIVE}?tab=agents`);
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
      await startVoice(page, [
        { said: 'What have the agents run on this initiative?', call: { name: 'get', arguments: { ...GET, ref: `initiative:${P}`, part: 'runs' } } },
        { said: 'And on the logout bug?', call: { name: 'get', arguments: { ...GET, ref: `work-item:${BUG_ID}`, part: 'runs' } } },
        { said: 'Tell me about that run.', call: { name: 'get', arguments: { ...GET, ref: 'agent-run:run-mkt-auth-e2-b3' } } },
      ]);
      const runs = (await json(page, `/api/bots/initiative-runs?orgProjectId=${P}`)).runs;
      const all = await nthOutput(page, 1);
      const a = terseSay(all, 'initiative runs', new RegExp(`^${runs.length} agent runs on Auth Migration; latest `));
      check(all.rows.every((r) => /^agent-run:/.test(r.ref ?? '')), 'a run row carries no ref to read or open it by');
      const b = terseSay(await nthOutput(page, 2), 'work item runs', `1 agent run on "${BUG}"; latest done, $0.96: traced the logout path that leaves the legacy shim cookie alive.`);
      const c = terseSay(await nthOutput(page, 3), 'one run', `The run on "${BUG}" finished, $0.96: traced the logout path that leaves the legacy shim cookie alive.`);
      return { say: [a, b, c] };
    });
    await s('"Run it again." then "Confirm.": the drawer\'s dispatch of its work item', async () => {
      await stopVoice(page);
      await go(page, `${INITIATIVE}?tab=work&item=${BUG_ID}`);
      await waitText(page, '[data-testid=explorer-layout-pane]', new RegExp(BUG));
      const sent = page.waitForResponse((r) => r.url().includes('/api/bots/dispatch-work'), { timeout: 30000 });
      await startVoice(page, [
        { said: 'What has the agent run on the logout bug?', call: { name: 'get', arguments: { ...GET, ref: `work-item:${BUG_ID}`, part: 'runs' } } },
        { said: 'Run it again.', call: { name: 'queue_work', arguments: { ...QUEUE, kind: 'dispatch', target: 'agent-run:run-mkt-auth-e2-b3' } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      await nthOutput(page, 1);
      await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 })
        .catch(async () => { throw new StepFailure(`no card; the voice results: ${JSON.stringify((await voiceOutputs(page)).slice(1)).slice(0, 400)}`); });
      const card = await text(page, '[data-testid=voice-confirm-card]');
      check(card.includes(`Dispatch "${BUG}"`), `the card is not the drawer's dispatch: ${card.slice(0, 200)}`);
      const r = await sent;
      check(r.status() === 202, `POST /api/bots/dispatch-work answered ${r.status()}`);
      const say = terseSay(await nthOutput(page, 2, 20000), 'queue_work re-run', `"${BUG}": queued.`);
      await stopVoice(page);
      return { say: [say] };
    });
  },
};

/** C4: sprint questions on Auth Migration (Nora). */
const C4 = {
  title: 'Sprint questions', persona: 'nora',
  async run(s, page) {
    await s('voice: "What\'s left in this sprint, and what is blocked on what?", "What got done last sprint?", "What is blocked?"', async () => {
      await go(page, `${INITIATIVE}?tab=work`);
      await waitText(page, '[data-testid=explorer-layout-pane]', new RegExp(BUG));
      await startVoice(page, [
        { said: "What's left in this sprint, and what's blocked on what?", call: { name: 'summary', arguments: { kind: 'sprint', since: null } } },
        { said: 'What got done last sprint?', call: { name: 'list', arguments: { ...LIST, kind: 'work-item', filter: { ...FILTER, sprint: 'last', status: 'done' } } } },
        { said: 'What is blocked?', call: { name: 'list', arguments: { ...LIST, kind: 'work-item', filter: { ...FILTER, status: 'blocked' } } } },
      ]);
      const board = await json(page, '/api/graph/work?sprint=spr-auth-s2&limit=200');
      const left = board.filter((w) => w.status !== 'done' && w.status !== 'cancelled' && w.type !== 'epic');
      const a = terseSay(await nthOutput(page, 1), 'sprint summary',
        `Sprint 10 — Session hygiene: ${left.length} left, none done; 1 blocked, on "Cutover order for legacy SSO tenants".`);
      const lastBoard = (await json(page, '/api/graph/work?sprint=spr-auth-s1&limit=200')).filter((w) => w.status === 'done' && w.type !== 'epic');
      const doneOut = await nthOutput(page, 2);
      const b = terseSay(doneOut, 'last sprint done', new RegExp(`^${lastBoard.length} work items?\\b`));
      check(doneOut.count === lastBoard.length, `last sprint: ${doneOut.count} done, the board says ${lastBoard.length}`);
      const blockedOut = await nthOutput(page, 3);
      const c = terseSay(blockedOut, 'blocked', '1 blocked work item on Auth Migration: "Tenant-by-tenant cutover runbook with rollback" on "Cutover order for legacy SSO tenants".');
      check(/Cutover order for legacy SSO tenants/.test(blockedOut.rows?.[0]?.subtitle ?? ''), `the blocked row does not name its decision: ${JSON.stringify(blockedOut.rows?.[0])}`);
      await stopVoice(page);
      return { say: [a, b, c] };
    });
  },
};

/** C5: decisions (Vera, the org leader an escalated decision waits on). */
const C5 = {
  title: 'Decisions waiting and decided', persona: 'vera',
  async run(s, page) {
    await s('voice: "What is waiting on me?", "What did we decide about the lakehouse table format?", "Tell me about the cutover order."', async () => {
      await go(page, '/iq/decisions');
      await waitText(page, 'body', /Cutover order for legacy SSO tenants/);
      await startVoice(page, [
        { said: 'What decisions are waiting on me?', call: { name: 'list', arguments: { ...LIST, kind: 'decision', filter: { ...FILTER, who: 'me' } } } },
        { said: 'What did we decide about the lakehouse table format?', call: { name: 'list', arguments: { ...LIST, kind: 'decision', filter: { ...FILTER, q: 'lakehouse table format', status: 'decided' } } } },
        { said: 'Tell me about the cutover order decision.', call: { name: 'get', arguments: { ...GET, ref: 'decision:d-cognito-cutover' } } },
      ]);
      const all = await json(page, '/api/graph/decisions?limit=50');
      const waiting = all.filter((d) => d.status === 'open' || d.status === 'escalated').slice(0, 10);
      let mine = 0;
      for (const d of waiting) if ((await json(page, `/api/graph/decisions/${d.id}`)).viewerMayDecide === true) mine++;
      const out = await nthOutput(page, 1);
      const a = terseSay(out, 'waiting on me', new RegExp(`^${mine} decisions? waits? on you; first "`));
      check(out.count === mine, `waiting on Vera: ${out.count}, the decision pages say ${mine}`);
      const iceberg = all.find((d) => d.id === 'd-iceberg');
      const b = terseSay(await nthOutput(page, 2), 'decided about', new RegExp(`^"${iceberg.topic}" was decided: ${iceberg.outcome.split(' ').slice(0, 5).join(' ')}`));
      const c = terseSay(await nthOutput(page, 3), 'get decision', '"Cutover order for legacy SSO tenants" is escalated, waiting on Sienna Garcia; it holds 1 work item.');
      await stopVoice(page);
      return { say: [a, b, c] };
    });
  },
};

/**
 * C6: what needs review, the agent's question, and a spoken answer (Nora, who may answer an agent). Sweep 11 (M2):
 * the answer is click-only like every decide. The spoken "Confirm." sends nothing; the card shows the answer whole,
 * a mis-heard word is corrected in its note field, and the click sends the corrected answer.
 */
const C6 = {
  title: 'Review queue and an agent question answered on its card', persona: 'nora',
  async run(s, page) {
    await s('voice: "What needs my review?", "Read the agent\'s question.", "Answer: riskiest too first." then "Confirm." (nothing sent); correct and click', async () => {
      await go(page, '/iq/work');
      await waitText(page, 'body', /Which customer tenant goes first/);
      const consults = (await json(page, '/api/lab/consults?status=pending')).consults;
      const proposals = (await json(page, '/api/work/proposals?status=pending')).proposals;
      const id = consults[0].id;
      const answers = [];
      page.on('request', (r) => { if (r.url().includes(`/api/lab/consults/${id}/answer`) && r.method() === 'POST') answers.push(r.postDataJSON()); });
      await startVoice(page, [
        { said: 'What needs my review?', call: { name: 'summary', arguments: { kind: 'review', since: null } } },
        { said: "Read me the agent's question.", call: { name: 'get', arguments: { ...GET, ref: `consult:${id}` } } },
        // The model heard "too" for "two": the card is where the user catches it.
        { said: 'Tell it: riskiest too first, while the shim is warm.', call: { name: 'decide', arguments: { ref: `consult:${id}`, decision: 'approve', note: 'Riskiest too first, while the shim is warm.', option: null } } },
        { said: 'Confirm.', on: 'card' },
      ]);
      const review = await nthOutput(page, 1);
      const a = terseSay(review, 'review', new RegExp(`^\\d+ things? needs? you: ${consults.length} agent question${consults.length > 1 ? 's' : ''}, ${proposals.length} proposals`));
      const b = terseSay(await nthOutput(page, 2), 'agent question', `The agent asks: ${consults[0].question.match(/^.+?[.?!](?=\s|$)/)[0]}`);
      await page.getByTestId('voice-confirm-card').waitFor({ timeout: 15000 });
      const card = await text(page, '[data-testid=voice-confirm-card]');
      check(/Answer: Riskiest too first, while the shim is warm\./.test(card), `the card does not show the answer whole: ${card.slice(0, 200)}`);
      check(/click confirm/i.test(card), `the card does not ask for a click: ${card.slice(0, 200)}`);
      // The spoken "Confirm." is heard and sends nothing: the card stays open.
      const heard = Date.now() + 8000;
      while (Date.now() < heard) {
        const frames = await page.evaluate(() => window.__voiceFrames ?? []);
        if (frames.some((f) => f.dir === 'in' && f.event?.type === 'session.input_transcript.delta' && f.event.delta === 'Confirm.')) break;
        await sleep(200);
      }
      await sleep(1000);
      check(await page.getByTestId('voice-confirm-card').count() === 1, 'the card closed on the spoken confirm');
      check(answers.length === 0, 'the spoken confirm sent an answer to the agent');
      // The user corrects the mis-heard word on the card, then clicks.
      await page.getByTestId('voice-confirm-card-note').fill('Riskiest two first, while the shim is warm.');
      const sent = page.waitForResponse((r) => r.url().includes(`/api/lab/consults/${id}/answer`) && r.request().method() === 'POST', { timeout: 15000 });
      await page.getByTestId('voice-confirm-card-confirm').click();
      const r = await sent;
      check(r.status() < 300, `POST /api/lab/consults/${id}/answer answered ${r.status()}`);
      check(answers.length === 1 && answers[0].answer === 'Riskiest two first, while the shim is warm.', `the agent got ${JSON.stringify(answers)}`);
      const c = terseSay(await nthOutput(page, 3, 20000), 'answer', 'Answered the agent: "Riskiest two first, while the shim is warm."');
      const after = (await json(page, '/api/lab/consults?status=pending')).consults;
      check(!after.some((x) => x.id === id), 'the consult is still pending');
      await stopVoice(page);
      return { say: [a, b, c] };
    });
  },
};

/** C7: knowledge (Nora): a runbook found and its steps read, an ADR found and opened. */
const C7 = {
  title: 'Runbooks and ADRs', persona: 'nora',
  async run(s, page) {
    await s('voice: "Find the runbook for the tenant cutover.", "What are its steps?", "Open the ADR about the dependency map."', async () => {
      await go(page, INITIATIVE);
      await waitText(page, '[data-testid=initiative-header]', /Auth Migration/);
      await startVoice(page, [
        { said: 'Find the runbook for the tenant cutover.', call: { name: 'search', arguments: { ...SEARCH, query: 'tenant cutover', type: 'knowledge' } } },
        { said: 'What are its steps?', call: { name: 'get', arguments: { ...GET, ref: 'runbook:rb-tenant-cutover', part: 'steps' } } },
        { said: 'Find the ADR about the dependency map.', call: { name: 'search', arguments: { ...SEARCH, query: 'the ADR about the dependency map', type: 'knowledge' } } },
        { said: 'Open it.', call: { name: 'open', arguments: { ref: 'document:adr-d-aurora', page: null, kind: null, scope: null, tab: null } } },
      ]);
      const found = await nthOutput(page, 1);
      const a = terseSay(found, 'search runbook');
      check((found.rows ?? []).some((r) => r.ref === 'runbook:rb-tenant-cutover'), `the cutover runbook is not a runbook row: ${JSON.stringify((found.rows ?? []).map((r) => r.ref))}`);
      const rb = await json(page, '/api/runbooks/rb-tenant-cutover');
      const steps = rb.current.doc.steps;
      const b = terseSay(await nthOutput(page, 2), 'runbook steps', new RegExp(`^${steps.length} steps in "${rb.current.doc.title}"; 1: ${steps[0].do.split(' ').slice(0, 4).join(' ')}`));
      const adr = await nthOutput(page, 3);
      const c = terseSay(adr, 'search ADR');
      check(adr.rows?.[0]?.ref === 'document:adr-d-aurora', `the ADR is not the first row: ${JSON.stringify((adr.rows ?? []).map((r) => r.ref))}`);
      const opened = await nthOutput(page, 4);
      check(opened.kind !== 'refused', `open refused: ${opened.reason}`);
      await page.waitForURL(/\/iq\/documents\/adr-d-aurora/, { timeout: 15000 });
      await waitText(page, 'body', /Service dependency map in Postgres/);
      await stopVoice(page);
      return { say: [a, b, c] };
    });
  },
};

const CAPABILITIES = { C1, C2, C2B, C3, C4, C5, C6, C7 };

// ── the run ──────────────────────────────────────────────────────────────────

async function runOne(browser, id) {
  const m = CAPABILITIES[id];
  const run = { capability: id, title: m.title, persona: PERSONAS[m.persona].userId, steps: [], ok: true, ms: 0 };
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
    row.shot = path.join(OUT, 'shots', `${id}-${String(++n).padStart(2, '0')}-${slug(name)}.png`);
    await page.screenshot({ path: row.shot }).catch(() => { row.shot = null; });
    run.steps.push(row);
    console.log(`  ${row.ok ? 'pass' : 'FAIL'} ${String(row.ms).padStart(6)} ms  ${name}${row.say ? `  say=${JSON.stringify(row.say)}` : ''}${row.error ? `\n         ${row.error}` : ''}`);
  };
  try {
    await m.run(s, page, run);
  } catch (e) {
    run.ok = false;
    run.steps.push({ step: 'run', ok: false, error: String(e).slice(0, 600), ms: 0 });
  }
  run.ms = Date.now() - t0;
  await ctx.close();
  return run;
}

function markdown(runs) {
  const lines = ['| Capability | Persona | Result | Steps | Time (s) | Say lines |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of runs) {
    const says = r.steps.flatMap((x) => x.say ?? []).map((x) => `"${x}"`).join('<br>');
    lines.push(`| ${r.capability} ${r.title} | ${r.persona} | ${r.ok ? 'pass' : 'FAIL'} | ${r.steps.filter((x) => x.ok).length}/${r.steps.length} | ${(r.ms / 1000).toFixed(1)} | ${says} |`);
  }
  for (const r of runs.filter((x) => !x.ok)) {
    for (const st of r.steps.filter((x) => !x.ok && !x.skipped)) lines.push('', `- ${r.capability}, "${st.step}": ${st.error}`);
  }
  return lines.join('\n') + '\n';
}

const unreachable = await reachable();
if (unreachable) { console.error(`not reachable: ${unreachable}`); process.exit(2); }
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
  for (const id of Object.keys(CAPABILITIES).filter((k) => ONLY.has(k.replace(/(?<=\d)[A-Z]$/, '')))) {
    console.log(`${id}: ${CAPABILITIES[id].title}`);
    runs.push(await runOne(browser, id));
  }
} finally {
  await browser.close();
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ portal: PORTAL, middleware: MIDDLEWARE, at: new Date().toISOString(), runs }, null, 1));
fs.writeFileSync(path.join(OUT, 'results.md'), markdown(runs));
console.log(`\n${markdown(runs)}\nresults: ${path.join(OUT, 'results.json')}`);
process.exit(runs.every((r) => r.ok) ? 0 : 1);
