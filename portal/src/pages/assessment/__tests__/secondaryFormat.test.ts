// Run with:  cd portal && node --test 'src/pages/assessment/__tests__/secondaryFormat.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyRunEvent,
  countPendingLinks,
  feedbackActionPath,
  formatDuration,
  formatRelativeTime,
  groupSubmissions,
  launchResponseMessage,
  linksStepComplete,
  parseFormsCsv,
  pendingLinksBanner,
  resolveRowStatusDisplay,
  resolveTeamName,
  revisionLabel,
  revisionNumber,
  splitOpenFeedback,
} from '../secondaryFormat.ts';
import type { FeedbackTask, RunRecord, SubmissionGroupRef, SubmissionListItem } from '../secondaryTypes.ts';

// ─── parseFormsCsv ─────────────────────────────────────────────────────────────

test('parseFormsCsv: a plain header + data row', () => {
  const { headers, records } = parseFormsCsv('Id,Name\n1,Alice\n');
  assert.deepEqual(headers, ['Id', 'Name']);
  assert.deepEqual(records, [{ Id: '1', Name: 'Alice' }]);
});

test('parseFormsCsv: quoted field with an embedded comma', () => {
  const { records } = parseFormsCsv('Id,Note\n1,"a, b, c"\n');
  assert.deepEqual(records, [{ Id: '1', Note: 'a, b, c' }]);
});

test('parseFormsCsv: doubled quotes decode to a single literal quote', () => {
  const { records } = parseFormsCsv('Id,Quote\n1,"She said ""hi"""\n');
  assert.deepEqual(records, [{ Id: '1', Quote: 'She said "hi"' }]);
});

test('parseFormsCsv: a quoted field can embed a newline', () => {
  const { records } = parseFormsCsv('Id,Note\n1,"line one\nline two"\n2,plain\n');
  assert.deepEqual(records, [
    { Id: '1', Note: 'line one\nline two' },
    { Id: '2', Note: 'plain' },
  ]);
});

test('parseFormsCsv: CRLF line endings', () => {
  const { headers, records } = parseFormsCsv('Id,Name\r\n1,Alice\r\n2,Bob\r\n');
  assert.deepEqual(headers, ['Id', 'Name']);
  assert.deepEqual(records, [{ Id: '1', Name: 'Alice' }, { Id: '2', Name: 'Bob' }]);
});

test('parseFormsCsv: a leading UTF-8 BOM is stripped', () => {
  const { headers, records } = parseFormsCsv('﻿Id,Name\n1,Alice\n');
  assert.deepEqual(headers, ['Id', 'Name']);
  assert.deepEqual(records, [{ Id: '1', Name: 'Alice' }]);
});

test('parseFormsCsv: no trailing newline still captures the last row', () => {
  const { records } = parseFormsCsv('Id,Name\n1,Alice');
  assert.deepEqual(records, [{ Id: '1', Name: 'Alice' }]);
});

test('parseFormsCsv: a trailing newline does not manufacture a bogus empty row', () => {
  const { records } = parseFormsCsv('Id,Name\n1,Alice\n2,Bob\n');
  assert.equal(records.length, 2);
});

test('parseFormsCsv: empty input yields no headers and no records', () => {
  const { headers, records } = parseFormsCsv('');
  assert.deepEqual(headers, []);
  assert.deepEqual(records, []);
});

test('parseFormsCsv: header-only input yields no records', () => {
  const { headers, records } = parseFormsCsv('Id,Name\n');
  assert.deepEqual(headers, ['Id', 'Name']);
  assert.deepEqual(records, []);
});

test('parseFormsCsv: a short row backfills missing trailing columns with empty strings', () => {
  const { records } = parseFormsCsv('Id,Name,Email\n1,Alice\n');
  assert.deepEqual(records, [{ Id: '1', Name: 'Alice', Email: '' }]);
});

// ─── formatRelativeTime ───────────────────────────────────────────────────────

