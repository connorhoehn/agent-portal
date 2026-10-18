import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type BrowserContext, type Page } from '@playwright/test';
import { openAsClone } from './realSession';
import { CATALOG, serializeIntents, type Intent, type Surface } from './user-search-catalog';
// @ts-ignore a plain .mjs module shared with the judge (no types)
import { watchedDigest } from '../../scripts/user-search-freshness.mjs';
// @ts-ignore a plain .mjs module shared with the judge (no types)
import { mergeGroups } from '../../scripts/user-search-results.mjs';

// The user-search probe (docs/user-search-intents.md, docs/user-search-goal.md).
//
// For every intent in user-search-catalog.ts it signs in as a fresh dev:mock
// CLONE of the role's seed persona (openAsClone — never the persona itself, so
// nobody's session is revoked) inside its own mock scope, then types each
// phrasing into each entry point the catalog names — the /iq/search Results
// tab, the Answer tab (the orgiq read agent), the command palette, a list
// page's command composer, a list page's search box — and records what came
// back: rows/answer text, empty/error, latency, and whether the expected
// record was on screen (≤ 2 clicks away).
//
// Read-only: every non-GET request the page makes is refused with a 403 except
// the read agents' invoke endpoint (an ask, not a write). Sign-in and the clone
// itself go through realSession's API requests, which page routes do not see.
//
//   cd portal && npx playwright test e2e/user-search-probe.spec.ts --workers=4 --reporter=line
//   USER_SEARCH_ONLY=access (tenant), access:requester (persona) or a comma list narrows the run;
//   results merge into docs/user-search-probe-results.json by persona.
//   USER_SEARCH_BASE_URL points at an isolated portal backed by dev:mock. Social's
//   fixture catalog requires SOCIAL_PLATFORM_BACKEND=mock on that server; a mock
//   scope alone does not replace a live platform-api provider.
//
// Parallel by walker: each `tenant:role` group is its own test, its own clone and its own mock scope, so
// workers share nothing but the BFF. Every group saves through scripts/user-search-results.mjs, which holds
// a lock and replaces only the groups it names; the file's top-level digest is the one the whole catalog
// agrees on, so a partial re-probe never makes stale results look fresh.
//
// Hardened for the judge (scripts/validate-user-search.sh):
//   - clones only: a session whose subject is not `<persona>-clone-…` aborts the group (never a seed persona);
//   - one probe RUN at a time: a lock in the OS temp dir names the runner's pid (its workers share it) and
//     refuses a second concurrent run;
//   - the results carry `watchedDigest` (scripts/user-search-freshness.mjs — every search/answer/palette/composer
//     source file and the catalog) and the catalog's intents with their best surface, so the judge can tell
//     results of this tree from stale ones and grade "wrong on the best surface";
//   - `runs` keeps one line per run (time, git head, digest, the personas it re-probed).

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '..', process.env.USER_SEARCH_OUT ?? 'docs/user-search-probe-results.json');
const ONLY = (process.env.USER_SEARCH_ONLY ?? '').split(',').filter(Boolean);
const ALLOW_WRITE = [/^\/api\/agents\/orgiq-(supervisor|search|advisor)\/invoke$/];
// The dev:mock agent's keyword-routed replies (middleware/src/mock/responses.ts): whatever they
// happen to name, they were not computed from the question, so they never count as an answer.
const CANNED = /^\s*(\*\*Observability Platform\*\*|There are no Observability work items|Here is how to use \*\*Cut over the smallest tenant|Based on the knowledge graph analysis|I found relevant information about auth|Here's an overview of your organization|\*\*Influence Leaderboard\*\*)/;
const RANK = { supported: 3, partial: 2, wrong: 1, unsupported: 0 } as const;
type Verdict = keyof typeof RANK;

interface ProbeRow {
  intent: string; tenant: string; role: string; surface: Surface['kind']; route: string | null;
  phrasing: string; grammar: boolean; verdict: Verdict | 'evidence'; reason: string;
  latencyMs: number; clicks: number | null; handoff?: boolean; evidence: Record<string, unknown>;
}

const groups = new Map<string, Intent[]>();
for (const intent of CATALOG) {
  const key = `${intent.tenant}:${intent.role}`;
  if (ONLY.length && !ONLY.some((o) => key === o || intent.tenant === o)) continue;
  groups.set(key, [...(groups.get(key) ?? []), intent]);
}

// One probe RUN at a time (two would race the shared mock): the lock names the Playwright runner, which is the
// parent of every worker, so the workers of one run share it and a second run is refused.
const LOCK = join(tmpdir(), 'user-search-probe.lock');
function takeLock() {
  const owner = process.ppid;
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, 'utf8'));
    let alive = false; try { process.kill(pid, 0); alive = pid !== owner && pid !== process.pid; } catch { /* stale */ }
    if (alive) throw new Error(`another user-search probe is running (pid ${pid}); one probe run at a time`);
  }
  writeFileSync(LOCK, String(owner));
}
test.beforeAll(() => takeLock());
// The lock is left for the next run to find stale (its runner pid is gone): a worker that finishes early must not free it for a second run.

