import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type BrowserContext, type Page } from '@playwright/test';
import { openAsClone } from './realSession';
import { PARAM_ROUTES, resolveParam, staticInventory, type Tenant } from './route-inventory';
import { scanRendered, type Hit } from '../../scripts/demo-content/rubric.mjs';

// The demo-content probe (docs/demo-content-goal.md, docs/demo-content-audit.md).
//
// Walks every main surface of every tenant as a fresh dev:mock CLONE of each
// role's seed persona (openAsClone — never the persona itself), screenshots it,
// extracts the visible text of <main>, and runs the mechanical half of the
// content rubric (scripts/demo-content/rubric.mjs) over it. The other half —
// does the story hang together — is a person reading the screenshots.
//
// Read-only: every non-GET request the page makes is refused with a 403. Sign-in
// and the clone go through realSession's API requests, which page routes never see.
//
//   cd portal && npx playwright test e2e/demo-content-probe.spec.ts --workers=4 --reporter=line
//   DEMO_PROBE_ONLY=social (tenant), social:moderator, or a comma list narrows the run (results merge by walker).
//   DEMO_PROBE_SHOTS=<dir> puts the PNGs elsewhere (default: $TMPDIR-ish scratch, never the repo).
//
// Output: one shard per walker under <shots>/captures/; then
//   node scripts/demo-content/merge-probe.mjs <shots>
// folds them into docs/demo-content/probe-index.json — one row per (persona,
// route): the screenshot's file name, the visible text (clipped) and the rubric
// hits. The PNGs stay out of the repo.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SHOTS = resolve(process.env.DEMO_PROBE_SHOTS ?? join(process.env.TMPDIR ?? '/tmp', 'demo-content'));
const ONLY = process.env.DEMO_PROBE_ONLY ?? '';
const TEXT_CLIP = 5000;

/** Distillation (and runbooks, its replacement) is being rebuilt separately (docs/distillation-runbooks-design.md): referenced, not walked. */
const SKIP = /^\/iq\/(distillation|runbooks)(\/|\?|$)/;

interface Walker { tenant: Tenant; role: string; persona: string; switchTenant?: boolean; routes: 'all' | 'admin' | string[] }

/** The orgiq roles other than the full walkers see these: the pages a peer clicks first. */
const ORGIQ_CORE = [
  '/iq', '/iq/projects?nav=section', '/iq/projects/p-auth-migration', '/iq/projects/p-auth-migration?item=wi-auth-e1-s1',
  '/iq/decisions/d-aurora', '/iq/work', '/iq/work/queue', '/iq/runs', '/iq/activity', '/iq/search', '/iq/scores',
  '/iq/designs', '/iq/library', '/iq/communication', '/settings',
];

export const WALKERS: Walker[] = [
  // Org: the org leader walks every /iq page, the platform admin every /admin page; the others the core.
  { tenant: 'orgiq', role: 'org-leader', persona: 'u-vera', routes: 'all' },
  { tenant: 'orgiq', role: 'admin', persona: 'u-operator', routes: 'admin' },
  { tenant: 'orgiq', role: 'program-owner', persona: 'u-mia', routes: [...ORGIQ_CORE, '/admin/budgets', '/admin/bots', '/iq/projects?lens=sprints'] },
  { tenant: 'orgiq', role: 'sme', persona: 'u-nora', routes: ORGIQ_CORE },
  { tenant: 'orgiq', role: 'member', persona: 'u-theo', routes: ORGIQ_CORE },
  { tenant: 'orgiq', role: 'hr-admin', persona: 'u-hr', routes: [...ORGIQ_CORE, '/iq/scores/cohorts', '/admin/budgets'] },
  // Every other tenant: each role walks every page of its tenant.
  { tenant: 'assessment', role: 'assessor', persona: 'u-asha', routes: 'all' },
  { tenant: 'assessment', role: 'lead-assessor', persona: 'u-jonas', routes: 'all' },
  { tenant: 'assessment', role: 'program-lead', persona: 'u-farah', routes: 'all' },
  { tenant: 'social', role: 'participant', persona: 'u-sana', routes: 'all' },
  { tenant: 'social', role: 'moderator', persona: 'u-lena', routes: 'all' },
  { tenant: 'social', role: 'community-admin', persona: 'u-mira', routes: 'all' },
  { tenant: 'pipelines', role: 'author', persona: 'u-ines', routes: 'all' },
  { tenant: 'pipelines', role: 'operator', persona: 'u-kofi', routes: 'all' },
  { tenant: 'pipelines', role: 'pipeline-admin', persona: 'u-dara', routes: 'all' },
  { tenant: 'access', role: 'requester', persona: 'u-rhea', routes: 'all' },
  { tenant: 'access', role: 'approver', persona: 'u-omar', routes: 'all' },
  { tenant: 'access', role: 'access-admin', persona: 'u-priya', routes: 'all' },
];

