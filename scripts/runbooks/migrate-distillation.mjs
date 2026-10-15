#!/usr/bin/env node
// Distillation → runbooks migration (docs/distillation-runbooks-goal.md R2,
// design §5.1). Deterministic and model-free: it reads the distillation
// artifacts, accounts for every one of them, emits runbook rows and writes
// docs/runbooks-migration-report.md.
//
//   node scripts/runbooks/migrate-distillation.mjs                 # write the report (default fixtures)
//   node scripts/runbooks/migrate-distillation.mjs --check         # exit 1 unless the report is current and nothing is unaccounted
//   node scripts/runbooks/migrate-distillation.mjs --rows out.json # also write the emitted rows (runbooks, versions, applications)
//   node scripts/runbooks/migrate-distillation.mjs --scenario large --report /tmp/r.md
//   node scripts/runbooks/migrate-distillation.mjs --from-store http://127.0.0.1:3001 --cookie "orgiq_session=…" --report /tmp/r.md
//
// Options: --at <iso> freezes the mock clock (row timestamps); --report <path>
// overrides the report path; --from-store reads L2 artifacts from a running
// BFF (GET /api/distillation/items?level=L2) instead of the fixtures.
//
// Rules, in order, per artifact:
//   1. A hand rewrite in middleware/src/mock/runbooks.seed.ts (MIGRATION_MAP)
//      is emitted as written, after checking it lints clean against the tree,
//      round-trips, names its source artifact and carries the source's
//      procedure applications over with their steps remapped.
//   2. MIGRATION_MAP says "not migrated" → reported with its reason.
//   3. Retired → not migrated.
//   4. Insight / convention / decision with no rewrite → not migrated: there
//      is no procedure in it (a runbook that cites it says so).
//   5. Procedure / runbook with no rewrite (compaction-minted, the `large`
//      generator, anything a live store grew) → converted mechanically from
//      its ordered facts or its body's numbered lists; emitted as a DRAFT
//      runbook only if the result lints with zero findings, otherwise not
//      migrated with the lint findings as the reason.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPORT_PATH = 'docs/runbooks-migration-report.md';
const SOURCES = join(ROOT, 'scripts/runbooks/migration-sources.mts');
const TSX_API = join(ROOT, 'middleware/node_modules/tsx/dist/esm/api/index.mjs');

const OUTCOME = { succeeded: 'followed', failed: 'failed', abandoned: 'not_used' };

/** The middleware modules the migration reads, through the middleware's own tsx (one module graph). */
export async function loadSources() {
  if (!existsSync(TSX_API)) throw new Error(`tsx not found at ${TSX_API} (middleware dependencies are not installed)`);
  const { tsImport } = await import(pathToFileURL(TSX_API).href);
  return tsImport(pathToFileURL(SOURCES).href, import.meta.url);
}

// ─── Mechanical conversion (rule 5) ───────────────────────────────────────────

/** `## Heading` → its lines, for the sections a body can hold. */
function bodySections(md) {
  const out = new Map();
  let cur = null;
  for (const line of String(md ?? '').split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { cur = h[1].toLowerCase(); out.set(cur, []); continue; }
    if (cur) out.get(cur).push(line);
  }
  return out;
}
const numbered = (lines = []) => lines.map((l) => /^\s*\d+\.\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean);
/** Numbered steps, each with the indented "Expect …" line under it when the body has one. */
function numberedSteps(lines = []) {
  const out = [];
  for (const l of lines) {
    const n = /^\s*\d+\.\s+(.+?)\s*$/.exec(l);
    if (n) { out.push({ do: n[1] }); continue; }
    const e = /^\s+Expect\s+(.+?)\s*$/.exec(l);
    if (e && out.length > 0) out[out.length - 1].expect = e[1];
  }
  return out;
}
const bulleted = (lines = []) => lines.map((l) => /^\s*[-*]\s+(?:\[ \]\s+)?(.+?)\s*$/.exec(l)?.[1]).filter(Boolean);
const firstOf = (sections, names) => names.map((n) => sections.get(n)).find((v) => v && v.length > 0) ?? [];

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