test('formatRelativeTime: just now for the last minute', () => {
  assert.equal(formatRelativeTime(new Date(Date.now() - 5_000).toISOString()), 'just now');
});

test('formatRelativeTime: minutes, hours, days', () => {
  assert.equal(formatRelativeTime(new Date(Date.now() - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(formatRelativeTime(new Date(Date.now() - 3 * 3600_000).toISOString()), '3h ago');
  assert.equal(formatRelativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString()), '2d ago');
});

test('formatRelativeTime: missing or unparsable input is an em dash, never a crash', () => {
  assert.equal(formatRelativeTime(null), '—');
  assert.equal(formatRelativeTime(undefined), '—');
  assert.equal(formatRelativeTime('not-a-date'), '—');
});

// ─── formatDuration ───────────────────────────────────────────────────────────

test('formatDuration: minutes and seconds between two timestamps', () => {
  const start = '2026-01-01T00:00:00.000Z';
  const finish = '2026-01-01T00:04:07.000Z';
  assert.equal(formatDuration(start, finish), '4m 07s');
});

test('formatDuration: no finish time yet is an em dash, not "0m 00s"', () => {
  assert.equal(formatDuration('2026-01-01T00:00:00.000Z', null), '—');
  assert.equal(formatDuration('2026-01-01T00:00:00.000Z', undefined), '—');
});

test('formatDuration: unparsable or backwards timestamps are an em dash', () => {
  assert.equal(formatDuration('garbage', '2026-01-01T00:00:00.000Z'), '—');
  assert.equal(formatDuration('2026-01-01T00:04:00.000Z', '2026-01-01T00:00:00.000Z'), '—');
});

// ─── revisionNumber / revisionLabel ───────────────────────────────────────────

test('revisionNumber: base envelope is revision 1', () => {
  assert.equal(revisionNumber('sub-20260101T000000Z-form1-jdoe'), 1);
});

test('revisionNumber: -rN suffix is the revision', () => {
  assert.equal(revisionNumber('sub-20260101T000000Z-form1-jdoe-r2'), 2);
  assert.equal(revisionNumber('sub-20260101T000000Z-form1-jdoe-r14'), 14);
});

test('revisionLabel: original vs rN', () => {
  assert.equal(revisionLabel('sub-x-form1-jdoe'), 'original');
  assert.equal(revisionLabel('sub-x-form1-jdoe-r3'), 'r3');
});

// ─── groupSubmissions ─────────────────────────────────────────────────────────

function row(over: Partial<SubmissionListItem>): SubmissionListItem {
  return {
    envelope_id: 'sub-x-form1-jdoe',
    team_id: 'TEAM-001',
    team_name_raw: 'Team One',
    submitter_name: 'J Doe',
    submitted_at: '2026-01-01T00:00:00.000Z',
    ingested_at: '2026-01-01T00:00:00.000Z',
    links_pending: 0,
    links_total: 0,
    scored: false,
    form_id: '1',
    ...over,
  };
}

test('groupSubmissions: a single envelope with no revisions is its own group', () => {
  const rows = [row({})];
  const groups = groupSubmissions(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].current.envelope_id, 'sub-x-form1-jdoe');
  assert.equal(groups[0].superseded.length, 0);
  assert.equal(groups[0].revisionCount, 1);
});

test('groupSubmissions: derives revision grouping from rows when the API sends no groups', () => {
  const base = row({ envelope_id: 'sub-x-form1-jdoe', ingested_at: '2026-01-01T00:00:00.000Z', scored: true });
  const r2 = row({
    envelope_id: 'sub-x-form1-jdoe-r2',
    ingested_at: '2026-01-02T00:00:00.000Z',
    scored: false,
  });
  const groups = groupSubmissions([base, r2]);
  assert.equal(groups.length, 1);
  const group = groups[0];
  // The newest revision is current; the status shown is ITS status, not the original's.
  assert.equal(group.current.envelope_id, 'sub-x-form1-jdoe-r2');
  assert.equal(group.processed, false);
  assert.equal(group.superseded.length, 1);
  assert.equal(group.superseded[0].envelope_id, 'sub-x-form1-jdoe');
  assert.equal(group.revisionCount, 2);
});

test('groupSubmissions: uses the API-provided groups when present, ignoring row order', () => {
  const base = row({ envelope_id: 'sub-x-form1-jdoe', scored: true });
  const r2 = row({ envelope_id: 'sub-x-form1-jdoe-r2', scored: false });
  const apiGroups: SubmissionGroupRef[] = [
    {
      group_id: 'sub-x-form1-jdoe',
      team_id: 'TEAM-001',
      team_name_raw: 'Team One',
      form_id: '1',
      envelope_ids: ['sub-x-form1-jdoe-r2', 'sub-x-form1-jdoe'],
      processed: false,
    },
  ];
  const groups = groupSubmissions([base, r2], apiGroups);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].current.envelope_id, 'sub-x-form1-jdoe-r2');
  assert.equal(groups[0].superseded[0].envelope_id, 'sub-x-form1-jdoe');
});

