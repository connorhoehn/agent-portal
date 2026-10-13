#!/usr/bin/env node
// Journey-log freshness and sealing — the ONE implementation (docs/journeys.md).
// Every validator that judges journey logs sources scripts/lib/journeys.sh,
// which calls `judge` here; scripts/journeys/seal.sh calls `seal`.
//
// THE RULE. A walk proves what the walker saw on a route: its layout, its
// type, its rails, the behaviour its specs assert. So a log is stale when the
// RENDERED CONTRACT of a route it walked changed since it was sealed — not
// when a source file under the route was touched. A route's contract is
//   cascade     the layout-cascade invariants it breaks, and where it lands     (docs/journeys/contracts/cascade.json)
//   type-scale  its page title's size/weight and its off-scale sizes, plus the tenant's primary rail's (…/type-scale.json)
//   rail        the rail-frame verdicts measured on it or under it               (…/rail.json)
//   gate        App.tsx's RequireRole gate on its pattern, and whether it redirects
//   assertions  the normalised expect(…) statements of every spec that names it (route-inventory.ts specCoverage)
// measured by scripts/journeys/measure.sh over portal/e2e/route-inventory.ts.
// A log names its routes on its `url:` line (or, for an isolation/rail log
// with no url, anywhere in its fields but `notes:`). A log that names no
// inventoried route — a review, a stretch proof — keeps the old rule: the
// content digest of the files on its `pages:` line.
//
// Measurements are taken against a digest of portal/src + the dependency
// pins. When the source has moved since, the contracts are UNMEASURED and
// every judge says so in one line (run measure.sh) rather than guessing.
//
// THE HONESTY RULE. Only `seal` writes a seal, one directory per call, and it
// refuses a log that is not a complete passing walk, or that has not been
// written (log AND screenshot) since the contract it would seal last changed.
//
//   node scripts/journeys/journeys.mjs judge <family-dir> <log>...   # TSV: log, verdict, detail
//   node scripts/journeys/journeys.mjs seal <dir>                     # after a real walk
//   node scripts/journeys/journeys.mjs contract <log>                 # what a log's digest is made of
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const inv = await import(path.join(ROOT, 'portal/e2e/route-inventory.ts'));
const SEALS = '.contract-sha';
const SWEEPS = ['cascade', 'type-scale', 'rail'];

/** Fields an isolation log must carry instead of the surface fields (the access protocol's isolation format). */
const ISOLATION_FIELDS = {
  'docs/access-journeys': {
    // inbound: another tenant's role meets the access tenant
    inbound: ['^role: *\\S', '^user: *\\S', '^audited: *\\S', '^verdict: *pass', '^console errors: *\\S', '^direct-route-result: *\\S', '^api-status: *\\S', '^write-status: *\\S', '^nothing-written: *\\S'],
    // outbound: an access role meets each other tenant
    outbound: ['^role: *\\S', '^user: *\\S', '^audited: *\\S', '^verdict: *pass', '^console errors: *\\S', '^other-nav-visible: *\\S', '^iq-api-status: *\\S', '^assessment-api-status: *\\S', '^social-api-status: *\\S', '^pipelines-api-status: *\\S'],
  },
};
/** The fields a log must carry to be sealed, per family (each family's validator checks the same and more). */
const FAMILIES = {
  'docs/orgiq-journeys': ['^verdict: *pass', '^console errors: *0', '^layout: *pass', '^keyboard: *pass', '^empty-state: *(pass|n/a)', '^role-gating: *\\S'],
  'docs/assessment-journeys': ['^verdict: *pass'],
  'docs/branding-journeys': ['^verdict: *pass', '^console errors: *0', '^layers:', '^contrast:', '^brand: *#[0-9a-fA-F]{6}', '^rhythm:'],
  'docs/communication-journeys': ['^surface: *\\S', '^role: *\\S', '^user: *\\S', '^url: *\\S', '^audited: *\\S', '^verdict: *pass', '^console errors: *\\S', '^layout: *\\S', '^keyboard: *\\S', '^empty-state: *\\S', '^realtime: *\\S'],
  'docs/distillation-journeys': ['^verdict: *pass', '^console errors: *0', '^layout: *pass', '^keyboard: *pass', '^empty-state: *(pass|n/a)'],
  'docs/pipelines-journeys': ['^verdict: *pass'],
  'docs/access-journeys': ['^surface: *\\S', '^role: *\\S', '^user: *\\S', '^url: *\\S', '^verdict: *pass', '^console errors: *\\S', '^layout: *\\S', '^keyboard: *\\S', '^empty-state: *\\S', '^role-gating: *\\S'],
  'docs/search-journeys': ['^verdict: *pass', '^console errors: *0', '^layout: *pass', '^keyboard: *pass', '^empty-state: *(pass|n/a)'],
  // Social: a `limited` verdict with its reason is a complete, honest walk of a
  // surface this stack cannot fully show (the four recordings logs: platform-api
  // holds no recordings here). validate-social-tenant.sh's S2 check keeps them
  // visibly red; the seal only records that the walk happened on this contract.
  'docs/social-journeys': ['^verdict: *(pass|limited — \\S)'],
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v ?? null);
const rel = (p) => path.relative(ROOT, path.resolve(ROOT, p));
const field = (text, name) => (text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'mi')) ?? [])[1]?.trim() ?? '';

