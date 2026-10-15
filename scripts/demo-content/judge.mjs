#!/usr/bin/env node
// The node half of scripts/validate-demo-content.sh (docs/demo-content-goal.md).
// Reads the probe's capture (docs/demo-content/probe-index.json) and the
// fixture sources; prints `ok|fail|note <text>` lines the shell judge formats.
//   node scripts/demo-content/judge.mjs <section>
// Sections: probe, rendered, pages, sources. (Cross-references and fixture prose
// run under the middleware's tsx: scripts/demo-content/{xref,prose}.mts.)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanRendered, scanSource, repeatedTemplates } from './rubric.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = path.join(ROOT, 'docs/demo-content/probe-index.json');
/** Distillation and its replacement, runbooks, are rebuilt separately (docs/distillation-runbooks-design.md): never judged here. */
const SKIP = /^\/iq\/(?:distillation|runbooks)(?:\/|\?|$)/;
const out = (kind, text) => console.log(`${kind}\t${text}`);
const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** The walkers the probe must have covered: every role of every tenant (portal/e2e/demo-content-probe.spec.ts WALKERS). */
export const WALKERS = {
  orgiq: ['org-leader', 'admin', 'program-owner', 'sme', 'member', 'hr-admin'],
  assessment: ['assessor', 'lead-assessor', 'program-lead'],
  social: ['participant', 'moderator', 'community-admin'],
  pipelines: ['author', 'operator', 'pipeline-admin'],
  access: ['requester', 'approver', 'access-admin'],
};

/**
 * The demo pages: the surfaces each tenant's five-minute story crosses
 * (docs/demo-content-audit.md § the stories), as the role that tells it. Each
 * must render at least `words` words of content AND no empty-state sentence,
 * as a CLONE of that role's persona — a demo must not depend on signing in as
 * the one seed user whose id the rows happen to be keyed by.
 */
export const DEMO_PAGES = [
  // Work — Mia's program view of Auth Migration and the decision it is waiting on.
  ['orgiq', 'program-owner', '/iq', 80], ['orgiq', 'program-owner', '/iq/projects?nav=section', 60],
  ['orgiq', 'program-owner', '/iq/projects/p-auth-migration', 120], ['orgiq', 'program-owner', '/iq/projects/p-auth-migration?item=wi-auth-e1-s1', 80],
  ['orgiq', 'program-owner', '/iq/decisions/d-aurora', 60], ['orgiq', 'program-owner', '/iq/work', 60], ['orgiq', 'program-owner', '/iq/runs', 60],
  ['orgiq', 'program-owner', '/admin/budgets', 60], ['orgiq', 'org-leader', '/iq/scores', 60], ['orgiq', 'org-leader', '/iq/search', 30],
  ['orgiq', 'admin', '/admin/observability/summary', 60], ['orgiq', 'admin', '/admin/bots', 60],
  // Assessment — Jonas reviews Northstar Payments.
  ['assessment', 'lead-assessor', '/assessment', 60], ['assessment', 'lead-assessor', '/assessment/teams', 60],
  ['assessment', 'lead-assessor', '/assessment/teams/TEAM-001', 120], ['assessment', 'lead-assessor', '/assessment/submissions', 40],
  ['assessment', 'lead-assessor', '/assessment/feedback', 40], ['assessment', 'lead-assessor', '/assessment/reports', 60],
  ['assessment', 'lead-assessor', '/assessment/runs', 40], ['assessment', 'program-lead', '/assessment/activity', 40],
  // Social — the community the other tenants talk in.
  ['social', 'participant', '/social', 40], ['social', 'participant', '/social/channels/general', 80], ['social', 'participant', '/social/dms', 30],
  ['social', 'community-admin', '/social/calls', 30], ['social', 'community-admin', '/social/recordings', 30], ['social', 'participant', '/social/teams', 20],
  ['social', 'participant', '/social/contacts', 40],
  // Pipelines — Kofi runs the queue Ines authored.
  ['pipelines', 'operator', '/pipelines', 40], ['pipelines', 'operator', '/pipelines/runs', 60], ['pipelines', 'operator', '/pipelines/approvals', 30],
  ['pipelines', 'author', '/pipelines/definitions', 60], ['pipelines', 'author', '/pipelines/runbooks', 40], ['pipelines', 'operator', '/pipelines/artifacts', 30],
  ['pipelines', 'pipeline-admin', '/pipelines/bots', 40],
  // Access — Rhea asks, Omar decides, Priya governs.
  ['access', 'requester', '/access/requests', 40], ['access', 'requester', '/access/requests/req-0001', 40], ['access', 'requester', '/access/catalog', 60],
  ['access', 'approver', '/access/approvals', 30], ['access', 'approver', '/access/requests/req-0001', 60],
  ['access', 'access-admin', '/access/reviews/rev-0001', 60], ['access', 'access-admin', '/access/audit', 60], ['access', 'access-admin', '/access/policies', 60],
];