test('groupSubmissions: different teams/forms never collapse into one group', () => {
  const a = row({ envelope_id: 'sub-a-form1-jdoe', team_id: 'TEAM-001', form_id: '1' });
  const b = row({ envelope_id: 'sub-b-form2-asmith', team_id: 'TEAM-002', form_id: '2' });
  const groups = groupSubmissions([a, b]);
  assert.equal(groups.length, 2);
});

// ─── resolveTeamName ────────────────────────────────────────────────────────
// A hand-matched submission's `team_name_raw` is whatever the submitter
// typed BEFORE a person matched it to a real team — once `team_id` is known,
// the roster's name for it is the truth, and the raw text belongs on screen
// only when it's worth flagging as a discrepancy.

test('resolveTeamName: exact match — no secondary text', () => {
  const teamsById = new Map([['TEAM-007', 'Internal Tools']]);
  const resolved = resolveTeamName('TEAM-007', 'Internal Tools', teamsById);
  assert.equal(resolved.teamName, 'Internal Tools');
  assert.equal(resolved.submittedTeamName, null);
});

test('resolveTeamName: exact match is case/whitespace-insensitive', () => {
  const teamsById = new Map([['TEAM-007', 'Internal Tools']]);
  const resolved = resolveTeamName('TEAM-007', '  internal tools  ', teamsById);
  assert.equal(resolved.teamName, 'Internal Tools');
  assert.equal(resolved.submittedTeamName, null);
});

test('resolveTeamName: hand match with a differing submitted name shows the matched name, flags the submitted one', () => {
  const teamsById = new Map([['TEAM-007', 'Internal Tools']]);
  const resolved = resolveTeamName('TEAM-007', 'Ledger Reconciliation', teamsById);
  assert.equal(resolved.teamName, 'Internal Tools');
  assert.equal(resolved.submittedTeamName, 'Ledger Reconciliation');
});

test('resolveTeamName: no match falls back to the submitted text, with nothing to flag', () => {
  const teamsById = new Map([['TEAM-007', 'Internal Tools']]);
  const resolved = resolveTeamName('TEAM-999', 'Ledger Reconciliation', teamsById);
  assert.equal(resolved.teamName, 'Ledger Reconciliation');
  assert.equal(resolved.submittedTeamName, null);
});

test('resolveTeamName: no team_id at all also falls back to the submitted text', () => {
  const resolved = resolveTeamName(null, 'Unmatched Team', new Map());
  assert.equal(resolved.teamName, 'Unmatched Team');
  assert.equal(resolved.submittedTeamName, null);
});

test('groupSubmissions: resolves the matched team\'s real name via teamsById, flagging the submitted name', () => {
  const rows = [row({ envelope_id: 'sub-x-form1-jdoe', team_id: 'TEAM-007', team_name_raw: 'Ledger Reconciliation' })];
  const teamsById = new Map([['TEAM-007', 'Internal Tools']]);
  const groups = groupSubmissions(rows, undefined, teamsById);
  assert.equal(groups[0].teamName, 'Internal Tools');
  assert.equal(groups[0].submittedTeamName, 'Ledger Reconciliation');
});

