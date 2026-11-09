// G54: a waiting decision can be decided on its record page, and a settled
// one says what was decided. The owner's two cases: d-eval-judge-model ("Judge
// model for canary evaluation", open, on the LLM Application Platform, decided
// by Nina Rivera) shows the Decide card only with can('DecideDecision'), while
// it waits, and when the server says this viewer may decide it; once decided
// it reads "Decided <when> by <who>: <outcome>", the history names who and
// why, and the Waiting view drops it. d-otel-vendor (resolved six days ago by
// Nora DaSilva) read as a date and nothing else; it now reads its outcome.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RATIONALE_MAX, decideBody, decisionPageContext, filterDecisions, historyOf, matchesDecision, outcomeFirstLine, outcomeLine, showDecideControl,
  sortDecisions, standingLine, waitingNotice,
} from '../decisionFormat.ts';
import { pageContextNote } from '../../../lib/voice/pageContext.ts';
import type { DecisionDetail, DecisionSummary } from '../types';

const RATIONALE = 'Go with Nova Pro and halve the sample rate from 20 to 10 percent.';
const JUDGE: DecisionDetail = {
  id: 'd-eval-judge-model', topic: 'Judge model for canary evaluation',
  summary: 'The canary judge scores every sampled answer…', status: 'open', projectId: 'p-llm-platform', decidedAt: null,
  participants: [
    { personId: 'p-047', name: 'Nina Rivera', title: 'Staff ML Engineer', role: 'decider', weight: 1 },
    { personId: 'p-042', name: 'Rhea', title: null, role: 'contributor', weight: 1 },
  ],
  decidedBy: null, outcome: null, history: [], viewerMayDecide: true,
};
/** What the route answers once Nina resolves it. */
const DECIDED: DecisionDetail = {
  ...JUDGE, status: 'resolved', decidedAt: '2026-11-09', decidedBy: { id: 'p-047', name: 'Nina Rivera' }, outcome: RATIONALE,
  history: [{ id: '1', kind: 'resolved', at: '2026-11-09T01:40:00Z', by: { id: 'p-047', name: 'Nina Rivera' }, rationale: RATIONALE }],
};
const holds = (...actions: string[]) => (a: string) => actions.includes(a);

test('the Decide control shows only with DecideDecision, while open or escalated, and when the server lets this viewer decide', () => {
  assert.equal(showDecideControl(JUDGE, holds('DecideDecision')), true);
  assert.equal(showDecideControl({ ...JUDGE, status: 'escalated' }, holds('DecideDecision')), true);
  assert.equal(showDecideControl(JUDGE, holds()), false, 'no capability, no control');
  assert.equal(showDecideControl({ ...JUDGE, viewerMayDecide: false }, holds('DecideDecision')), false, 'a contributor sees no control');
  assert.equal(showDecideControl({ ...JUDGE, viewerMayDecide: undefined }, holds('DecideDecision')), true, 'an older server: the route decides');
  for (const status of ['resolved', 'rejected']) assert.equal(showDecideControl({ ...DECIDED, status }, holds('DecideDecision')), false, status);
});

test('the body: the outcome and a trimmed rationale, required, at most 500 characters', () => {
  assert.deepEqual(decideBody('resolved', `  ${RATIONALE} `), { body: { outcome: 'resolved', rationale: RATIONALE } });
  assert.deepEqual(decideBody('rejected', 'Neither yet.'), { body: { outcome: 'rejected', rationale: 'Neither yet.' } });
  assert.ok('error' in decideBody('resolved', '   '));
  assert.ok('body' in decideBody('resolved', 'x'.repeat(RATIONALE_MAX)));
  const long = decideBody('resolved', 'x'.repeat(RATIONALE_MAX + 1));
  assert.ok('error' in long && /500/.test(long.error));
});

const rel = (iso: string) => `rel(${iso})`;

test('decided: the record reads "Decided <when> by <who>: <outcome>", and the history says who, when and why', () => {
  assert.equal(outcomeLine(JUDGE, rel), null, 'a waiting decision has no outcome line');
  assert.equal(outcomeLine(DECIDED, rel), `Decided rel(2026-11-09T12:00:00Z) by Nina Rivera: ${RATIONALE}`);
  assert.equal(outcomeLine({ ...DECIDED, status: 'rejected' }, rel), `Rejected rel(2026-11-09T12:00:00Z) by Nina Rivera: ${RATIONALE}`);
  assert.equal(outcomeLine({ status: 'resolved', outcome: null, decidedAt: '2026-01-01', decidedBy: null }, rel), null);
  const ev = historyOf(DECIDED, null, 'LLM Application Platform');
  assert.deepEqual(ev.map((e) => e.id), ['event-1', 'raised'], 'the recorded call replaces the column-derived one');
  assert.equal(ev[0]!.label, 'Decided');
  assert.equal(ev[0]!.at, '2026-11-09T01:40:00Z');
  assert.equal(ev[0]!.detail, `Nina Rivera decided: ${RATIONALE}`);
  assert.equal(standingLine(DECIDED, DECIDED.decidedBy!.name, (iso) => iso), 'Decided by Nina Rivera 2026-11-09T12:00:00Z');
});