/** Sentences that mean a page rendered nothing a peer can look at. */
const EMPTY = /\b(?:no [a-z ]{0,30}yet|nothing (?:here|to show|yet)|not found|you have not|there (?:is|are) no|0 of 0|no results|empty|could not (?:be )?load(?:ed)?|couldn't load|failed to load|unreachable|bad gateway|something went wrong)\b/i;

function readIndex() {
  if (!fs.existsSync(INDEX)) return null;
  return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
}

function probe() {
  const idx = readIndex();
  if (!idx) { out('fail', 'docs/demo-content/probe-index.json missing — run the probe (docs/demo-content-goal.md § Running)'); return; }
  out('ok', `probe index: ${idx.captures.length} captures at ${idx.generatedAt} (git ${idx.gitHead})`);
  const have = new Set(idx.captures.map((c) => `${c.tenant}:${c.role}`));
  const missing = Object.entries(WALKERS).flatMap(([t, rs]) => rs.map((r) => `${t}:${r}`)).filter((k) => !have.has(k));
  if (missing.length) out('fail', `walkers the probe did not cover: ${missing.join(', ')}`); else out('ok', 'every tenant × role walked as a clone');
  const errors = idx.captures.filter((c) => c.status === 'error');
  if (errors.length) out('fail', `${errors.length} captures errored (rerun those walkers): ${errors.slice(0, 4).map((c) => `${c.tenant}:${c.role} ${c.route}`).join('; ')}`);
  else out('ok', 'no capture errored');
  // Fresh: newer than the last commit touching what renders the content.
  let lastTouch = 0;
  try { lastTouch = Number(execFileSync('git', ['log', '-1', '--format=%ct', '--', 'middleware/src/mock', ':(exclude)middleware/src/mock/core', ':(exclude)middleware/src/mock/__tests__', ':(exclude)middleware/src/mock/distillation*', ':(exclude)middleware/src/mock/runbooks*', 'schema/seed_program.sql', 'schema/seeds', 'schema/seed.sql', 'scripts/dev/social-sim.mjs'], { cwd: ROOT, encoding: 'utf8' }).trim()) * 1000; } catch { /* no git */ }
  const at = Date.parse(idx.generatedAt);
  if (lastTouch && at < lastTouch) out('fail', `probe is older than the last commit to the fixtures or seeds (${new Date(lastTouch).toISOString()}) — rerun it`);
  else out('ok', 'probe is newer than the last commit to the fixtures and the seeds');
}

/** Rendered-text rules over every capture, grouped by rule. */
function rendered() {
  const idx = readIndex();
  if (!idx) { out('fail', 'no probe index'); return; }
  const by = new Map();
  for (const c of idx.captures.filter((x) => !SKIP.test(x.route))) {
    for (const h of scanRendered(c.text ?? '')) {
      const e = by.get(h.rule) ?? { letter: h.letter, pages: new Set(), n: 0, examples: [] };
      e.n++; e.pages.add(`${c.tenant}:${c.route}`);
      if (e.examples.length < 3 && !e.examples.some((x) => x.includes(h.match))) e.examples.push(`${c.route}: “${clip(h.context, 80)}”`);
      by.set(h.rule, e);
    }
    // Repeated lines on one page (a list of identical rows).
    const lines = (c.text ?? '').split('\n').map((l) => l.trim()).filter((l) => l.length >= 30 && (l.match(/[A-Za-z]{3,}/g) ?? []).length >= 4);
    for (const r of repeatedTemplates(lines, { minLen: 30, max: 5 })) {
      const e = by.get('repeated-line') ?? { letter: 'b', pages: new Set(), n: 0, examples: [] };
      e.n++; e.pages.add(`${c.tenant}:${c.route}`);
      if (e.examples.length < 3) e.examples.push(`${c.route}: ${r.n}× “${clip(r.example, 70)}”`);
      by.set('repeated-line', e);
    }
  }
  const RULES = [['filler', 'b', 'filler words and numbered stand-ins'], ['more-leak', 'b', '"(+N more)" leaks'], ['glued', 'b', 'glued sentences'], ['junk-literal', 'b', 'undefined / NaN / null on screen'],
    ['repeated-line', 'b', 'the same line repeated more than five times on a page'], ['raw-id', 'd', 'raw ids and slugs where a name belongs'], ['iso-time', 'd', 'ISO timestamps where a relative time belongs'],
    ['bad-number', 'c', 'impossible numbers (>100%, negative money or ages)'], ['dev-copy', 'g', 'developer copy on a customer page']];
  for (const [rule, letter, label] of RULES) {
    const e = by.get(rule);
    if (!e) { out('ok', `(${letter}) ${label}: none`); continue; }
    out('fail', `(${letter}) ${label}: ${e.n} on ${e.pages.size} pages`);
    for (const x of e.examples) out('note', x);
  }
}

function pages() {
  const idx = readIndex();
  if (!idx) { out('fail', 'no probe index'); return; }
  for (const [tenant, role, route, words] of DEMO_PAGES) {
    const c = idx.captures.find((x) => x.tenant === tenant && x.role === role && x.route === route);
    const label = `${tenant}/${role} ${route}`;
    if (!c) { out('fail', `${label}: not captured`); continue; }
    const empty = (c.text ?? '').match(EMPTY);
    if (c.status === 'gated') out('fail', `${label}: the role cannot open it (sent to the workspace chooser)`);
    else if (c.status !== 'ok') out('fail', `${label}: capture errored`);
    else if (c.words < words) out('fail', `${label}: ${c.words} words < ${words}${empty ? ` — “${empty[0]}”` : ''}`);
    else if (empty) out('fail', `${label}: says “${empty[0]}”`);
    else out('ok', `${label}: ${c.words} words`);
  }
}

/** Filler in fixture and seed source literals (only strings with a space: copy, not keys). */
function sources() {
  const files = [];
  const mock = path.join(ROOT, 'middleware/src/mock');
  for (const f of fs.readdirSync(mock)) if (f.endsWith('.ts') && !/^(?:distillation|runbooks)/.test(f)) files.push(path.join(mock, f));
  files.push(path.join(ROOT, 'schema/seed_program.sql'), path.join(ROOT, 'schema/seeds/generate_program_seed.py'));
  let n = 0; const ex = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const h of scanSource(fs.readFileSync(f, 'utf8'))) { n++; if (ex.length < 6) ex.push(`${path.relative(ROOT, f)}:${h.line} “${h.match}” in “${clip(h.text, 70)}”`); }
  }
  if (n) { out('fail', `(b) filler in fixture/seed copy: ${n}`); ex.forEach((e) => out('note', e)); } else out('ok', '(b) filler in fixture/seed copy: none');
}

const section = process.argv[2];
const SECTIONS = { probe, rendered, pages, sources };
if (!SECTIONS[section]) { console.error(`unknown section ${section} (${Object.keys(SECTIONS).join(', ')})`); process.exit(2); }
SECTIONS[section]();