// ─── resolveRowStatusDisplay ───────────────────────────────────────────────
// The step-2 preview table's chip must track the row's CURRENT match state,
// not just the raw parse-time status — a row that parsed in as
// `unknown_team` but has since been matched to a team (row.team_id set, or
// picked in the wizard's assignments map) is exactly as ready to commit as a
// `new`/`seen` row, and the chip must say so instead of still reading
// "Unknown team".

test('resolveRowStatusDisplay: unmatched unknown_team row stays the amber "Unknown team" chip', () => {
  const display = resolveRowStatusDisplay('unknown_team', false);
  assert.equal(display.label, 'Unknown team');
  assert.equal(display.tone, 'warning');
});

test('resolveRowStatusDisplay: an unknown_team row that has been matched to a team reads "Matched", not "Unknown team"', () => {
  const display = resolveRowStatusDisplay('unknown_team', true);
  assert.equal(display.label, 'Matched');
  assert.equal(display.tone, 'success');
});

test('resolveRowStatusDisplay: new/seen rows are unaffected by the match flag', () => {
  assert.deepEqual(resolveRowStatusDisplay('new', false), { label: 'New', tone: 'success' });
  assert.deepEqual(resolveRowStatusDisplay('new', true), { label: 'New', tone: 'success' });
  assert.deepEqual(resolveRowStatusDisplay('seen', false), { label: 'Seen', tone: 'neutral' });
  assert.deepEqual(resolveRowStatusDisplay('seen', true), { label: 'Seen', tone: 'neutral' });
});

// ─── launchResponseMessage ────────────────────────────────────────────────────

test('launchResponseMessage: 202 is success regardless of body', () => {
  const out = launchResponseMessage(202);
  assert.equal(out.ok, true);
});

test('launchResponseMessage: 400 surfaces the server detail when present', () => {
  const out = launchResponseMessage(400, 'Unknown command "foo"');
  assert.equal(out.ok, false);
  assert.equal(out.message, 'Unknown command "foo"');
});

test('launchResponseMessage: 400 falls back to a generic message with no detail', () => {
  const out = launchResponseMessage(400, undefined);
  assert.equal(out.ok, false);
  assert.match(out.message, /couldn't be started/i);
});

test('launchResponseMessage: 403 explains the auth requirement', () => {
  assert.match(launchResponseMessage(403).message, /authenticated operator/i);
});

test('launchResponseMessage: 409 says a run is already going for this team', () => {
  assert.match(launchResponseMessage(409).message, /already running/i);
});

test('launchResponseMessage: 429 names the concurrency cap', () => {
  assert.match(launchResponseMessage(429).message, /concurrency cap/i);
});

test('launchResponseMessage: an unmapped status still returns a message, never throws', () => {
  const out = launchResponseMessage(500, 'boom');
  assert.equal(out.ok, false);
  assert.equal(out.message, 'boom');
  const out2 = launchResponseMessage(503);
  assert.match(out2.message, /503/);
});

// ─── Wire envelope → list row ────────────────────────────────────────────────

import { envelopesToListItems } from '../secondaryFormat.ts';

test('envelopesToListItems maps the wire envelope onto the list row', () => {
  const rows = envelopesToListItems([{
    envelope_id: 'sub-20260828T101500Z-form12-sam-okafor-r2', team_id: 'TEAM-003', team_name_raw: 'Checkout Experience',
    submitter: { name: 'Sam Okafor' }, submitted_at: '8/28/2026 10:15', ingested_at: '2026-08-30T01:26:17.341Z',
    status: 'scored', revision: '2', source: { form_submission_id: 12 },
  }]);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.submitter_name, 'Sam Okafor');
  assert.equal(r.form_id, '12');
  assert.equal(r.revision, 2);
  assert.equal(r.scored, true);
  assert.equal(r.links_total, 0);
});