test('the list\'s Waiting view drops the decision once it is decided', () => {
  const row = (d: DecisionDetail): DecisionSummary => ({ id: d.id, topic: d.topic, summary: d.summary, status: d.status, projectId: d.projectId, decidedAt: d.decidedAt, participantCount: 2 });
  const other: DecisionSummary = { id: 'd-cognito-cutover', topic: 'Cutover order', summary: null, status: 'escalated', projectId: 'p-auth-migration', decidedAt: null, participantCount: 5 };
  assert.deepEqual(filterDecisions(sortDecisions([row(JUDGE), other]), 'waiting').map((d) => d.id), ['d-cognito-cutover', 'd-eval-judge-model']);
  assert.deepEqual(filterDecisions(sortDecisions([row(DECIDED), other]), 'waiting').map((d) => d.id), ['d-cognito-cutover']);
  assert.deepEqual(filterDecisions([row(DECIDED), other], 'resolved').map((d) => d.id), ['d-eval-judge-model']);
});

test('the record publishes itself for the voice, and offers decide only to someone who may decide', () => {
  const path = '/iq/decisions/d-eval-judge-model';
  const page = decisionPageContext(JUDGE, path, true);
  assert.deepEqual(page.record, { ref: 'decision:d-eval-judge-model', title: 'Judge model for canary evaluation' });
  assert.deepEqual(page.rows, [{ ref: 'decision:d-eval-judge-model', title: 'Judge model for canary evaluation', status: 'open', href: path }]);
  const note = pageContextNote({ tenant: 'orgiq', pathname: path, pageId: 'decisions', page });
  assert.match(note, /Offered here: This decision is waiting on you: say decide to resolve or reject it \(decide ref decision:d-eval-judge-model, scope this-page/);
  assert.doesNotMatch(pageContextNote({ tenant: 'orgiq', pathname: path, pageId: 'decisions', page: decisionPageContext(DECIDED, path, false) }), /Offered here/);
});

test('a waiting decision the viewer cannot decide says who it waits on, in the page and in the voice offer', () => {
  const path = '/iq/decisions/d-eval-judge-model';
  const notice = waitingNotice(JUDGE)!;
  assert.equal(notice.line, 'Waiting on Nina Rivera. Only Nina, the initiative’s owner or an org-leader can decide this.');
  assert.equal(notice.personId, 'p-047');
  assert.equal(waitingNotice({ ...JUDGE, status: 'escalated' })!.name, 'Nina Rivera');
  assert.equal(waitingNotice(DECIDED), null, 'settled: nothing is waiting');
  const none = waitingNotice({ status: 'open', participants: [] })!;
  assert.match(none.line, /^Waiting on an unassigned decider\./);
  assert.equal(none.personId, null);
  const offer = decisionPageContext(JUDGE, path, false).offer!;
  assert.equal(offer, 'This decision waits on Nina Rivera; you cannot decide it. Say message Nina Rivera to ask about it.');
  assert.doesNotMatch(offer, /say decide/i, 'never the decide offer');
  assert.equal(decisionPageContext(DECIDED, path, false).offer, null, 'settled: no offer');
  assert.equal(decisionPageContext({ id: JUDGE.id, topic: JUDGE.topic, status: 'open' }, path, false).offer, null, 'no participants read yet: no offer');
});

// The owner's second case, as GET /api/graph/decisions/d-otel-vendor answers it on the mock.
const OTEL_VENDOR: DecisionDetail = {
  id: 'd-otel-vendor', topic: 'Self-hosted OTel collectors over vendor agents',
  summary: 'Vendor APM agents were quoted per host at about three times the cost… We chose self-hosted OpenTelemetry collectors…',
  status: 'resolved', projectId: 'p-observability', decidedAt: '2026-11-03',
  participants: [{ personId: 'p-004', name: 'Nora DaSilva', title: null, role: 'decider', weight: 1 }],
  decidedBy: { id: 'p-004', name: 'Nora DaSilva' },
  outcome: 'Self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend.',
  history: [], viewerMayDecide: true,
};

test('a settled decision (d-otel-vendor) reads what was decided, when and by whom, and offers no Decide control', () => {
  assert.equal(outcomeLine(OTEL_VENDOR, rel),
    'Decided rel(2026-11-03T12:00:00Z) by Nora DaSilva: Self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend.');
  assert.equal(showDecideControl(OTEL_VENDOR, holds('DecideDecision')), false, 'settled: no control even for its decider');
  assert.equal(decisionPageContext(OTEL_VENDOR, '/iq/decisions/d-otel-vendor', false).offer, null);
  // Its history, with no recorded call, still names the decider from the columns.
  assert.deepEqual(historyOf(OTEL_VENDOR, null, 'Observability').map((e) => e.id), ['settled', 'raised']);
});

test('the list shows a settled row\'s outcome, first line only, and searches it; a waiting row shows none', () => {
  const row = (d: DecisionDetail): DecisionSummary => ({ id: d.id, topic: d.topic, summary: d.summary, status: d.status, projectId: d.projectId, decidedAt: d.decidedAt, outcome: d.outcome ?? null, participantCount: 1 });
  assert.equal(outcomeFirstLine(row(OTEL_VENDOR)), OTEL_VENDOR.outcome);
  assert.equal(outcomeFirstLine({ status: 'resolved', outcome: '\n  First line.\nSecond line.' }), 'First line.');
  assert.equal(outcomeFirstLine(row(JUDGE)), null);
  assert.equal(outcomeFirstLine({ status: 'open', outcome: 'stale text' }), null, 'a waiting row never shows an outcome');
  assert.equal(matchesDecision(row(OTEL_VENDOR), 'gateway topology'), true);
});