const run = {
  generatedAt: new Date().toISOString(),
  watchedDigest: watchedDigest() as string,
  baseURL: process.env.USER_SEARCH_BASE_URL ?? 'http://localhost:5183',
  gitHead: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim(); } catch { return null; } })(),
  personas: {} as Record<string, unknown>,
  probes: [] as ProbeRow[],
};

const CATALOG_KEYS = [...new Set(CATALOG.map((i) => `${i.tenant}:${i.role}`))];
const INTENTS = serializeIntents(CATALOG);
function save() {
  const groups: Record<string, { persona: unknown; probes: ProbeRow[] }> = {};
  for (const key of Object.keys(run.personas)) {
    groups[key] = { persona: run.personas[key], probes: run.probes.filter((p) => `${p.tenant}:${p.role}` === key) };
  }
  mergeGroups(OUT, { generatedAt: run.generatedAt, gitHead: run.gitHead, watchedDigest: run.watchedDigest, baseURL: run.baseURL, pid: process.pid }, groups, CATALOG_KEYS, INTENTS);
}

const clip = (s: string, n = 600) => (s.length > n ? `${s.slice(0, n)}…` : s);
const matchesAny = (text: string, res: RegExp[]) => res.some((r) => r.test(text));

// Pages poll (presence, bells), so networkidle rarely arrives: wait for the DOM, then a short beat.
async function settle(page: Page, ms = 400) {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function guard(context: BrowserContext, blocked: string[]) {
  await context.route('**/api/**', (route) => {
    const req = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
    const path = new URL(req.url()).pathname;
    if (ALLOW_WRITE.some((re) => re.test(path))) return route.continue();
    blocked.push(`${req.method()} ${path}`);
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by the read-only user-search probe' }) });
  });
}

// Client-side navigation: a full reload of the dev bundle costs seconds per probe on a loaded
// machine, so once the app is up the probe moves through history like a link click would.
async function go(page: Page, url: string) {
  const onApp = await page.evaluate(() => !!document.querySelector('main')).catch(() => false);
  if (!onApp) { await page.goto(url); return; }
  await page.evaluate((u) => { window.history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: (window.history.state?.idx ?? 0) + 1 }, '', u); window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state })); }, url);
}

// ── rows on a list page ──────────────────────────────────────────────────────
async function rowsOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const main = document.querySelector('main') ?? document.body;
    let rows = [...main.querySelectorAll('tbody tr')].filter(vis);
    if (!rows.length) rows = [...main.querySelectorAll('[role="row"]')].filter((e) => vis(e) && !e.querySelector('[role="columnheader"]'));
    if (!rows.length) rows = [...main.querySelectorAll('[role="listitem"], li')].filter(vis);
    return rows.slice(0, 60).map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim())
      .filter((t) => t && !/^(No |Nothing )[^.]{0,80}(match|found|yet|here|to show)/i.test(t));
  });
}
const mainText = (page: Page) => page.evaluate(() => ((document.querySelector('main') ?? document.body) as HTMLElement).innerText.replace(/\s+/g, ' ').trim().slice(0, 8000));