test('a missing submitter or form id degrades to a placeholder, not a crash', () => {
  const [r] = envelopesToListItems([{
    envelope_id: 'sub-x', team_id: 'TEAM-001', team_name_raw: 'N', submitter: null,
    submitted_at: '', ingested_at: '', status: 'staged',
  }]);
  assert.equal(r!.submitter_name, '—');
  assert.equal(r!.form_id, null);
  assert.equal(r!.scored, false);
});

// The wire keys a feedback task by `task_id`; reading `id` sent every
// Resolve/Dismiss to /feedback/undefined/… (a 404 on every click).
test('feedbackActionPath is keyed by the wire task_id', () => {
  assert.equal(feedbackActionPath({ task_id: 'fb-498e9969570b' }, 'resolve'), '/api/assessment/feedback/fb-498e9969570b/resolve');
  assert.equal(feedbackActionPath({ task_id: 'virtual-Q 1' }, 'dismiss'), '/api/assessment/feedback/virtual-Q%201/dismiss');
});

// ─── linksStepComplete / countPendingLinks / pendingLinksBanner ──────────────

test('linksStepComplete: true when every link across every result is resolved', () => {
  const results = [
    { links: [{ status: 'fetched' as const }, { status: 'skipped' as const }] },
    { links: [{ status: 'fetched' as const }] },
  ];
  assert.equal(linksStepComplete(results), true);
});

test('linksStepComplete: false while any single link is still pending', () => {
  const results = [
    { links: [{ status: 'fetched' as const }] },
    { links: [{ status: 'pending' as const }] },
  ];
  assert.equal(linksStepComplete(results), false);
});

test('linksStepComplete: an envelope with no links never blocks completion', () => {
  assert.equal(linksStepComplete([{ links: [] }]), true);
  assert.equal(linksStepComplete([]), true);
});

test('countPendingLinks: sums pending links across every result', () => {
  const results = [
    { links: [{ status: 'pending' as const }, { status: 'fetched' as const }] },
    { links: [{ status: 'pending' as const }] },
  ];
  assert.equal(countPendingLinks(results), 2);
  assert.equal(countPendingLinks([{ links: [{ status: 'fetched' as const }] }]), 0);
});

test('pendingLinksBanner: singular subject-verb agreement ("1 link ... needs")', () => {
  assert.equal(
    pendingLinksBanner(1),
    '1 link still needs to be marked fetched or skipped before processing.',
  );
});

test('pendingLinksBanner: plural subject-verb agreement ("2 links ... need")', () => {
  assert.equal(
    pendingLinksBanner(2),
    '2 links still need to be marked fetched or skipped before processing.',
  );
});

test('pendingLinksBanner: nothing pending returns an empty string', () => {
  assert.equal(pendingLinksBanner(0), '');
});

// ─── applyRunEvent (Runs page ← GET /events reducer) ─────────────────────────

