#!/usr/bin/env node
// Summarise docs/user-search-probe-results.json (written by
// portal/e2e/user-search-probe.spec.ts) into the gap matrix that
// docs/user-search-intents.md quotes, and — with --check — judge it against
// per-tenant floors (the docs/user-search-goal.md judge outline).
//
//   node scripts/user-search-report.mjs [results.json] [--markdown] [--json]
//   node scripts/user-search-report.mjs --check orgiq=0.8,access=0.9 ...
//
// Verdicts per probe: supported / partial / wrong / unsupported ("evidence"
// rows from the api surface never count). A surface's verdict for an intent is
// the best over its NATURAL phrasings; a surface that only works with the
// bounded grammar phrase is capped at partial. The intent's verdict is its
// best surface. A palette hand-off to /iq/search counts as partial only when
// search itself supported that phrasing (2 clicks), otherwise as wrong.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json')) ?? resolve(ROOT, 'docs/user-search-probe-results.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const RANK = { supported: 3, partial: 2, wrong: 1, unsupported: 0 };
const CODE = { supported: 'S', partial: 'P', wrong: 'W', unsupported: 'U' };
const SURFACES = ['search', 'answer', 'palette', 'composer', 'list-search'];
const TENANTS = ['orgiq', 'assessment', 'social', 'pipelines', 'access'];
const best = (vs) => vs.reduce((a, v) => (RANK[v] > RANK[a] ? v : a), 'unsupported');

// Re-grade answer and keyless search rows from their recorded evidence with the CURRENT rules,
// so a rule fix does not need a fresh browser run (the probe applies the same rules live).
const CANNED = /^\s*(\*\*Observability Platform\*\*|There are no Observability work items|Here is how to use \*\*Cut over the smallest tenant|Based on the knowledge graph analysis|I found relevant information about auth|Here's an overview of your organization|\*\*Influence Leaderboard\*\*)/;
const intentById = new Map(data.intents.map((i) => [i.id, i]));
for (const p of data.probes) {
  const i = intentById.get(p.intent);
  if (!i) continue;
  const text = i.expected.text.map((t) => (typeof t === 'string' ? new RegExp(t) : new RegExp(t.source, t.flags)));
  if (p.surface === 'answer' && p.verdict !== 'unsupported' && CANNED.test(p.evidence?.answer ?? '')) {
    p.verdict = 'wrong'; p.reason = `canned mock reply, not computed from the question (${p.evidence.source})`;
  } else if (p.surface === 'answer' && p.verdict === 'supported' && !text.some((r) => r.test(p.evidence?.answer ?? ''))) {
    p.verdict = 'wrong'; p.reason = 'answer misses the expected record';
  }
  if (p.surface === 'search' && !(i.expected.keys ?? []).length && Array.isArray(p.evidence?.top) && p.evidence.top.length) {
    const titles = p.evidence.top.map((t) => t.replace(/^\S+ /, '').replace(/ \([^)]*\)$/, ''));
    const rank = titles.findIndex((t) => text.some((r) => r.test(t)));
    if (rank >= 0 && rank < 3) { p.verdict = 'supported'; p.reason = `expected record at rank ${rank + 1}`; }
    else if (rank >= 0) { p.verdict = 'partial'; p.reason = `expected record at rank ${rank + 1}`; }
    else { p.verdict = 'wrong'; p.reason = `results, none expected (top: ${titles[0]})`; }
  }
}

// A list box that returns the same rows for every phrasing ignored the query: what it shows is
// the page, not an answer, so a "supported" there is only partial.
const bySurface = new Map();
for (const p of data.probes) {
  if (p.surface !== 'list-search' && p.surface !== 'composer') continue;
  const k = `${p.intent}|${p.surface}|${p.route}`;
  bySurface.set(k, [...(bySurface.get(k) ?? []), p]);
}
for (const ps of bySurface.values()) {
  const shown = ps.filter((p) => p.verdict !== 'unsupported' && p.evidence?.rowsAfter > 0 && !p.evidence?.url);
  const sigs = new Set(shown.map((p) => `${p.evidence.rowsAfter}|${(p.evidence.firstRows ?? []).join('|')}`));
  const distinctQueries = new Set(shown.map((p) => p.phrasing.toLowerCase())).size;
  if (shown.length >= 3 && distinctQueries >= 3 && sigs.size === 1) {
    for (const p of shown) if (p.verdict === 'supported') { p.verdict = 'partial'; p.reason = 'the box ignored the query (same rows for every phrasing)'; }
  }
}

// palette hand-off refinement
const searchBy = new Map(data.probes.filter((p) => p.surface === 'search').map((p) => [`${p.intent}|${p.phrasing}`, p.verdict]));
for (const p of data.probes) {
  if (p.surface === 'palette' && p.handoff) {
    const s = searchBy.get(`${p.intent}|${p.phrasing}`);
    if (s !== 'supported') { p.verdict = 'wrong'; p.reason += ' (search did not answer it either)'; }
  }
}

