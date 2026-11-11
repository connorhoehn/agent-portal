// Run with:  cd portal && node --test src/pages/runbooks/__tests__/runbooksModel.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefRefOfRun, distillationRedirect, evidenceSentences, filterProposals, proposalStatusLabel, runbookEvidenceSentences, sameScope, scopeInWords, libraryCommandAdapter, libraryGroups, libraryRows, parseTab,
  proposalGroups, proposalRows, fileLanguageLabel, fileModeLabel, filesDiffSummary, formatBytes, shortSha, SECTION_KIND_LABEL, refusalMessage, stepMarkers, viewerDiff, NEW_RUNBOOK_BODY_STARTER, newRunbookRequest,
} from '../runbooksModel.ts';
import { briefTaskTitle, buildNames } from '../runbookNames.ts';
import type { Proposal, RunbookApplication, RunbookRow } from '../types.ts';

const health = { status: 'proven' as const, reason: '', warning: null };
const rb = (id: string, kind: RunbookRow['scope']['kind'], ref: string | null, over: Partial<RunbookRow> = {}): RunbookRow => ({
  id, scope: { kind, ref }, owner_person_id: 'p-001', status: 'published', current_version: 2, created_at: '', updated_at: '',
  title: `Title of ${id}`, summary: 'A summary', sha256: 'a'.repeat(64), health, open_proposals: 0, ...over,
});

test('library rows group by scope kind, filter by search and status, and drop empty groups', () => {
  const all = [rb('rb-a', 'initiative', 'p-auth'), rb('rb-b', 'repo', 'orgiq-auth'), rb('rb-c', 'repo', 'orgiq-obs', { status: 'draft', open_proposals: 2 })];
  const rows = libraryRows(all);
  assert.deepEqual(libraryGroups(rows).map((g) => [g.id, g.count]), [['initiative', 1], ['repo', 2]]);
  assert.equal(libraryRows(all, 'obs').length, 1);
  assert.equal(libraryRows(all, '', 'draft')[0]!.subline, 'orgiq-obs · v2 · draft · 2 open');
});

test('the library composer opens one exact runbook and filters by status', async () => {
  const calls: string[] = [];
  const a = libraryCommandAdapter([{ id: 'rb-a', title: 'Cut over' }], { setQuery: (v) => calls.push(`q:${v}`), setStatus: (v) => calls.push(`s:${v}`), refresh: () => calls.push('r'), open: (id) => calls.push(`o:${id}`) });
  await a.execute('open Cut over');
  await a.execute('show draft runbooks');
  await assert.rejects(async () => a.execute('delete everything'));
  assert.deepEqual(calls, ['o:rb-a', 's:draft']);
});

test('step markers: a failed run marks the failing step and what it never reached', () => {
  const steps = [{ do: 'one' }, { do: 'two' }, { do: 'three' }];
  const app = (over: Partial<RunbookApplication>): RunbookApplication => ({ id: 'a', runbook_id: 'rb-a', version: 1, run_ref: 'job-1', brief_id: 'b', outcome: 'failed', failed_at_step: 2, note: 'did not take', at: '2026-10-11T00:00:00Z', ...over });
  assert.deepEqual(stepMarkers(steps, [app({})], 1).map((m) => m.status), ['done', 'failed', 'skipped']);
  assert.deepEqual(stepMarkers(steps, [app({ outcome: 'followed', failed_at_step: null })], 1).map((m) => m.status), ['done', 'done', 'done']);
  assert.deepEqual(stepMarkers(steps, [app({})], 2).map((m) => m.status), [undefined, undefined, undefined]);
});

test('proposals group into open and decided, newest wording from the source', () => {
  const p = (id: string, status: Proposal['status'], over: Partial<Proposal> = {}): Proposal => ({
    id, kind: 'edit', runbook_id: 'rb-a', base_version: 1, proposed: null, rationale: '', source: { kind: 'run', run_ref: 'job-9', lab_experience_ids: [] },
    lint: [], similar: [], status, decided_by: null, decided_at: null, note: null, merged_into: null, created_at: '', ...over,
  });
  const rows = proposalRows([p('prop-1', 'open'), p('prop-2', 'accepted', { source: { kind: 'person', person_id: 'p-003', lab_experience_ids: [] } })], new Map([['rb-a', 'Cut over']]));
  assert.deepEqual(proposalGroups(rows).map((g) => g.id), ['open', 'decided']);
  assert.equal(rows[0]!.subline, 'Edit · A run');
  assert.equal(rows[1]!.title, 'Cut over');
});

test('a run page maps to its brief ref only for jobs', () => {
  assert.equal(briefRefOfRun('job:job-0002'), 'job-0002');
  assert.equal(briefRefOfRun('agent-run:x'), null);
});

test('refusals read as sentences: masquerading, retired, stale base, closed, self', () => {
  assert.match(refusalMessage(403, 'MASQUERADING', 'x'), /viewing as someone else/);
  assert.match(refusalMessage(409, 'RETIRED', 'x'), /retired/);
  assert.match(refusalMessage(409, 'VERSION_CONFLICT', 'x'), /changed since the proposal/);
  assert.match(refusalMessage(409, 'PROPOSAL_CLOSED', 'x'), /already decided/);
  assert.match(refusalMessage(403, 'SELF_ACCEPT', 'x'), /your own proposal/);
  assert.equal(refusalMessage(500, undefined, null), 'The request failed (HTTP 500).');
});