function gradeList(intent: Intent, before: string[], after: string[], text: string, urlChanged: boolean): { verdict: Verdict; reason: string; clicks: number | null } {
  const found = urlChanged ? matchesAny(text, intent.expected.text) : after.some((r) => matchesAny(r, intent.expected.text));
  const narrowed = urlChanged || after.length < before.length || before.length <= 3;
  if (urlChanged) return found ? { verdict: 'supported', reason: 'opened the expected record', clicks: 1 } : { verdict: 'wrong', reason: 'opened another page', clicks: null };
  if (found && narrowed) return { verdict: 'supported', reason: `expected row among ${after.length} (from ${before.length})`, clicks: 1 };
  if (found) return { verdict: 'partial', reason: `expected row visible but the query did not narrow (${after.length} rows)`, clicks: 1 };
  if (!after.length) return { verdict: 'unsupported', reason: 'no rows', clicks: null };
  return { verdict: 'wrong', reason: `${after.length} rows, none expected`, clicks: null };
}

// ── surfaces ─────────────────────────────────────────────────────────────────
async function probeSearch(page: Page, intent: Intent, q: string): Promise<Omit<ProbeRow, 'intent' | 'tenant' | 'role' | 'surface' | 'route' | 'phrasing' | 'grammar'>> {
  const t0 = Date.now();
  const response = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/search' && u.searchParams.get('q') === q; }, { timeout: 20_000 });
  await go(page, `/iq/search?${new URLSearchParams({ q, tab: 'results' })}`);
  const res = await response.catch(() => null);
  const latencyMs = Date.now() - t0;
  if (!res) return { verdict: 'unsupported', reason: 'no /api/search response', latencyMs, clicks: null, evidence: {} };
  if (res.status() !== 200) return { verdict: 'unsupported', reason: `/api/search ${res.status()}`, latencyMs, clicks: null, evidence: { status: res.status() } };
  const body = await res.json() as { results: Array<{ type: string; id: string; title: string; matchReason?: string }>; counts: Record<string, number> };
  await page.locator('[data-record-key]').first().waitFor({ timeout: 6_000 }).catch(() => undefined);
  const dom = [...new Set(await page.locator('[data-record-key]').evaluateAll((els) => els.map((e) => e.getAttribute('data-record-key') ?? '')))];
  const keys = body.results.map((r) => `${r.type}:${r.id}`);
  const top = body.results.slice(0, 8).map((r) => `${r.type}:${r.id} ${r.title} (${r.matchReason ?? ''})`);
  const evidence = { counts: body.counts, top };
  if (!keys.length) return { verdict: 'unsupported', reason: 'no results', latencyMs, clicks: null, evidence };
  let rank = -1;
  if (intent.expected.keys?.length) rank = keys.findIndex((k) => intent.expected.keys!.includes(k));
  else rank = body.results.findIndex((r) => matchesAny(r.title, intent.expected.text));
  const onScreen = rank >= 0 && dom.includes(keys[rank]!);
  if (rank >= 0 && rank < 3) return { verdict: 'supported', reason: `expected record at rank ${rank + 1}`, latencyMs, clicks: onScreen ? 1 : null, evidence };
  if (rank >= 0) return { verdict: 'partial', reason: `expected record at rank ${rank + 1} of ${keys.length}`, latencyMs, clicks: onScreen ? 1 : 2, evidence };
  return { verdict: 'wrong', reason: `${keys.length} results, none expected (top: ${body.results[0]!.title})`, latencyMs, clicks: null, evidence };
}