export interface Capture {
  tenant: string; role: string; persona: string; route: string; url: string; status: 'ok' | 'error' | 'gated';
  shot: string; title: string; words: number; rows: number; text: string; hits: Hit[]; blocked: string[]; error?: string;
}

const slug = (s: string) => s.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+$/, '') || 'root';

async function routesFor(w: Walker, page: Page): Promise<string[]> {
  const inv = staticInventory().filter((r) => r.tenant === w.tenant).map((r) => r.path);
  const params = await Promise.all(PARAM_ROUTES.filter((r) => r.tenant === w.tenant)
    .map((r) => resolveParam(r, async (u) => (await page.request.get(u)).json())));
  let all = [...inv, ...params];
  if (w.routes === 'admin') all = all.filter((p) => /^\/(admin|settings)/.test(p));
  else if (w.routes === 'all' && w.tenant === 'orgiq') all = all.filter((p) => !/^\/(admin|settings)/.test(p));
  else if (Array.isArray(w.routes)) all = w.routes;
  return [...new Set(all)].filter((p) => !SKIP.test(p));
}

/** Wait until <main> shows no loading text and its text stops changing for 1.5 s (polls and sockets keep the network busy forever), at most 20 s. */
async function settle(page: Page) {
  const deadline = Date.now() + 20_000;
  let last = '', stableSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForTimeout(300);
    const now = await page.evaluate(() => {
      const main = (document.querySelector('main') ?? document.body) as HTMLElement;
      const text = main.innerText;
      // Skeleton rows (a table of empty rows) are a page still loading, too.
      const skeleton = [...main.querySelectorAll('tbody tr')].filter((r) => !(r as HTMLElement).innerText.trim()).length > 3;
      const busy = skeleton || /\bLoading\b|loading…|Loading\.\.\./i.test(text) || main.querySelectorAll('[aria-busy="true"], [role="progressbar"]:not([aria-valuenow])').length > 0;
      // Digits folded: a ticking "3m ago" or a live counter is not the page still loading.
      return `${busy ? 'busy' : 'idle'}:${text.replace(/\d+/g, '#').length}`;
    }).catch(() => '');
    if (now !== last) { last = now; stableSince = Date.now(); } else if (Date.now() - stableSince >= 1_500 && now.startsWith('idle:') && !now.endsWith(':0')) return;
  }
}

async function guard(context: BrowserContext, blocked: string[]) {
  await context.route('**/api/**', (route) => {
    const req = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method())) return route.continue();
    blocked.push(`${req.method()} ${new URL(req.url()).pathname}`);
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'blocked by the read-only demo-content probe' }) });
  });
}