test('viewerDiff adds the git header DiffViewer parses, once, and keeps an empty diff empty', () => {
  assert.equal(viewerDiff('', 'x.md'), '');
  assert.match(viewerDiff('--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y', 'rb.md'), /^diff --git a\/rb.md b\/rb.md\n--- a/);
  assert.equal(viewerDiff('diff --git a/x b/x\n--- a', 'rb.md').match(/diff --git/g)!.length, 1);
});

test('tab parsing falls back to read', () => {
  assert.equal(parseTab('history'), 'history');
  assert.equal(parseTab('nonsense'), 'read');
  assert.equal(parseTab(null), 'read');
});

// redirect model: every retired /iq/distillation path redirects into runbooks.
test('runbooks redirect: every /iq/distillation path lands on a runbooks page', () => {
  assert.equal(distillationRedirect('/iq/distillation/review', '?view=promotions'), '/iq/runbooks/proposals');
  assert.equal(distillationRedirect('/iq/distillation/knowledge', '?item=art-010'), '/iq/runbooks/rb-tenant-cutover');
  for (const [path, search] of [['/iq/distillation', ''], ['/iq/distillation/knowledge', '?view=notes'], ['/iq/distillation/activity', '?view=graph'], ['/iq/distillation/tiers', ''], ['/iq/distillation/knowledge', '?item=art-007']] as const) {
    assert.equal(distillationRedirect(path, search), '/iq/runbooks', `${path}${search}`);
  }
});

test('ids resolve to names; what nothing resolves reads as a plain description, never the id', () => {
  const names = buildNames({
    people: [{ id: 'p-011', name: 'Eli Garcia' }],
    initiatives: [{ id: 'p-auth-migration', name: 'Auth Migration' }],
    jobs: [{ id: 'job-auth-maint-2', title: 'auth-dep-watch' }],
    runbooks: [{ id: 'rb-a', title: 'Cut over' }],
  });
  assert.equal(names.person('p-011'), 'Eli Garcia');
  assert.equal(names.person('p-999'), 'A colleague');
  assert.equal(names.initiative('p-auth-migration'), 'Auth Migration');
  assert.equal(names.run('job-auth-maint-2'), 'auth-dep-watch run');
  assert.equal(names.run('job:job-auth-maint-2'), 'auth-dep-watch run');
  assert.equal(names.run('sess-auth-06'), 'A session run');
  assert.equal(names.runbook('rb-zzz'), 'A runbook');
  const all = [rb('rb-a', 'initiative', 'p-auth-migration')];
  assert.equal(libraryRows(all, '', null, names)[0]!.subline, 'Auth Migration · v2');
  assert.equal(libraryRows(all, 'auth migration', null, names).length, 1);
  const p: Proposal = {
    id: 'prop-1', kind: 'edit', runbook_id: 'rb-a', base_version: 1, proposed: null, rationale: '',
    source: { kind: 'person', person_id: 'p-011', lab_experience_ids: [] }, lint: [], similar: [], status: 'open',
    decided_by: null, decided_at: null, note: null, merged_into: null, created_at: '',
  };
  assert.equal(proposalRows([p], new Map(), '', names)[0]!.subline, 'Edit · Eli Garcia');
});

test('the task title comes from the brief markdown', () => {
  assert.equal(briefTaskTitle('# Brief\n\n## Your task\n**Tenant-by-tenant cutover** (story, 3 pts)\nbody'), 'Tenant-by-tenant cutover');
  assert.equal(briefTaskTitle('## The project\n**Auth**'), null);
  // Assembler v3: the task sits inside the untrusted-text fence, one tag line below the heading.
  assert.equal(briefTaskTitle(`## Your task\n<untrusted-${'a'.repeat(32)} kind="work-item" source="wi-1">\n**Tenant-by-tenant cutover** (story, 3 pts)\nbody`), 'Tenant-by-tenant cutover');
});

test('file helpers format sizes, modes, languages and the diff summary', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(812), '812 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(2 * 1024 * 1024), '2.0 MB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(fileModeLabel('755'), 'script');
  assert.equal(fileModeLabel('644'), 'file');
  assert.equal(fileLanguageLabel('scripts/run.sh'), 'Shell');
  assert.equal(fileLanguageLabel('SKILL.md'), 'Markdown');
  assert.equal(fileLanguageLabel('Makefile'), 'Text');
  assert.equal(shortSha('a'.repeat(64)).length, 12);
  assert.equal(SECTION_KIND_LABEL['skill_library'], 'Org skills');
  assert.equal(filesDiffSummary({ added: 12, removed: 3, files: [{ status: 'added' }, { status: 'modified' }, { status: 'unchanged' }] }), '+12 −3 · 2 files (1 added, 1 modified)');
  assert.equal(filesDiffSummary({ added: 1, removed: 0, files: [{ status: 'added' }] }), '+1 −0 · 1 file (1 added)');
});