// ── Contracts ──────────────────────────────────────────────────────────────

let cache = null;
function contracts() {
  if (cache) return cache;
  const files = Object.fromEntries(SWEEPS.map((s) => {
    try { return [s, JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/journeys/contracts', `${s}.json`), 'utf8'))]; } catch { return [s, null]; }
  }));
  const source = inv.sourceDigest();
  const problems = SWEEPS.filter((s) => !files[s]).map((s) => `${s}: never measured`)
    .concat(SWEEPS.filter((s) => files[s] && files[s].measured.sourceDigest.startsWith('mixed')).map((s) => `${s}: the source moved during its measurement`))
    .concat(SWEEPS.filter((s) => files[s] && !files[s].measured.sourceDigest.startsWith('mixed') && files[s].measured.sourceDigest !== source).map((s) => `${s}: measured ${files[s].measured.at.slice(0, 16)} on an older source`));
  const coverage = inv.specCoverage();
  const assertionHash = new Map();
  const specHash = (f) => { if (!assertionHash.has(f)) assertionHash.set(f, sha(inv.specAssertions(f).join('\n')).slice(0, 16)); return assertionHash.get(f); };
  const app = inv.appRoutes();
  cache = { files, problems, coverage, specHash, app };
  return cache;
}

/** The routes a log walked: inventory keys, the URL pathnames they came from. */
function routesOf(text) {
  const urlLine = field(text, 'url');
  let urls = urlLine ? inv.urlsOf(urlLine) : [];
  if (!urls.length) urls = inv.urlsOf(text.split('\n').filter((l) => !/^notes:/i.test(l)).join('\n'));
  const out = new Map();
  for (const u of urls) {
    const key = inv.routeKey(u);
    if (!key) continue;
    const pathname = new URL(u.replace(/[…).,;]+$/, ''), 'http://x').pathname.replace(/\/+$/, '') || '/';
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(pathname);
  }
  return out;
}

/** One route's contract, as named parts (each part hashed separately so a judge can say WHAT changed). */
function routeParts(key, pathnames, user) {
  const c = contracts();
  const parts = {};
  const val = (sweep, k) => c.files[sweep]?.routes?.[k] ?? null;
  const cascade = val('cascade', key);
  const type = val('type-scale', key);
  parts[`cascade ${key}`] = cascade?.value ?? null;
  parts[`type-scale ${key}`] = type?.value ?? null;
  const tenant = inv.tenantOf(key);
  if (type) parts[`type-scale ${tenant} · primary rail`] = val('type-scale', `${tenant} · primary rail`)?.value ?? null;
  for (const s of inv.STATE_ROUTES) if (s.judged && user && s.user === user && pathnames.has(s.path)) parts[`type-scale ${s.key}`] = val('type-scale', s.key)?.value ?? null;
  for (const [k, r] of Object.entries(c.files.rail?.routes ?? {})) {
    // A pattern-keyed subject belongs to that route; a concrete one to the URL it is under.
    const p = new URL(k.replace(/:/g, '%3A'), 'http://x').pathname;
    if (k === key || (!k.includes(':') && [...pathnames].some((n) => p === n || p.startsWith(`${n}/`)))) parts[`rail ${k}`] = r.value;
  }
  const pathOnly = key.split('?')[0];
  const gate = c.app.find((a) => a.path === pathOnly) ?? null;
  parts[`gate ${key}`] = gate ? { roles: gate.roles, redirect: gate.forwards } : null;
  for (const f of c.coverage[key] ?? []) parts[`spec ${f}`] = c.specHash(f);
  // A wildcard or a redirect renders no page of its own: its contract is its gate.
  const gateOnly = /\*/.test(key) || !!gate?.forwards;
  return { parts, measured: !!(cascade || type), gateOnly };
}

/** When each part last changed (for the walk proof): a sweep's changedAt, a spec's or App.tsx's mtime. */
function partChangedAt(name) {
  const c = contracts();
  const [kind, ...rest] = name.split(' ');
  const key = rest.join(' ');
  if (kind === 'cascade' || kind === 'type-scale' || kind === 'rail') { const r = c.files[kind]?.routes?.[key]; return r ? Date.parse(r.changedAt) : 0; }
  if (kind === 'spec') return fs.statSync(path.join(ROOT, 'portal/e2e', key)).mtimeMs;
  if (kind === 'gate') return fs.statSync(path.join(ROOT, 'portal/src/App.tsx')).mtimeMs;
  if (kind === 'theme') return Math.max(...THEME_FILES.map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs));
  return 0;
}

