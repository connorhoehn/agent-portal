// node --test scripts/runbooks/migrate-distillation.test.mjs
//
// The migration's contract (docs/distillation-runbooks-goal.md R2): every
// artifact accounted for, the nine hand rewrites emitted as written, machine
// text never migrated, applications carried over with their steps remapped,
// and the same input always producing the same bytes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, REPORT_PATH, convertArtifact, loadSources, migrate, renderReport, run } from './migrate-distillation.mjs';

let src;
const AT = '2026-10-14T09:00:00.000Z';
const input = (scenario = 'default') => ({
  artifacts: src.artifacts.rows(scenario),
  facts: src.facts.rows(scenario),
  applications: src.procedureApplications.rows(scenario),
});

before(async () => {
  const s = await loadSources();
  s.freezeClock(AT);
  src = { ...s, ctx: s.repoLintContext(ROOT) };
});

test('default corpus: 11 artifacts, the nine design rewrites migrated, two not, zero unaccounted, no problems', () => {
  const r = migrate(input(), src);
  assert.equal(r.entries.length, 11);
  assert.equal(r.unaccounted, 0);
  assert.deepEqual(r.problems, []);
  const migrated = Object.fromEntries(r.entries.filter((e) => e.outcome === 'migrated').map((e) => [e.artifact_id, e.runbook_id]));
  assert.deepEqual(migrated, {
    'art-001': 'rb-flaky-test-rerun-diff', 'art-002': 'rb-aurora-cold-start-retry', 'art-003': 'rb-fargate-arm64-image',
    'art-004': 'rb-auth-pr-csrf-gate', 'art-005': 'rb-ingest-pii-scan', 'art-006': 'rb-statsd-decommission',
    'art-009': 'rb-sso-new-origin', 'art-010': 'rb-tenant-cutover', 'art-011': 'rb-idle-teardown-proposal',
  });
  const skipped = r.entries.filter((e) => e.outcome === 'not-migrated');
  assert.deepEqual(skipped.map((e) => e.artifact_id), ['art-007', 'art-008']);
  for (const e of skipped) assert.ok(e.reason && e.reason.length > 20, `${e.artifact_id} has a reason`);
});

test('every emitted version names its source artifact, lints clean against the tree and round-trips', () => {
  const r = migrate(input(), src);
  assert.equal(r.rows.runbooks.length, 9);
  for (const v of r.rows.versions) {
    const e = r.entries.find((x) => x.runbook_id === v.runbook_id);
    assert.ok(v.provenance.source_artifact_ids.includes(e.artifact_id), `${v.runbook_id} names ${e.artifact_id}`);
    assert.deepEqual(src.lintRunbook(v.doc, src.ctx), [], v.runbook_id);
    assert.deepEqual(src.parseRunbook(src.renderRunbook(v.doc)), v.doc, v.runbook_id);
    assert.equal(v.markdown, src.renderRunbook(v.doc));
    assert.doesNotMatch(v.markdown, /\(\+\d+ more\)|Load-corpus|Uncompacted write/);
  }
});

test('applications carry over: succeeded → followed, and the failure at the flip lands on rb-tenant-cutover step 2', () => {
  const r = migrate(input(), src);
  const cut = r.rows.applications.filter((a) => a.runbook_id === 'rb-tenant-cutover');
  assert.deepEqual(cut.map((a) => [a.run_ref, a.outcome, a.failed_at_step]), [['sess-auth-05', 'followed', null], ['sess-auth-06', 'failed', 2]]);
  assert.equal(r.rows.applications.filter((a) => a.runbook_id === 'rb-sso-new-origin' && a.outcome === 'followed').length, 4);
});

test('a carried-over application that disagrees with its source is a problem, not a silent pass', () => {
  const apps = input().applications.map((p) => (p.id === 'papp-006' ? { ...p, failed_at_step_id: 'fact-019' } : p));
  const r = migrate({ ...input(), applications: apps }, src);
  assert.ok(r.problems.some((p) => /papp-006/.test(p) && /step 3/.test(p)), r.problems.join('\n'));
});

test('large scenario: every generated artifact is accounted for and none of their machine text is migrated', () => {
  const r = migrate(input('large'), src);
  assert.equal(r.unaccounted, 0);
  const generated = r.entries.filter((e) => e.artifact_id.startsWith('art-L'));
  assert.ok(generated.length > 0);
  for (const e of generated) assert.equal(e.outcome, 'not-migrated', `${e.artifact_id}: ${e.reason}`);
  for (const v of r.rows.versions) assert.doesNotMatch(v.markdown, /Load-corpus/);
});

