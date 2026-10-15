// Run with:  cd portal && node --test src/pages/runbooks/__tests__/runbooksModel.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  briefGroups, briefRefOfRun, briefRows, distillationRedirect, libraryCommandAdapter, libraryGroups, libraryRows, parseTab,
  proposalGroups, proposalRows, refusalMessage, stepMarkers, viewerDiff,
} from '../runbooksModel.ts';
import type { BriefSummary, Proposal, RunbookApplication, RunbookRow } from '../types.ts';

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
  assert.equal(rows[0]!.subline, 'Edit · Run job-9');
  assert.equal(rows[1]!.title, 'Cut over');
});

test('briefs list newest day first; a run page maps to its brief ref only for jobs', () => {
  const b = (run: string, at: string): BriefSummary => ({ id: `brief-${run}`, run_ref: run, work_item_id: 'wi-1', initiative_id: null, repo: null, assembled_at: at, assembler_version: '1', budget_tokens: 6000, used_tokens: 10, sections: [{ kind: 'runbook', ref: 'rb-a', tokens: 5, reason: '' }], omitted: [], sha256: 'b'.repeat(64) });
  const rows = briefRows([b('job-1', '2026-10-12T00:00:00Z'), b('job-2', '2026-10-13T00:00:00Z')]);
  assert.deepEqual(briefGroups(rows).map((g) => g.id), ['2026-10-13', '2026-10-12']);
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