test('applyRunEvent: run.started prepends a running row', () => {
  const runs = applyRunEvent([], { type: 'run.started', run_id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', ts: '2026-09-04T00:00:00.000Z' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.status, 'running');
  assert.equal(runs[0]!.id, 'run-1');
  assert.equal(runs[0]!.finished_at, null);
});

test('applyRunEvent: a replayed run.started never duplicates the row', () => {
  const existing: RunRecord[] = [{ id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', status: 'running', started_at: 't0', finished_at: null }];
  const runs = applyRunEvent(existing, { type: 'run.started', run_id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', ts: 't0' });
  assert.equal(runs.length, 1);
  assert.equal(runs, existing); // untouched, not even a shallow copy
});

test('applyRunEvent: run.progress updates only the matching row', () => {
  const existing: RunRecord[] = [
    { id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', status: 'running', started_at: 't0', finished_at: null },
    { id: 'run-2', command: 'validate-outputs', team_id: null, status: 'running', started_at: 't0', finished_at: null },
  ];
  const runs = applyRunEvent(existing, { type: 'run.progress', run_id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', percent: 60, ts: 't1' });
  assert.equal(runs.find((r) => r.id === 'run-1')!.progress?.detail, '60%');
  assert.equal(runs.find((r) => r.id === 'run-2')!.progress, undefined);
});

test('applyRunEvent: run.completed finalizes status, summary and clears progress', () => {
  const existing: RunRecord[] = [{ id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', status: 'running', started_at: 't0', finished_at: null, progress: { phase: 'running', detail: '90%' } }];
  const runs = applyRunEvent(existing, { type: 'run.completed', run_id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', summary: 'Scored 3 dimensions.', ts: 't2' });
  assert.equal(runs[0]!.status, 'completed');
  assert.equal(runs[0]!.finished_at, 't2');
  assert.equal(runs[0]!.summary, 'Scored 3 dimensions.');
  assert.equal(runs[0]!.progress, null);
});

test('applyRunEvent: run.failed records the reason as the error', () => {
  const existing: RunRecord[] = [{ id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', status: 'running', started_at: 't0', finished_at: null }];
  const runs = applyRunEvent(existing, { type: 'run.failed', run_id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', reason: 'stopped by operator', ts: 't2' });
  assert.equal(runs[0]!.status, 'failed');
  assert.equal(runs[0]!.error, 'stopped by operator');
});

test('applyRunEvent: a knowledge.* event (or any run for an unseen id) is a no-op', () => {
  const existing: RunRecord[] = [{ id: 'run-1', command: 'score-dimensions', team_id: 'TEAM-001', status: 'running', started_at: 't0', finished_at: null }];
  const runs = applyRunEvent(existing, { type: 'knowledge.pulled', section: 'ec', pages: 1, files_pulled: 1, ts: 't0' });
  assert.equal(runs, existing);
  const unaffected = applyRunEvent(existing, { type: 'run.progress', run_id: 'run-unknown', command: 'validate-outputs', team_id: null, percent: 10, ts: 't1' });
  assert.deepEqual(unaffected, existing);
});

// The Question queue counted every open task as an "Open question", which
// disagreed with the Assessor's-desk tile (25 vs 24) because that tile sums
// each team's `followups_open` — follow-ups only. These pin the split, not
// the numbers: the point is that a decision the assessor owes never lands in
// the count of questions a team owes.
const task = (over: Partial<FeedbackTask>): FeedbackTask => ({
  task_id: 't1', team_id: 'TEAM-001', kind: 'follow_up', status: 'OPEN',
  question: 'q', created_at: '2026-09-17T00:00:00.000Z',
  ...over,
} as FeedbackTask);

test('splitOpenFeedback counts follow-ups as questions and everything else as decisions', () => {
  const { questions, decisions } = splitOpenFeedback([
    task({ task_id: 'a' }),
    task({ task_id: 'b' }),
    task({ task_id: 'c', kind: 'exception_review' }),
  ]);
  assert.equal(questions.length, 2);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.task_id, 'c');
});

test('splitOpenFeedback ignores anything not OPEN, in both buckets', () => {
  const { questions, decisions } = splitOpenFeedback([
    task({ task_id: 'a', status: 'RESOLVED' }),
    task({ task_id: 'b', status: 'DISMISSED', kind: 'exception_review' }),
    task({ task_id: 'c' }),
  ]);
  assert.equal(questions.length, 1);
  assert.equal(decisions.length, 0);
});

test('teamsWithOpenQuestions counts teams with QUESTIONS, not teams with any open task', () => {
  // The regression: a team whose only open item is an exception review used to
  // inflate the "across N teams" hint beside a count it contributes nothing to.
  const { teamsWithOpenQuestions } = splitOpenFeedback([
    task({ task_id: 'a', team_id: 'TEAM-001' }),
    task({ task_id: 'b', team_id: 'TEAM-002', kind: 'exception_review' }),
  ]);
  assert.equal(teamsWithOpenQuestions, 1);
});

test('a manually assigned team already holding this form reads Seen', () => {
  assert.deepEqual(resolveRowStatusDisplay('unknown_team', true, true), { label: 'Seen', tone: 'neutral' });
});
