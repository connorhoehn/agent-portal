import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NewerVersionError, acceptDraft, acceptPayload, canRevise, isNewer, reviseDraft, agentRunStatusOf, canAccept, discardDraft, factsLine, fetchDraft, isLive, isTerminal, listDrafts,
  pollDelayMs, startDraft, summaryMarkdown, toggleIndex, type DraftView, type FollowupsDraft, type SummaryDraft,
} from '../evidenceDrafts.ts';

const facts = { verifiedLevel: 2, claimedLevel: 3, targetLevel: 3, openClaim: true, evidenceCount: 1 };
const followups: FollowupsDraft = {
  kind: 'followups', teamId: 'TEAM-001', dimensionId: '7', dimensionTitle: 'Release', facts, summary: 's', fallback: false,
  questions: [{ text: 'A?', criterionId: 'c1', criterionText: 'x', sourceSpans: [] }, { text: 'B?', criterionId: null, criterionText: null, sourceSpans: [] }],
};
const view = (over: Partial<DraftView> = {}): DraftView => ({
  runId: 'adr-1', kind: 'assessment.followup-drafts', teamId: 'TEAM-001', dimensionId: '7', phase: 'completed', steps: [],
  result: followups, error: null, decision: null, createdFollowUpIds: [], createdAt: '', updatedAt: '', revision: 1, requestedBy: 'u-a', revisedBy: null, ...over,
});

function fakeFetch(status: number, body: unknown, calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('start posts to the dimension route for each kind and surfaces the server error', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  assert.deepEqual(await startDraft('TEAM-001', '7', 'summary', fakeFetch(202, { runId: 'adr-1' }, calls)), { runId: 'adr-1' });
  await startDraft('TEAM-001', '7', 'followups', fakeFetch(202, { runId: 'adr-2' }, calls));
  assert.equal(calls[0]!.url, '/api/assessment/teams/TEAM-001/dimensions/7/drafts/evidence-summary');
  assert.equal(calls[1]!.url, '/api/assessment/teams/TEAM-001/dimensions/7/drafts/followups');
  assert.equal(calls[0]!.init?.method, 'POST');
  await assert.rejects(startDraft('TEAM-001', '7', 'summary', fakeFetch(429, { error: 'Wait for your running drafts to finish' })), /Wait for your running/);
  await assert.rejects(startDraft('TEAM-001', '7', 'summary', fakeFetch(403, {})), /permission/);
});

test('list, read, accept and discard use the draft routes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  assert.deepEqual(await listDrafts('TEAM-001', '7', fakeFetch(200, { drafts: [view()] }, calls)), [view()]);
  await fetchDraft('adr-1', fakeFetch(200, view(), calls));
  await acceptDraft('adr-1', [0], undefined, fakeFetch(200, { created: [], skipped: [] }, calls));
  await acceptDraft('adr-1', undefined, undefined, fakeFetch(200, { created: [], skipped: [] }, calls));
  await discardDraft('adr-1', fakeFetch(200, { ok: true }, calls));
  assert.deepEqual(calls.map(c => c.url), [
    '/api/assessment/teams/TEAM-001/dimensions/7/drafts', '/api/assessment/drafts/adr-1',
    '/api/assessment/drafts/adr-1/accept', '/api/assessment/drafts/adr-1/accept', '/api/assessment/drafts/adr-1/discard',
  ]);
  assert.equal(calls[2]!.init?.body, JSON.stringify({ indices: [0] }));
  assert.equal(calls[3]!.init?.body, '{}');
  await assert.rejects(acceptDraft('adr-1', [0], undefined, fakeFetch(409, { error: 'This draft was already accepted' })), /already accepted/);
});

test('terminal phases, poll cadence and recovery filter', () => {
  assert.equal(isTerminal(view({ phase: 'running' })), false);
  assert.equal(isTerminal(view({ phase: 'failed' })), true);
  assert.ok(pollDelayMs(0) < pollDelayMs(5) && pollDelayMs(1000) <= 2500);
  assert.equal(isLive(view()), true);
  assert.equal(isLive(view({ decision: 'discarded' })), false);
  assert.equal(isLive(view({ decision: 'accepted' })), true);
  assert.equal(isLive(view({ kind: 'assessment.evidence-summary', decision: 'accepted' })), false);
});