function pagesDigest(pagesLine) {
  const items = pagesLine.split(',').map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  const h = crypto.createHash('sha256');
  for (const it of items) {
    const p = path.join(ROOT, it);
    if (!fs.existsSync(p)) return null;
    const files = fs.statSync(p).isDirectory()
      ? (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []); })(p).sort()
      : [p];
    if (!files.length) return null;
    for (const f of files) { h.update(path.relative(ROOT, f)); h.update('\0'); h.update(fs.readFileSync(f)); h.update('\0'); }
  }
  return h.digest('hex');
}

/** Branding's contract is its tokens, which no sweep measures yet: the theme files' digest is one more part of a branding log's contract. */
const THEME_FILES = ['portal/src/app.css', 'portal/src/components/shell/Layout.tsx'];
const themeDigest = () => sha(THEME_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\0'));

/** A walk carries a verdict line; a record without one (a code review, an agent ledger) is outside the freshness rule. */
function isWalk(file) { return /^verdict:/mi.test(fs.readFileSync(path.join(ROOT, file), 'utf8')); }

/** A log's contract: { basis, digest, parts, unswept[] } or { basis: 'none' } when it names nothing judgeable. */
export function logContract(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const routes = routesOf(text);
  const user = (field(text, 'user').match(/^u-[\w-]+|^demo-user/) ?? [])[0] ?? null;
  if (routes.size) {
    const parts = {}; const unswept = []; let swept = 0;
    if (familyOf(file) === 'docs/branding-journeys') parts['theme portal/src/app.css+Layout.tsx'] = themeDigest();
    for (const [key, pathnames] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
      const r = routeParts(key, pathnames, user);
      Object.assign(parts, r.parts);
      if (r.measured) swept++; else if (!r.gateOnly) unswept.push(key);
    }
    // A log is judged on what the sweeps measured; one that walked only routes
    // no sweep measures carries no rendered contract to judge (`unswept`).
    if (swept) unswept.length = 0;
    const hashed = Object.fromEntries(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sha(canonical(v)).slice(0, 16)]));
    return { basis: 'contract', digest: sha(canonical(hashed)), parts: hashed, routes: [...routes.keys()], unswept };
  }
  const pages = field(text, 'pages');
  const d = pages ? pagesDigest(pages) : null;
  return d ? { basis: 'pages', digest: d, parts: { [`pages ${pages}`]: d.slice(0, 16) }, routes: [], unswept: [] } : { basis: 'none' };
}