function parseSse(raw: string) {
  let text = '';
  const tools: string[] = [];
  let localIntent: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === 'TEXT_MESSAGE_CONTENT') text += ev.delta ?? '';
      if (ev.type === 'TOOL_CALL_START') tools.push(ev.toolCallName);
      if (ev.type === 'TOOL_CALL_RESULT' && typeof ev.content === 'string' && ev.content.includes('"intent"')) {
        try { localIntent = JSON.parse(ev.content).intent ?? localIntent; } catch { /* not JSON */ }
      }
      if (ev.type === 'RUN_ERROR') text += `\n[RUN_ERROR] ${ev.message ?? ''}`;
    } catch { /* keep-alive or partial line */ }
  }
  return { text, tools, localIntent };
}

async function probeAnswer(page: Page, intent: Intent, q: string) {
  const t0 = Date.now();
  await go(page, '/iq/search');
  const composer = page.getByTestId('search-composer');
  const box = composer.locator('[contenteditable="true"], textarea').first();
  await box.waitFor({ timeout: 15_000 });
  await box.click();
  await box.fill(q);
  const invoke = page.waitForResponse((r) => /\/api\/agents\/[^/]+\/invoke$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 60_000 }).catch(() => null);
  const sent = await composer.getByRole('button', { name: 'Send', exact: true }).click({ timeout: 20_000 }).then(() => true).catch(() => false);
  if (!sent) await box.press('Enter').catch(() => undefined);
  const res = await invoke;
  if (!res) return { verdict: 'unsupported' as Verdict, reason: 'no invoke response', latencyMs: Date.now() - t0, clicks: null, evidence: {} };
  const raw = await Promise.race([res.text().catch(() => ''), new Promise<string>((r) => setTimeout(() => r(''), 150_000))]);
  const latencyMs = Date.now() - t0;
  const parsed = parseSse(raw);
  const { tools, localIntent } = parsed;
  // the transcript as rendered, when the stream body was cut short
  const text = parsed.text.trim() ? parsed.text : await page.getByRole('log').innerText().catch(() => '');
  await page.waitForTimeout(500);
  const citations = await page.getByRole('log').locator('a').count().catch(() => 0);
  const source = tools.includes('local_answer') ? `local answer (${localIntent ?? '?'})` : tools.includes('query_graph') ? 'mock agent (keyword-routed canned reply)' : tools.length ? `agent tools: ${tools.join(',')}` : 'agent text only';
  const evidence = { status: res.status(), source, answer: clip(text, 700), citations };
  if (res.status() !== 200 || !text.trim()) return { verdict: 'unsupported' as Verdict, reason: `invoke ${res.status()}, empty answer`, latencyMs, clicks: null, evidence };
  if (/can.t answer that here|offline demo agent/i.test(text)) return { verdict: 'unsupported' as Verdict, reason: 'agent declined (no local answer, mock fall-through)', latencyMs, clicks: null, evidence };
  if (CANNED.test(text)) return { verdict: 'wrong' as Verdict, reason: `canned mock reply, not computed from the question (${source})`, latencyMs, clicks: null, evidence };
  if (intent.expected.wrong && matchesAny(text, intent.expected.wrong)) return { verdict: 'wrong' as Verdict, reason: `asserts a false/locked fact (${source})`, latencyMs, clicks: null, evidence };
  if (matchesAny(text, intent.expected.text)) return { verdict: 'supported' as Verdict, reason: `answer names the expected record (${source})`, latencyMs, clicks: citations ? 1 : null, evidence };
  return { verdict: 'wrong' as Verdict, reason: `answer misses the expected record (${source})`, latencyMs, clicks: null, evidence };
}