test('the evidence line gives every figure with its count', () => {
  const e = { windowDays: 30, since: '', runs: 13, runsGiven: 12, runsSaidFollowed: 4, runsSaidFollowedDone: 3,
    proposalsFromRuns: { total: 6, open: 2, accepted: 3, rejected: 0, merged: 0, withdrawn: 1 }, runbooks: [] };
  const lines = evidenceSentences(e);
  assert.equal(lines[0], 'In the last 30 days 12 of 13 runs were given a runbook.');
  assert.equal(lines[1], '4 of those 12 said they followed one, and 3 of those 4 finished done.');
  assert.match(lines[2]!, /2 open, 3 accepted, 0 rejected, 1 withdrawn or expired \(6 filed\)/);
  assert.deepEqual(evidenceSentences({ ...e, runs: 0, runsGiven: 0, runsSaidFollowed: 0, runsSaidFollowedDone: 0 })[0], 'In the last 30 days no run has reported.');
});

test('a runbook\'s evidence adds the comparison only when the read returned one', () => {
  const base = { runbookId: 'rb-a', windowDays: 30, since: '', given: 2, followed: { yes: 1, partly: 0, no: 1, unsaid: 0 }, loaded: 1,
    outcomes: { done: 2, failed: 0, cancelled: 0, 'needs-review': 0 }, followedDone: 1, runs: [],
    comparison: { available: false as const, reason: 'x', withRunbookRuns: 2, withoutRunbookRuns: 0 } };
  assert.equal(runbookEvidenceSentences(base).length, 2);
  const side = { runs: 5, medianDurationS: 600, meanCostUsd: 0.5, costRuns: 5 };
  const withComparison = runbookEvidenceSentences({ ...base, comparison: { available: true, withRunbook: side, withoutRunbook: { ...side, medianDurationS: 1200 }, sharedLabels: [] } });
  assert.equal(withComparison.length, 3);
  assert.match(withComparison[2]!, /median time 10 min with it \(5 runs\) and 20 min without it/);
  assert.equal(runbookEvidenceSentences({ ...base, given: 0 })[0], 'No run in the last 30 days was given this runbook.');
});

test('scope in words, widening, expiry and the proposal filters', () => {
  const names = buildNames({ initiatives: [{ id: 'p-a', name: 'Auth Migration' }] });
  assert.equal(scopeInWords({ kind: 'repo', ref: 'acme/auth' }, names), 'This runbook will be given to runs in the repository acme/auth.');
  assert.equal(scopeInWords({ kind: 'initiative', ref: 'p-a' }, names), 'This runbook will be given to runs on the initiative Auth Migration.');
  assert.equal(sameScope({ kind: 'org', ref: null }, { kind: 'org', ref: null }), true);
  assert.equal(sameScope({ kind: 'repo', ref: 'a/b' }, { kind: 'org', ref: null }), false);
  assert.equal(proposalStatusLabel({ status: 'open', expired: true }), 'Expired');
  assert.equal(proposalStatusLabel({ status: 'withdrawn', expired: false, closed_reason: 'expired' }), 'Expired');
  assert.equal(proposalStatusLabel({ status: 'accepted', expired: false }), 'Accepted');
  const mk = (id: string, kind: Proposal['kind'], source: Proposal['source']['kind'], status: Proposal['status']) => ({ id, kind, source: { kind: source, lab_experience_ids: [] }, status }) as unknown as Proposal;
  const all = [mk('1', 'new', 'run', 'open'), mk('2', 'retire', 'system', 'open'), mk('3', 'edit', 'person', 'accepted')];
  assert.deepEqual(filterProposals(all, { kind: 'retire', source: null, status: null }).map((p) => p.id), ['2']);
  assert.deepEqual(filterProposals(all, { kind: null, source: 'run', status: 'open' }).map((p) => p.id), ['1']);
  assert.equal(filterProposals(all, { kind: null, source: null, status: null }).length, 3);
});

test('a hand-written runbook becomes a new proposal with its scope, or names what is missing', () => {
  const draft = { name: 'Rerun a flaky test', description: 'Rerun it with the diff applied.', scopeKind: 'repo' as const, scopeRef: ' acme/api ', body: NEW_RUNBOOK_BODY_STARTER, rationale: 'Worth keeping.' };
  const ok = newRunbookRequest(draft);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.body['kind'], 'new');
    assert.deepEqual(ok.body['scope'], { kind: 'repo', ref: 'acme/api' });
    assert.match(String(ok.body['markdown']), /^# Rerun a flaky test\n\nRerun it with the diff applied\.\n\n## Use when/);
  }
  assert.deepEqual(newRunbookRequest({ ...draft, name: ' ' }), { ok: false, error: 'Give the runbook a name.' });
  assert.deepEqual(newRunbookRequest({ ...draft, scopeKind: 'initiative', scopeRef: '' }), { ok: false, error: 'Choose the initiative it applies to.' });
  assert.deepEqual(newRunbookRequest({ ...draft, rationale: '' }), { ok: false, error: 'Say why this runbook is worth keeping.' });
});