// ── Seal records ───────────────────────────────────────────────────────────

const familyOf = (p) => { const m = rel(p).match(/^(docs\/[^/]+-journeys)(\/|$)/); return m ? m[1] : null; };
function readSeals(fam) { try { return JSON.parse(fs.readFileSync(path.join(ROOT, fam, SEALS), 'utf8')); } catch { return {}; } }
function writeSeals(fam, seals) {
  const keys = Object.keys(seals).sort();
  fs.writeFileSync(path.join(ROOT, fam, SEALS), `{\n${keys.map((k, i) => ` ${JSON.stringify(k)}: ${JSON.stringify(seals[k])}${i < keys.length - 1 ? ',' : ''}`).join('\n')}\n}\n`);
}

// ── Commands ───────────────────────────────────────────────────────────────

function judge(fam, logs) {
  const c = contracts();
  const seals = readSeals(rel(fam));
  const out = [`MEASURED\t${c.problems.length ? 'unmeasured' : 'ok'}\t${c.problems.join('; ')}`];
  for (const log of logs) {
    const f = rel(log);
    const k = logContract(f);
    const s = seals[f];
    if (!isWalk(f)) { out.push(`${f}\trecord\tnot a route walk (no verdict: line) — a review/ledger record, outside the freshness rule`); continue; }
    if (k.basis === 'none') { out.push(`${f}\tunrouted\tnames no inventoried route and no pages: files`); continue; }
    if (k.unswept.length) { out.push(`${f}\tunswept\twalks ${k.unswept.join(', ')}, which no sweep measures — add it to portal/e2e/route-inventory.ts`); continue; }
    if (!s) { out.push(`${f}\tunsealed\t${k.basis}`); continue; }
    if (s.digest === k.digest) { out.push(`${f}\tfresh\t${k.basis}`); continue; }
    const moved = Object.keys({ ...s.parts, ...k.parts }).filter((p) => s.parts?.[p] !== k.parts[p]);
    out.push(`${f}\tstale\t${moved.slice(0, 3).join('; ')}${moved.length > 3 ? `; +${moved.length - 3}` : ''}`);
  }
  return out.join('\n');
}