async function probePalette(page: Page, intent: Intent, q: string) {
  const t0 = Date.now();
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Control+k');
  const input = page.getByTestId('command-palette-input');
  if (!(await input.waitFor({ timeout: 5_000 }).then(() => true).catch(() => false))) {
    return { verdict: 'unsupported' as Verdict, reason: 'palette did not open', latencyMs: Date.now() - t0, clicks: null, evidence: {} };
  }
  await input.fill(q);
  await page.waitForTimeout(900);
  const options = await page.locator('[data-testid="command-palette"] [cmdk-item]').evaluateAll((els) => els
    .filter((e) => (e as HTMLElement).offsetParent !== null)
    .map((e) => ({ id: (e.getAttribute('data-testid') ?? e.getAttribute('data-value') ?? '').replace('command-palette-', ''), text: (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim() })));
  const latencyMs = Date.now() - t0;
  await page.keyboard.press('Escape');
  const shown = options.slice(0, 10).map((o) => `${o.id} | ${o.text}`);
  const evidence = { options: shown, total: options.length };
  if (!options.length) return { verdict: 'unsupported' as Verdict, reason: 'No results.', latencyMs, clicks: null, evidence };
  const isPage = (o: { id: string }) => /item-page:|^page:|recent-page:/.test(o.id) || /^item-page/.test(o.id);
  const record = options.find((o) => !isPage(o) && !/Search workspace/i.test(o.text) && matchesAny(o.text, intent.expected.text));
  if (record) return { verdict: 'supported' as Verdict, reason: `record option "${clip(record.text, 80)}"`, latencyMs, clicks: 1, evidence };
  const handoff = options.find((o) => /Search workspace/i.test(o.text));
  const pageHit = options.find((o) => isPage(o) && matchesAny(o.text, intent.expected.text));
  if (pageHit) return { verdict: 'partial' as Verdict, reason: `only a page option "${clip(pageHit.text, 60)}"`, latencyMs, clicks: 2, evidence };
  if (handoff) return { verdict: 'partial' as Verdict, reason: 'hand-off to /iq/search only', latencyMs, clicks: 2, evidence, handoff: true };
  return { verdict: 'wrong' as Verdict, reason: `${options.length} unrelated options (first: ${clip(options[0]!.text, 50)})`, latencyMs, clicks: null, evidence };
}

async function openList(page: Page, route: string) {
  await go(page, route);
  await page.locator('main tbody tr, main [role="row"], main li, [data-testid="collection-command-host"]').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.locator('main tbody tr, main [role="row"], main li').first().waitFor({ timeout: 6_000 }).catch(() => undefined);
  await settle(page, 700);
}

// One load per list surface: later phrasings reset the page in place (reset command / cleared box)
// and reload only when the reset did not bring the baseline rows back.
const listState = new WeakMap<Page, { key: string; baseline: string[] } | null>();
async function ensureList(page: Page, route: string, kind: string) {
  const key = `${kind}|${route}`;
  const cur = listState.get(page);
  if (cur?.key === key && new URL(page.url()).pathname === new URL(route, 'http://x').pathname) return cur;
  await openList(page, route);
  let baseline = await rowsOf(page);
  if (!baseline.length) { await page.waitForTimeout(3_000); baseline = await rowsOf(page); }
  const state = { key, baseline };
  listState.set(page, state);
  return state;
}
const dirty = (page: Page) => listState.set(page, null);

async function probeComposer(page: Page, intent: Intent, q: string, route: string) {
  const state = await ensureList(page, route, 'composer');
  const host = page.getByTestId('collection-command-host');
  const input = host.locator('[contenteditable="true"]').first();
  if (!(await input.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false))) {
    dirty(page);
    return { verdict: 'unsupported' as Verdict, reason: `no command composer on ${route}`, latencyMs: 0, clicks: null, evidence: {} };
  }
  const before = state.baseline;
  const url = page.url();
  const t0 = Date.now();
  await input.click();
  await input.fill(q);
  await input.press('Enter');
  // The command box answers in one of two voices: the page's own command result, or — when no command
  // recognises the phrase — the workspace's fixed-fact answer (data-testid collection-command-answer).
  const result = page.locator('[data-testid="collection-command-result"], [data-testid="collection-command-answer"]').first();
  await result.waitFor({ timeout: 5_000 }).catch(() => undefined);
  await settle(page, 700);
  const answered = (await page.getByTestId('collection-command-answer').count().catch(() => 0)) > 0;
  const feedback = (await result.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  const after = await rowsOf(page);
  const urlChanged = page.url() !== url;
  const latencyMs = Date.now() - t0;
  const text = await mainText(page);
  const evidence = { feedback: clip(feedback, 300), rowsBefore: before.length, rowsAfter: after.length, firstRows: after.slice(0, 4).map((r) => clip(r, 140)), url: urlChanged ? new URL(page.url()).pathname + new URL(page.url()).search : undefined };
  // put the page back for the next phrasing
  if (urlChanged) dirty(page);
  else {
    await input.fill('reset filters').catch(() => undefined);
    await input.press('Enter').catch(() => undefined);
    await settle(page, 500);
    if ((await rowsOf(page)).length !== before.length) dirty(page);
  }
  if (answered && !urlChanged) {
    // A fixed-fact answer is graded on what it says, like the Ask tab's: the expected fact, no false one.
    const said = { ...evidence, answered: true };
    if (intent.expected.wrong && matchesAny(feedback, intent.expected.wrong)) return { verdict: 'wrong' as Verdict, reason: 'the command box answered with a false fact', latencyMs, clicks: null, evidence: said };
    return matchesAny(feedback, intent.expected.text)
      ? { verdict: 'supported' as Verdict, reason: 'the command box answered with the expected fact', latencyMs, clicks: null, evidence: said }
      : { verdict: 'wrong' as Verdict, reason: 'the command box answered without the expected fact', latencyMs, clicks: null, evidence: said };
  }
  // A derived fact (a tally, an absence) the page's own command states in its result line is graded on what it says.
  if (intent.expected.derived && !urlChanged && !/not recognized|No changes were made/i.test(feedback) && matchesAny(feedback, intent.expected.text)) {
    return { verdict: 'supported' as Verdict, reason: 'the command box stated the expected derived fact', latencyMs, clicks: null, evidence: { ...evidence, stated: true } };
  }
  if (/not recognized|No changes were made/i.test(feedback) && !urlChanged) return { verdict: 'unsupported' as Verdict, reason: 'composer rejected the phrase', latencyMs, clicks: null, evidence };
  const graded = gradeList(intent, before, after, text, urlChanged);
  return { ...graded, latencyMs, evidence };
}

async function railRowsOf(page: Page, testId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const box = document.querySelector(`[data-testid="${id}"]`);
    const rail = box?.closest('aside, nav, [role="navigation"], [data-conversation-rail], section') ?? box?.parentElement?.parentElement?.parentElement;
    if (!rail) return [];
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...rail.querySelectorAll('a, [role="option"], [role="treeitem"], li button, [role="listitem"]')].filter(vis)
      .map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter((t) => t && t.length > 1);
  }, testId);
}