const intents = data.intents.filter((i) => data.probes.some((p) => p.intent === i.id));
const rows = intents.map((i) => {
  const probes = data.probes.filter((p) => p.intent === i.id && p.verdict !== 'evidence');
  const surfaces = {};
  for (const s of SURFACES) {
    const ps = probes.filter((p) => p.surface === s);
    if (!ps.length) continue;
    const nat = ps.filter((p) => !p.grammar);
    const gram = ps.filter((p) => p.grammar);
    let v = best(nat.map((p) => p.verdict));
    const gv = gram.length ? best(gram.map((p) => p.verdict)) : null;
    if (RANK[v] < RANK.partial && gv === 'supported') v = 'partial';
    surfaces[s] = { verdict: v, natural: `${nat.filter((p) => p.verdict === 'supported').length}/${nat.length}`, grammar: gv, ms: Math.round(ps.reduce((a, p) => a + p.latencyMs, 0) / ps.length) };
  }
  const verdict = i.cloneBlind ? 'clone-blind' : best(Object.values(surfaces).map((s) => s.verdict));
  const phrasingOk = i.phrasings.filter((ph) => probes.some((p) => p.phrasing === ph && p.verdict === 'supported')).length;
  const evidence = data.probes.filter((p) => p.intent === i.id && p.verdict === 'evidence').map((p) => `${p.route}: ${p.reason}`);
  return { ...i, surfaces, verdict, phrasingOk, phrasingTotal: i.phrasings.length, apiEvidence: evidence };
});

const tenants = TENANTS.map((t) => {
  const rs = rows.filter((r) => r.tenant === t && r.verdict !== 'clone-blind');
  const n = rs.length || 1;
  const count = (v) => rs.filter((r) => r.verdict === v).length;
  const phr = rs.reduce((a, r) => a + r.phrasingOk, 0), phrT = rs.reduce((a, r) => a + r.phrasingTotal, 0) || 1;
  return { tenant: t, intents: rs.length, cloneBlind: rows.filter((r) => r.tenant === t && r.verdict === 'clone-blind').length, supported: count('supported'), partial: count('partial'), wrong: count('wrong'), unsupported: count('unsupported'),
    passRate: +(count('supported') / n).toFixed(2), reachRate: +((count('supported') + count('partial')) / n).toFixed(2), phrasingRate: +(phr / phrT).toFixed(2) };
});

if (args.includes('--json')) { console.log(JSON.stringify({ tenants, rows }, null, 1)); }
else if (args.includes('--markdown')) {
  console.log('| tenant | intents | supported | partial | wrong | unsupported | pass rate | reach rate | phrasings answered |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const t of tenants) console.log(`| ${t.tenant} | ${t.intents} | ${t.supported} | ${t.partial} | ${t.wrong} | ${t.unsupported} | ${Math.round(t.passRate * 100)}% | ${Math.round(t.reachRate * 100)}% | ${Math.round(t.phrasingRate * 100)}% |`);
  for (const t of TENANTS) {
    console.log(`\n#### ${t}\n`);
    console.log(`| intent | role | ${SURFACES.join(' | ')} | verdict | phrasings |`);
    console.log(`|---|---|${SURFACES.map(() => '---').join('|')}|---|---|`);
    for (const r of rows.filter((x) => x.tenant === t)) {
      const cells = SURFACES.map((s) => (r.surfaces[s] ? `${CODE[r.surfaces[s].verdict]} ${r.surfaces[s].natural}${r.surfaces[s].grammar ? ` (g:${CODE[r.surfaces[s].grammar]})` : ''}` : '—'));
      console.log(`| \`${r.id}\` ${r.intent} | ${r.role} | ${cells.join(' | ')} | **${r.verdict}** | ${r.phrasingOk}/${r.phrasingTotal} |`);
    }
  }
} else {
  for (const t of tenants) console.log(`${t.tenant.padEnd(11)} ${String(t.intents).padStart(3)} intents  pass ${Math.round(t.passRate * 100)}%  reach ${Math.round(t.reachRate * 100)}%  phrasings ${Math.round(t.phrasingRate * 100)}%  (S${t.supported} P${t.partial} W${t.wrong} U${t.unsupported})`);
}

const check = args[args.indexOf('--check') + 1];
if (args.includes('--check') && check) {
  let failed = 0;
  for (const pair of check.split(',')) {
    const [t, floor] = pair.split('=');
    const row = tenants.find((x) => x.tenant === t);
    const ok = row && row.passRate >= Number(floor);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${t} pass rate ${row ? row.passRate : 'n/a'} (floor ${floor})`);
  }
  process.exit(failed ? 1 : 0);
}