function seal(dir) {
  const d = rel(dir);
  const fam = familyOf(d);
  if (!fam || !FAMILIES[fam]) return { ok: false, msg: `refusing: ${d} is not under a known docs/*-journeys family` };
  const c = contracts();
  if (c.problems.length) return { ok: false, msg: `refusing: the rendered contracts are not measured on the current source (${c.problems.join('; ')}) — run scripts/journeys/measure.sh, then seal` };
  const logs = fs.readdirSync(path.join(ROOT, d)).filter((n) => n.endsWith('.md') && !['PROTOCOL.md', 'DEFECTS.md', 'MATRIX.md', 'RAIL.md'].includes(n)).map((n) => path.join(d, n)).sort();
  if (!logs.length) return { ok: false, msg: `refusing: no logs under ${d}` };
  const seals = readSeals(fam);
  const next = {}; const refusals = []; const skippedFail = []; let unchanged = 0;
  for (const f of logs) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!isWalk(f)) continue; // a review/ledger record is not sealed: it is outside the freshness rule
    // A walk that honestly FAILED is left unsealed (the validator keeps it red) without
    // blocking the directory's passing walks — a seal records walks, not verdicts.
    if (/^verdict: *fail/mi.test(text)) { skippedFail.push(f); continue; }
    // Isolation logs prove a refusal, not a surface: they carry their own field set.
    const iso = /\/isolation\//.test(f) && ISOLATION_FIELDS[fam];
    const required = iso ? (/-outbound\.md$/.test(f) ? iso.outbound : iso.inbound) : FAMILIES[fam];
    for (const re of required) if (!new RegExp(re, 'mi').test(text)) refusals.push(`${f}: lacks ${re.replace(/^\^/, '')}`);
    if (/\b(TODO|unverified|placeholder)\b/i.test(text)) refusals.push(`${f}: still says TODO/unverified/placeholder`);
    const shot = (field(text, 'screenshot') || field(text, 'screenshots')).split(/\s+/)[0].replace(/[,;]$/, '');
    const shotPath = shot ? path.join(ROOT, path.dirname(f), shot) : null;
    if (!shotPath || !fs.existsSync(shotPath)) { refusals.push(`${f}: screenshot ${shot || '(none)'} not found`); continue; }
    const k = logContract(f);
    if (k.basis === 'none') { refusals.push(`${f}: names no inventoried route (url:) and no pages: files — nothing to seal it against`); continue; }
    if (k.unswept.length) refusals.push(`${f}: walks ${k.unswept.join(', ')}, which no sweep measures — add the route to portal/e2e/route-inventory.ts first`);
    const prev = seals[f];
    if (prev && prev.digest === k.digest) { unchanged++; next[f] = prev; continue; }
    // The walk proof: the log and its screenshot were written after every part
    // of the contract that moved (all of them for a first seal) last changed,
    // and after the previous seal.
    const moved = Object.keys(k.parts).filter((p) => prev?.parts?.[p] !== k.parts[p]);
    const since = Math.max(prev ? Date.parse(prev.sealedAt) : 0, ...moved.map(partChangedAt));
    const written = Math.min(fs.statSync(path.join(ROOT, f)).mtimeMs, fs.statSync(shotPath).mtimeMs);
    if (written <= since) refusals.push(`${f}: log/screenshot last written ${new Date(written).toISOString().slice(0, 16)}, but its contract (${moved.slice(0, 2).join('; ')}) last changed ${new Date(since).toISOString().slice(0, 16)} — walk it, then seal`);
    next[f] = { digest: k.digest, sealedAt: new Date().toISOString(), basis: `walk/${k.basis}`, parts: k.parts };
  }
  if (refusals.length) return { ok: false, msg: `refusing to seal ${d} (nothing written):\n${refusals.map((r) => `  ${r}`).join('\n')}` };
  for (const f of Object.keys(seals)) if (path.dirname(f) !== d) next[f] = seals[f];
  writeSeals(fam, next);
  return { ok: true, msg: `sealed ${logs.length - unchanged - skippedFail.length} log(s) under ${d} (${unchanged} already fresh${skippedFail.length ? `; ${skippedFail.length} failed walk(s) left unsealed: ${skippedFail.map((f) => path.basename(f)).join(', ')}` : ''})` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, ...rest] = process.argv.slice(2);
  if (cmd === 'judge' && a) process.stdout.write(`${judge(a, rest)}\n`);
  else if (cmd === 'seal' && a && !rest.length) { const r = seal(a); process.stdout.write(`${r.msg}\n`); process.exit(r.ok ? 0 : 1); }
  else if (cmd === 'contract' && a) process.stdout.write(`${JSON.stringify(logContract(rel(a)), null, 1)}\n`);
  else { process.stderr.write('usage: journeys.mjs judge <family-dir> <log>… | seal <dir> | contract <log>\n'); process.exit(2); }
}

export { judge, seal, contracts, readSeals, writeSeals, FAMILIES, routesOf, partChangedAt };