async function probeListSearch(page: Page, intent: Intent, q: string, surface: Surface) {
  const route = surface.route!, placeholder = surface.placeholder!;
  const state = await ensureList(page, route, 'list');
  let box = page.getByPlaceholder(placeholder, { exact: true }).first();
  let found = await box.waitFor({ timeout: surface.boxTestId ? 3_000 : 8_000 }).then(() => true).catch(() => false);
  if (!found && surface.boxTestId) {
    const host = page.getByTestId(surface.boxTestId).first();
    const inner = host.locator('input, textarea, [contenteditable="true"]').first();
    box = (await inner.count()) ? inner : host;
    found = await box.waitFor({ timeout: 8_000 }).then(() => true).catch(() => false);
  }
  if (!found) {
    dirty(page);
    return { verdict: 'unsupported' as Verdict, reason: `no "${placeholder}" box on ${route}`, latencyMs: 0, clicks: null, evidence: {} };
  }
  const read = () => (surface.railRows && surface.boxTestId ? railRowsOf(page, surface.boxTestId) : rowsOf(page));
  const before = surface.railRows ? await read() : state.baseline;
  const t0 = Date.now();
  await box.fill(q);
  await settle(page, 1_000);
  const after = await read();
  const latencyMs = Date.now() - t0;
  const evidence = { rowsBefore: before.length, rowsAfter: after.length, firstRows: after.slice(0, 4).map((r) => clip(r, 140)) };
  await box.fill('').catch(() => undefined);
  await settle(page, 500);
  if (!surface.railRows && (await rowsOf(page)).length !== before.length) dirty(page);
  const graded = gradeList(intent, before, after, after.join(' '), false);
  return { ...graded, latencyMs, evidence };
}