/** A RunbookDoc built from an artifact with no rewrite: no prose is invented, so most machine-minted ones fail lint. */
export function convertArtifact(artifact, artifactFacts) {
  const sections = bodySections(artifact.body_markdown);
  const ordered = artifactFacts.filter((f) => f.ordinal !== null && f.ordinal !== undefined).sort((a, b) => a.ordinal - b.ordinal);
  const steps = ordered.length > 0
    ? ordered.map((f) => ({ do: String(f.plain ?? f.statement).trim() }))
    : numberedSteps(firstOf(sections, ['steps', 'triage', 'fix', 'procedure']));
  return {
    title: String(artifact.title ?? '').trim(),
    summary: String(artifact.summary ?? '').trim(),
    use_when: String(artifact.when_this_helps ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
    not_for: [],
    triggers: { work_item_labels: [], repos: [], tools: [], keywords: [] },
    preconditions: bulleted(firstOf(sections, ['before you start', 'preconditions'])),
    steps,
    verify: bulleted(firstOf(sections, ['verify'])).map((check) => ({ check })),
    failure_modes: [],
    rollback: numbered(firstOf(sections, ['roll back', 'rollback'])).map((d) => ({ do: d })),
  };
}

/** "R-imperative at steps[0].do, steps[1].do; R-verify at verify" — every rule, its first three places. */
function describeFindings(findings) {
  const by = new Map();
  for (const f of findings) by.set(f.rule, [...(by.get(f.rule) ?? []), f.path]);
  return [...by].map(([rule, paths]) => `${rule} at ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} other place${paths.length === 4 ? '' : 's'}` : ''}`).join('; ');
}

// ─── The migration (pure over its inputs) ─────────────────────────────────────

/**
 * @param input.artifacts     distillation artifact rows
 * @param input.facts         distillation fact rows ([] when unknown)
 * @param input.applications  procedure application rows, or null when unknown (store mode)
 * @param src                 the loaded sources (seed + lib + lint context)
 */
export function migrate(input, src) {
  const { artifacts, facts, applications } = input;
  const ctx = src.ctx;
  const seeds = new Map(src.seedRunbooks().map((s) => [s.runbook.id, s]));
  const map = new Map(src.MIGRATION_MAP.map((m) => [m.artifact_id, m]));
  const factsBy = new Map();
  for (const f of facts) factsBy.set(f.artifact_id, [...(factsBy.get(f.artifact_id) ?? []), f]);
  const citedBy = new Map();
  for (const s of seeds.values()) for (const a of s.migration.cites_artifact_ids) citedBy.set(a, [...(citedBy.get(a) ?? []), s.runbook.id]);

  const entries = [];
  const problems = [];
  const rows = { runbooks: [], versions: [], applications: [] };
  const usedIds = new Set();

  /** Every check a migrated doc must pass, as problem strings. */
  const checkDoc = (label, doc, sourceId, provenance) => {
    const out = [];
    const fp = src.formatProblems(doc);
    if (fp.length > 0) return [`${label}: cannot render canonically (${fp.join('; ')})`];
    const md = src.renderRunbook(doc);
    if (!isDeepStrictEqual(src.parseRunbook(md), doc)) out.push(`${label}: does not round-trip through parseRunbook(renderRunbook(doc))`);
    const findings = src.lintRunbook(doc, ctx);
    if (findings.length > 0) out.push(`${label}: lint ${describeFindings(findings)}`);
    if (!provenance.source_artifact_ids.includes(sourceId)) out.push(`${label}: provenance.source_artifact_ids does not name ${sourceId}`);
    return out;
  };

  for (const a of [...artifacts].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const own = factsBy.get(a.id) ?? [];
    const base = { artifact_id: a.id, type: a.type, status: a.status, title: a.title, facts: own.map((f) => f.id) };
    const m = map.get(a.id);

    // Rules 1–2: the hand rewrites and the hand decisions.
    if (m && m.runbook_id) {
      const seed = seeds.get(m.runbook_id);
      if (!seed) { problems.push(`${a.id}: MIGRATION_MAP names ${m.runbook_id}, which runbooks.seed.ts does not define`); entries.push({ ...base, outcome: 'unaccounted', reason: `no seed for ${m.runbook_id}` }); continue; }
      const v = seed.versions[seed.versions.length - 1];
      problems.push(...checkDoc(`${a.id} → ${seed.runbook.id}`, v.doc, a.id, v.provenance));

      // Applications carry over on v1 with their outcome and step remapped.
      const carried = [];
      if (applications) {
        const src_ = applications.filter((p) => p.procedure_id === a.id).sort((x, y) => (x.applied_at < y.applied_at ? -1 : x.applied_at > y.applied_at ? 1 : 0));
        const mine = seed.applications.filter((r) => src_.some((p) => p.session_id === r.run_ref)).sort((x, y) => (x.at < y.at ? -1 : 1));
        if (src_.length !== mine.length) problems.push(`${a.id}: ${src_.length} procedure application(s) in the source, ${mine.length} carried onto ${seed.runbook.id}`);
        src_.forEach((p, k) => {
          const r = mine[k];
          if (!r) return;
          const ordinal = p.failed_at_step_id ? own.find((f) => f.id === p.failed_at_step_id)?.ordinal ?? null : null;
          const expectedStep = ordinal === null ? null : seed.migration.step_map.find((s) => s.ordinal === ordinal)?.step ?? null;
          const want = OUTCOME[p.outcome];
          if (r.outcome !== want || r.run_ref !== p.session_id || r.failed_at_step !== expectedStep) {
            problems.push(`${a.id}: ${p.id} (${p.outcome}${ordinal ? ` at source step ${ordinal}` : ''}) should carry over as ${want}${expectedStep ? ` at step ${expectedStep}` : ''} on ${p.session_id}, found ${r.id} ${r.outcome} ${r.failed_at_step ?? ''} on ${r.run_ref}`);
          }
          carried.push({ from: p.id, to: r.id, outcome: `${p.outcome} → ${r.outcome}${r.failed_at_step ? ` at step ${r.failed_at_step}` : ''}`, session: p.session_id });
        });
      }

      rows.runbooks.push(seed.runbook); rows.versions.push(...seed.versions); rows.applications.push(...seed.applications);
      usedIds.add(seed.runbook.id);
      entries.push({
        ...base, outcome: 'migrated', runbook_id: seed.runbook.id, runbook_status: seed.runbook.status, version: v.version,
        sha: v.sha256, title_after: v.doc.title, owner: src.PEOPLE[seed.runbook.owner_person_id] ?? seed.runbook.owner_person_id,
        scope: seed.header.scope_label, steps: v.doc.steps.length, step_map: seed.migration.step_map, applications: carried,
        cites: seed.migration.cites_artifact_ids,
      });
      continue;
    }
    if (m) { entries.push({ ...base, outcome: 'not-migrated', reason: m.reason }); continue; }

    // Rule 3: retired.
    if (a.status === 'retired') { entries.push({ ...base, outcome: 'not-migrated', reason: 'retired: nothing selects a retired record, and its run notes stay as evidence' }); continue; }

    // Rule 4: not a procedure.
    if (a.type === 'insight' || a.type === 'convention' || a.type === 'decision') {
      const by = citedBy.get(a.id);
      entries.push({
        ...base, outcome: 'not-migrated',
        reason: by ? `not a procedure (${a.type}); kept as a note on ${by.join(', ')}` : `not a procedure (${a.type}) and no runbook cites it; where it binds work, record it as a decision on the initiative`,
      });
      continue;
    }

    // Rule 5: a procedure or runbook with no rewrite.
    const doc = convertArtifact(a, own);
    const fp = src.formatProblems(doc);
    const findings = fp.length > 0 ? [] : src.lintRunbook(doc, ctx);
    if (fp.length > 0 || findings.length > 0 || doc.steps.length === 0) {
      const why = fp.length > 0 ? `cannot be rendered (${fp.slice(0, 2).join('; ')})` : doc.steps.length === 0 ? 'has no steps' : `fails lint: ${describeFindings(findings)}`;
      entries.push({ ...base, outcome: 'not-migrated', reason: `machine-minted ${a.type} with no hand rewrite; ${why}. Its run notes stay as evidence for a future proposal` });
      continue;
    }
    let id = `rb-${slug(a.title)}`;
    if (usedIds.has(id) || seeds.has(id)) id = `${id}-${a.id}`;
    usedIds.add(id);
    const provenance = { run_refs: [], session_ids: [], lab_experience_ids: [], source_artifact_ids: [a.id] };
    const version = src.versionOf({ runbook_id: id, version: 1, doc, author: { kind: 'migration', id: 'scripts/runbooks/migrate-distillation.mjs' }, provenance });
    const runbook = { id, scope: { kind: 'org', ref: null }, owner_person_id: a.owner ?? 'unassigned', status: 'draft', current_version: 1, created_at: a.created_at, updated_at: a.updated_at };
    const apps = (applications ?? []).filter((p) => p.procedure_id === a.id).map((p, k) => ({
      id: `rba-${id.slice(3)}-${k + 1}`, runbook_id: id, version: 1, run_ref: p.session_id, brief_id: '', outcome: OUTCOME[p.outcome],
      failed_at_step: p.failed_at_step_id ? own.find((f) => f.id === p.failed_at_step_id)?.ordinal ?? null : null, note: p.note, at: p.applied_at,
    }));
    rows.runbooks.push(runbook); rows.versions.push(version); rows.applications.push(...apps);
    entries.push({ ...base, outcome: 'migrated', runbook_id: id, runbook_status: 'draft', version: 1, sha: version.sha256, title_after: doc.title, owner: runbook.owner_person_id, scope: 'org-wide', steps: doc.steps.length, step_map: [], applications: apps.map((r) => ({ from: '', to: r.id, outcome: r.outcome, session: r.run_ref })), cites: [], converted: true });
  }

  const unaccounted = entries.filter((e) => e.outcome !== 'migrated' && e.outcome !== 'not-migrated').length;
  return { entries, rows, problems, unaccounted };
}

// ─── The report ───────────────────────────────────────────────────────────────

export function renderReport(result, { source }) {
  const { entries, problems, unaccounted } = result;
  const migrated = entries.filter((e) => e.outcome === 'migrated');
  const skipped = entries.filter((e) => e.outcome === 'not-migrated');
  const L = [];
  L.push('# Distillation → runbooks: migration report', '');
  L.push('Generated by `node scripts/runbooks/migrate-distillation.mjs` (deterministic, no model calls); `--check` fails when this file is stale.');
  L.push('Do not edit by hand: change `middleware/src/mock/runbooks.seed.ts` or the script and regenerate.', '');
  L.push(`Source: ${source}.`, '');
  L.push(`Artifacts: ${entries.length} · migrated: ${migrated.length} · not migrated: ${skipped.length} · unaccounted: ${unaccounted}`, '');
  if (problems.length > 0) { L.push('## Problems', '', ...problems.map((p) => `- ${p}`), ''); }

  L.push('## Every artifact', '');
  for (const e of entries) {
    const head = `- **${e.artifact_id}** (${e.type}, ${e.status}) "${e.title}"`;
    if (e.outcome === 'migrated') L.push(`${head}: migrated → ${e.runbook_id} (${e.runbook_status}, v${e.version}, sha ${e.sha.slice(0, 12)}${e.converted ? ', converted mechanically' : ''})`);
    else if (e.outcome === 'not-migrated') L.push(`${head}: not-migrated: ${e.reason}`);
    else L.push(`${head}: UNACCOUNTED (${e.reason})`);
  }
  L.push('');

  if (migrated.length > 0) {
    L.push('## Runbooks emitted', '');
    L.push('| Runbook | Title | Scope | Owner | Status | Steps | From |', '|---|---|---|---|---|---|---|');
    for (const e of migrated) L.push(`| ${e.runbook_id} | ${e.title_after.replace(/\|/g, '\\|')} | ${e.scope} | ${e.owner} | ${e.runbook_status} | ${e.steps} | ${e.artifact_id} (${e.type}) |`);
    L.push('');
  }

  const withMap = migrated.filter((e) => e.step_map.length > 0);
  if (withMap.length > 0) {
    L.push('## Procedure steps, old to new', '');
    L.push('Each ordered fact of a source procedure and where it landed in the rewrite.', '');
    for (const e of withMap) {
      L.push(`- ${e.artifact_id} → ${e.runbook_id}:`);
      for (const s of e.step_map) L.push(`  - ${s.fact_id} (source step ${s.ordinal}) → ${s.step === null ? 'not a step' : `step ${s.step}`}: ${s.now}`);
    }
    L.push('');
  }

  const factsFolded = migrated.filter((e) => e.facts.length > 0 && e.step_map.length === 0);
  if (factsFolded.length > 0) {
    L.push('## Claims folded into rewrites', '');
    for (const e of factsFolded) L.push(`- ${e.facts.join(', ')} (${e.artifact_id}) → the steps and notes of ${e.runbook_id}`);
    L.push('');
  }

  const carried = migrated.filter((e) => e.applications.length > 0);
  if (carried.length > 0) {
    L.push('## Procedure applications carried over (v1)', '');
    for (const e of carried) for (const a of e.applications) L.push(`- ${a.from || '(store)'} on ${a.session} → ${a.to} on ${e.runbook_id}: ${a.outcome}`);
    L.push('');
  }

  const cites = migrated.filter((e) => e.cites.length > 0);
  if (cites.length > 0) {
    L.push('## Notes that cite non-procedural artifacts', '');
    for (const e of cites) L.push(`- ${e.runbook_id} cites ${e.cites.join(', ')}`);
    L.push('');
  }
  return L.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { check: false, rows: null, report: REPORT_PATH, scenario: 'default', fromStore: null, cookie: process.env.RUNBOOK_MIGRATE_COOKIE ?? null, at: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === '--check') o.check = true;
    else if (a === '--rows') o.rows = val();
    else if (a === '--report') o.report = val();
    else if (a === '--scenario') o.scenario = val();
    else if (a === '--from-store') o.fromStore = val();
    else if (a === '--cookie') o.cookie = val();
    else if (a === '--at') o.at = val();
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

async function readStore(base, cookie) {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    const url = new URL('/api/distillation/items', base);
    url.searchParams.set('level', 'L2'); url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, { headers: cookie ? { cookie } : {} });
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    const body = await res.json();
    items.push(...body.items);
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return items;
}

export async function run(argv) {
  const o = parseArgs(argv);
  const src = await loadSources();
  if (o.at) src.freezeClock(o.at);
  const ctx = src.repoLintContext(ROOT);
  const sources = { ...src, ctx };

  let input, source;
  if (o.fromStore) {
    input = { artifacts: await readStore(o.fromStore, o.cookie), facts: [], applications: null };
    source = `L2 artifacts read from ${o.fromStore} (facts and applications not read in store mode)`;
  } else {
    input = {
      artifacts: src.artifacts.rows(o.scenario),
      facts: src.facts.rows(o.scenario),
      applications: src.procedureApplications.rows(o.scenario),
    };
    source = `middleware/src/mock/distillation.ts fixtures, scenario \`${o.scenario}\``;
  }
  const result = migrate(input, sources);
  const report = renderReport(result, { source }) + '\n';
  const reportPath = resolve(ROOT, o.report);

  const lines = [];
  let ok = result.unaccounted === 0 && result.problems.length === 0;
  if (o.check) {
    const onDisk = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
    if (onDisk !== report) { ok = false; lines.push(`${o.report} is ${onDisk === null ? 'missing' : 'stale'}: run node scripts/runbooks/migrate-distillation.mjs`); }
  } else {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    lines.push(`wrote ${o.report}`);
  }
  if (o.rows) {
    writeFileSync(resolve(process.cwd(), o.rows), JSON.stringify(result.rows, null, 2) + '\n');
    lines.push(`wrote ${o.rows}`);
  }
  const migrated = result.entries.filter((e) => e.outcome === 'migrated').length;
  lines.push(`${result.entries.length} artifacts: ${migrated} migrated, ${result.entries.length - migrated - result.unaccounted} not migrated, ${result.unaccounted} unaccounted`);
  for (const p of result.problems) lines.push(`problem: ${p}`);
  return { ok, lines, result, report };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(process.argv.slice(2)).then(({ ok, lines }) => {
    for (const l of lines) console.log(l);
    process.exit(ok ? 0 : 1);
  }, (err) => { console.error(err instanceof Error ? err.message : err); process.exit(2); });
}