test('accept is offered only for a finished, undecided follow-up draft with questions', () => {
  assert.equal(canAccept(view()), true);
  assert.equal(canAccept(view({ phase: 'running', result: null })), false);
  assert.equal(canAccept(view({ decision: 'accepted' })), false);
  assert.equal(canAccept(view({ result: { ...followups, questions: [] } })), false);
  const summary: SummaryDraft = { kind: 'summary', teamId: 't', dimensionId: '7', dimensionTitle: 'R', facts, summary: 's', fallback: false, bullets: [] };
  assert.equal(canAccept(view({ kind: 'assessment.evidence-summary', result: summary })), false);
});

test('selection toggles in order and an all-selected accept sends no indices', () => {
  assert.deepEqual(toggleIndex([0, 2], 1), [0, 1, 2]);
  assert.deepEqual(toggleIndex([0, 1, 2], 1), [0, 2]);
  assert.equal(acceptPayload([0, 1], 2), undefined);
  assert.deepEqual(acceptPayload([1], 2), [1]);
});

test('numbers shown are the provider facts; summary text keeps each quote beside its bullet', () => {
  assert.equal(factsLine(facts), 'Verified L2 · claimed L3 · target L3 · 1 evidence item');
  assert.equal(factsLine({ ...facts, verifiedLevel: null, claimedLevel: null, evidenceCount: 3 }), 'Verified none · claimed none · target L3 · 3 evidence items');
  const md = summaryMarkdown({ kind: 'summary', teamId: 't', dimensionId: '7', dimensionTitle: 'R', facts, summary: 'Overview.', fallback: false,
    bullets: [{ text: 'CI runs.', sourceSpans: [{ evidenceId: 'EV-1', text: 'CI runs on every merge.' }] }] });
  assert.equal(md, 'Overview.\n\n- CI runs.\n  > "CI runs on every merge."');
  assert.equal(summaryMarkdown({ kind: 'summary', teamId: 't', dimensionId: '7', dimensionTitle: 'R', facts, summary: 'None yet.', fallback: true, bullets: [] }), 'None yet.');
});

test('run card status carries steps, the failure and the fallback note', () => {
  const steps = [{ id: 'a', label: 'Read', status: 'completed' as const }, { id: 'b', label: 'Write', status: 'running' as const }];
  const running = agentRunStatusOf(view({ phase: 'running', steps, result: null }));
  assert.equal(running.phase, 'running');
  assert.equal(running.stepLabel, 'Write');
  assert.match(agentRunStatusOf(view({ phase: 'failed', error: 'boom', result: null })).detail ?? '', /boom/);
  assert.match(agentRunStatusOf(view({ result: { ...followups, fallback: true } })).detail ?? '', /could not be verified/);
});

test('revise posts the base revision and request id; a 409 becomes the newer-version error', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  assert.deepEqual(await reviseDraft('adr-1', 'shorter', 1, 'req-00000001', fakeFetch(202, { revision: 2 }, calls)), { revision: 2 });
  assert.equal(calls[0]!.url, '/api/assessment/drafts/adr-1/revise');
  assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)), { instruction: 'shorter', baseRevision: 1, requestId: 'req-00000001' });
  await assert.rejects(reviseDraft('adr-1', 'x', 1, 'req-00000002', fakeFetch(409, { error: 'Someone revised this draft first.' })), NewerVersionError);
});

test('revise needs a finished undecided draft; a higher listed revision is newer', () => {
  assert.equal(canRevise(view()), true);
  assert.equal(canRevise(view({ phase: 'running' })), false);
  assert.equal(canRevise(view({ decision: 'discarded' })), false);
  assert.equal(isNewer(view({ revision: 1 }), view({ revision: 2 })), true);
  assert.equal(isNewer(view({ revision: 2 }), view({ revision: 2 })), false);
  assert.equal(isNewer(null, view()), false);
});

test('a 409 from accept or discard (a teammate decided first) becomes the newer-version error', async () => {
  await assert.rejects(acceptDraft('adr-1', undefined, 1, fakeFetch(409, { error: 'Someone decided this draft first.' })), NewerVersionError);
  await assert.rejects(discardDraft('adr-1', fakeFetch(409, { error: 'This draft was already accepted' })), NewerVersionError);
});