async function probeApi(page: Page, intent: Intent, q: string, path: string) {
  const t0 = Date.now();
  const res = await page.context().request.get(path.replace('{q}', encodeURIComponent(q)));
  const raw = await res.text();
  const found = matchesAny(raw, intent.expected.text);
  return { verdict: 'evidence' as const, reason: `${res.status()} ${found ? 'contains' : 'lacks'} the expected record`, latencyMs: Date.now() - t0, clicks: null, evidence: { status: res.status(), bytes: raw.length, found, sample: clip(raw, 300) } };
}

async function healthy(page: Page) {
  for (let i = 0; i < 30; i++) {
    const ok = await page.request.get('/api/health', { timeout: 5_000 }).then((r) => r.ok()).catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(3_000);
  }
  return false;
}
const INFRA = /no command composer|no ".*" box|no \/api\/search response|palette did not open|probe error|no invoke response|\/api\/search 5\d\d|invoke 5\d\d/;

// ── the run ──────────────────────────────────────────────────────────────────
test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });
test.describe.configure({ mode: 'parallel' });
test.afterAll(() => save());

for (const [key, intents] of groups) {
  test(`user-search probe: ${key}`, async ({ browser }) => {
    test.setTimeout(40 * 60_000);
    const [tenant, role] = key.split(':') as [string, string];
    const persona = intents[0]!.persona;
    const blocked: string[] = [];
    const statuses = new Map<string, number>();
    const drift: string[] = [];
    let person: Awaited<ReturnType<typeof openAsClone>> | null = null;
    const open = async () => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const p = await openAsClone(browser, persona, { baseURL: run.baseURL, tenant, role, label: 'user-search-probe', scope: { scenario: 'default', ttlMs: 3 * 60 * 60_000 }, viewport: { width: 1440, height: 900 }, prepare: (c) => guard(c, blocked) });
          p.page.on('response', (r) => {
            const u = new URL(r.url());
            if (u.pathname.startsWith('/api/') && r.status() >= 400) { const k = `${r.status()} ${u.pathname}`; statuses.set(k, (statuses.get(k) ?? 0) + 1); }
          });
          return p;
        } catch (error) {
          if (attempt === 4) throw error;
          await new Promise((r) => setTimeout(r, 65_000)); // the loopback login/switch throttle (routes/session.ts)
        }
      }
      throw new Error('unreachable');
    };
    person = await open();
    // Clones only: never probe as the seed persona (its session would be revoked by a switch, and it owns records a peer does not).
    if (!person.principal || !String(person.principal.sub).startsWith(`${persona}-clone-`)) throw new Error(`refusing to probe as ${person.principal?.sub ?? 'no principal'}: not a clone of ${persona}`);
    run.personas[key] = { cloneOf: persona, principal: person.principal && { sub: person.principal.sub, tenant: person.principal.tenant, role: person.principal.role } };
    try {
      if (tenant === 'social') {
        const response = await person.context.request.get('/api/social/rooms');
        const body = await response.json() as { source?: string };
        run.personas[key] = { ...(run.personas[key] as object), socialPlatformSource: body.source ?? null };
        if (!response.ok() || body.source !== 'mock') {
          throw new Error(`Social's seeded search catalog requires the mock platform provider; got HTTP ${response.status()} / ${body.source ?? 'unknown'}. Use USER_SEARCH_BASE_URL with an isolated SOCIAL_PLATFORM_BACKEND=mock server.`);
        }
      }
      for (const intent of intents) {
        // A clone's session can lapse mid-run (scope expiry, an epoch bump): check, record, re-open.
        await healthy(person.page);
        const me = await person.page.request.get('/api/session/me').then((r) => r.json()).catch(() => null) as { sub?: string; tenant?: string; role?: string } | null;
        if (!me || me.tenant !== tenant || me.role !== role || !String(me.sub).startsWith(`${persona}-clone`)) {
          drift.push(`before ${intent.id}: ${me ? `${me.sub} ${me.tenant}/${me.role}` : 'no session'}`);
          await person.close().catch(() => undefined);
          person = await open();
        }
        const page = person.page;
        listState.set(page, null);
        console.log(`[user-search] ${key} ${intent.id} (${new Date().toISOString().slice(11, 19)})`);
        for (const surface of intent.surfaces) {
          const natural = intent.phrasings.map((p) => ({ q: p, grammar: false }));
          const extra = surface.grammar ? [{ q: surface.grammar, grammar: true }] : surface.keyword ? [{ q: surface.keyword, grammar: true }] : [];
          const tries = surface.kind === 'api' ? natural.slice(0, 1) : [...natural, ...extra.filter((e) => !intent.phrasings.includes(e.q))];
          if (surface.kind === 'palette') { listState.set(page, null); await go(page, surface.route ?? '/'); await page.getByTestId('command-palette-hint').waitFor({ timeout: 10_000 }).catch(() => undefined); await settle(page, 800); }
          for (const { q, grammar } of tries) {
            const attempt = async () => {
              try {
                switch (surface.kind) {
                  case 'search': return await probeSearch(page, intent, q);
                  case 'answer': return await probeAnswer(page, intent, q);
                  case 'palette': return await probePalette(page, intent, q);
                  case 'composer': return await probeComposer(page, intent, q, surface.route!);
                  case 'list-search': return await probeListSearch(page, intent, q, surface);
                  case 'api': return await probeApi(page, intent, q, surface.path!);
                }
              } catch (error) {
                return { verdict: 'unsupported' as Verdict, reason: `probe error: ${clip(String(error instanceof Error ? error.message.split('\n')[0] : error), 160)}`, latencyMs: 0, clicks: null, evidence: {} };
              }
            };
            const bounded = () => Promise.race([attempt(), new Promise<Awaited<ReturnType<typeof attempt>>>((r) => setTimeout(() => r({ verdict: 'unsupported' as Verdict, reason: 'probe error: hung for 120s', latencyMs: 120_000, clicks: null, evidence: {} }), 120_000))]);
            let row = await bounded();
            // An infrastructure miss (BFF restarting, page not loaded) is retried once after a health wait and a reload.
            if (row && row.verdict === 'unsupported' && INFRA.test(row.reason)) {
              await healthy(page);
              listState.set(page, null);
              await page.goto(surface.kind === 'palette' ? (surface.route ?? '/') : (surface.route ?? '/iq/search')).catch(() => undefined);
              if (surface.kind === 'palette') { await page.getByTestId('command-palette-hint').waitFor({ timeout: 10_000 }).catch(() => undefined); }
              const second = await bounded();
              row = { ...second!, evidence: { ...second!.evidence, retried: row.reason } };
            }
            if (process.env.USER_SEARCH_VERBOSE) console.log(`  ${surface.kind} "${q}" → ${row!.verdict} (${row!.reason.slice(0, 60)})`);
            if (surface.kind === 'search' || surface.kind === 'answer') listState.set(page, null);
            run.probes.push({ intent: intent.id, tenant, role, surface: surface.kind, route: surface.route ?? (surface.kind === 'search' || surface.kind === 'answer' ? '/iq/search' : surface.path ?? null), phrasing: q, grammar, ...row! });
          }
        }
        save();
      }
    } finally {
      run.personas[key] = { ...(run.personas[key] as object), blocked: [...new Set(blocked)], errors: [...new Set(person.errors)].slice(0, 10), drift, httpErrors: Object.fromEntries(statuses) };
      save();
      await person.close();
    }
  });
}