/** One shard per walker (workers run in parallel); scripts/demo-content/merge-probe.mjs folds them into OUT. */
function save(w: Walker, captures: Capture[]) {
  const dir = join(SHOTS, 'captures');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${w.tenant}-${w.role}.json`), JSON.stringify({
    generatedAt: new Date().toISOString(),
    gitHead: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; } })(),
    captures,
  }, null, 1) + '\n');
}

test.describe.configure({ mode: 'parallel' });

for (const w of WALKERS) {
  const key = `${w.tenant}:${w.role}`;
  if (ONLY && !ONLY.split(',').some((o) => o === key || o === w.tenant)) continue;
  test(`demo content · ${key} (${w.persona})`, async ({ browser }) => {
    test.setTimeout(30 * 60_000);
    const blocked: string[] = [];
    const captures: Capture[] = [];
    // The shared BFF restarts under `tsx watch` when another lane edits it: retry the clone a few times.
    const open = () => openAsClone(browser, w.persona, {
      label: 'demo-content-probe', viewport: { width: 1440, height: 900 }, preJoin: 'remembered',
      // A multi-role persona lands on its first grant (Vera lands as member): switch to the role walked.
      // The switch bumps only the clone's epoch.
      ...(w.persona === 'u-operator' && w.tenant !== 'orgiq' ? { tenant: w.tenant } : {}),
      role: w.role,
      prepare: (context) => guard(context, blocked),
    });
    const mint = async () => {
      for (let attempt = 1; ; attempt++) {
        try { return await open(); } catch (error) { if (attempt >= 4) throw error; await new Promise((r) => setTimeout(r, 10_000 * attempt)); }
      }
    };
    let person = await mint();
    const dir = join(SHOTS, `${w.tenant}-${w.role}`);
    mkdirSync(dir, { recursive: true });
    const capture = async (route: string, row: Capture) => {
      const { page } = person;
      await page.goto(route, { timeout: 30_000, waitUntil: 'domcontentloaded' });
      await settle(page);
      row.url = new URL(page.url()).pathname + new URL(page.url()).search;
      const got = await page.evaluate(() => {
        const main = (document.querySelector('main') ?? document.body) as HTMLElement;
        const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const rows = [...main.querySelectorAll('tbody tr, [role="row"], [role="listitem"], li')].filter(vis).length;
        const h1 = (main.querySelector('h1') as HTMLElement | null)?.innerText ?? document.title;
        return { text: main.innerText, rows, title: h1 };
      });
      const text = got.text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      row.title = got.title.trim();
      row.rows = got.rows;
      row.words = text.split(/\s+/).filter(Boolean).length;
      row.text = text.slice(0, TEXT_CLIP);
      row.hits = scanRendered(text);
      await page.screenshot({ path: join(SHOTS, row.shot), fullPage: true, timeout: 20_000 }).catch(() => page.screenshot({ path: join(SHOTS, row.shot) }));
    };
    /** The clone is gone (a BFF reload drops in-memory clones): the page asks to sign in or pick a workspace. */
    const lost = (row: Capture) => /^(Sign in again|Choose a workspace)$/.test(row.title) || /^\/(select|workspaces|login)\b/.test(row.url);
    try {
      for (const route of await routesFor(w, person.page)) {
        const fresh = (): Capture => ({ tenant: w.tenant, role: w.role, persona: w.persona, route, url: route, status: 'ok', shot: `${w.tenant}-${w.role}/${slug(route)}.png`, title: '', words: 0, rows: 0, text: '', hits: [], blocked: [] });
        let row = fresh();
        for (let attempt = 1; attempt <= 2; attempt++) {
          blocked.length = 0;
          row = fresh();
          try { await capture(route, row); } catch (error) { row.status = 'error'; row.error = String((error as Error).message ?? error).slice(0, 300); }
          // A blank <main> (the BFF or Vite mid-reload): try the page once more, then call it what it is.
          if (row.status === 'ok' && row.words < 5 && attempt === 1) { await new Promise((r) => setTimeout(r, 5_000)); continue; }
          if (row.status === 'ok' && row.words < 5) { row.status = 'error'; row.error = 'blank page twice'; break; }
          if (!lost(row)) break;
          // Twice sent to the workspace chooser with a fresh clone: the role cannot open this page (a gate, not a fault).
          if (attempt === 2) { row.status = 'gated'; row.error = undefined; break; }
          row.status = 'error'; row.error = 'the clone session was lost (BFF reload); re-minted';
          await person.close().catch(() => undefined);
          await new Promise((r) => setTimeout(r, 5_000));
          person = await mint();
        }
        row.blocked = [...new Set(blocked)];
        captures.push(row);
      }
    } finally {
      save(w, captures);
      await person.close();
    }
  });
}