test("a compaction-minted procedure (the design's bad examples 1-3) is not migrated, and the reason names the lint rules", () => {
  const minted = {
    id: 'art-901', type: 'procedure', status: 'draft', title: 'Canary judge config lives in SSM, edited from the portal',
    summary: 'Agents read their system prompt from Prompt Management on every invocation', when_this_helps: null,
    body_markdown: '', owner: 'Nina Rivera', created_at: AT, updated_at: AT,
  };
  const facts = [
    { id: 'fact-901', artifact_id: 'art-901', statement: 'Agents read their system prompt from Prompt Management on every invocation', plain: null, ordinal: 1 },
    { id: 'fact-905', artifact_id: 'art-901', statement: 'Any Bedrock list API in this codebase must be paginated by convention, not by memory', plain: null, ordinal: 2 },
    { id: 'fact-907', artifact_id: 'art-901', statement: 'Online evaluation needs both enableEval and enableOnlineEvalConfig context flags', plain: null, ordinal: 3 },
  ];
  const r = migrate({ artifacts: [minted], facts, applications: [] }, src);
  const [e] = r.entries;
  assert.equal(e.outcome, 'not-migrated');
  assert.match(e.reason, /machine-minted procedure/);
  assert.match(e.reason, /R-imperative/);
  assert.match(e.reason, /R-verify/);
  assert.equal(r.rows.runbooks.length, 0);
});

test('a procedure with no rewrite but clean steps, a check and a way back is emitted as a draft runbook', () => {
  const art = {
    id: 'art-950', type: 'procedure', status: 'published', title: 'Restart the span projector after a deploy',
    summary: 'Restart the span projector so traces written during a deploy are projected.', when_this_helps: 'Traces from a deploy window are missing.',
    body_markdown: '## Steps\n1. Restart the span projector once the deploy finishes.\n   Expect the projector to report healthy within a minute.\n\n## Verify\n- The deploy window traces appear in the span projector tables.\n\n## Roll back\n1. Restart the span projector again on the previous build.',
    owner: 'p-004', created_at: AT, updated_at: AT,
  };
  const doc = convertArtifact(art, []);
  assert.deepEqual(doc.steps, [{ do: 'Restart the span projector once the deploy finishes.', expect: 'the projector to report healthy within a minute.' }]);
  const r = migrate({ artifacts: [art], facts: [], applications: [] }, src);
  assert.equal(r.entries[0].outcome, 'migrated', r.entries[0].reason);
  assert.equal(r.rows.runbooks[0].status, 'draft');
  assert.deepEqual(r.rows.versions[0].provenance.source_artifact_ids, ['art-950']);
});

test('insights, conventions and decisions with no rewrite are reported as not a procedure', () => {
  const art = { id: 'art-960', type: 'decision', status: 'published', title: 'Tag every eval run', summary: 's', when_this_helps: null, body_markdown: '', owner: 'p-008', created_at: AT, updated_at: AT };
  const r = migrate({ artifacts: [art], facts: [], applications: [] }, src);
  assert.equal(r.entries[0].outcome, 'not-migrated');
  assert.match(r.entries[0].reason, /not a procedure \(decision\)/);
});

test('deterministic: the same input gives the same report and the same rows, byte for byte', () => {
  const a = migrate(input(), src), b = migrate(input(), src);
  assert.equal(renderReport(a, { source: 'x' }), renderReport(b, { source: 'x' }));
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test('--check passes on the committed report and fails on a stale one', async () => {
  const good = await run(['--check']);
  assert.equal(good.ok, true, good.lines.join('\n'));
  assert.equal(readFileSync(join(ROOT, REPORT_PATH), 'utf8'), good.report);
  const dir = mkdtempSync(join(tmpdir(), 'runbook-migration-'));
  const stale = join(dir, 'report.md');
  writeFileSync(stale, good.report.replace('migrated → rb-tenant-cutover', 'migrated → rb-something-else'));
  const bad = await run(['--check', '--report', stale]);
  assert.equal(bad.ok, false);
  assert.match(bad.lines.join('\n'), /stale/);
});
