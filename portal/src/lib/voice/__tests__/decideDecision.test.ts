// G54 by voice: on the record page of the owner's case, d-eval-judge-model,
// "decide: go with Nova Pro and halve the sample rate" is
// decide { ref: 'decision:d-eval-judge-model', decision: 'resolve', note, scope: 'this-page' }:
// the row the page published, read again through the page's own read, behind
// the click-only card (G40), sent to the same route the page's Decide card
// calls, with the note as the rationale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { VOICE_TOOLS } from '../catalogue.ts';
import { planPreparedCall, prepareToolCall, runPreparedCall, type CardAnswer, type ConfirmPlan, type ToolResult } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import { decisionPageContext } from '../../../pages/decisions/decisionFormat.ts';
import type { Action } from '../../capabilities';

const PATH = '/iq/decisions/d-eval-judge-model';
const NOTE = 'go with Nova Pro and halve the sample rate';
const JUDGE = {
  id: 'd-eval-judge-model', topic: 'Judge model for canary evaluation', summary: 'x', status: 'open', projectId: 'p-llm-platform', decidedAt: null,
  participants: [{ personId: 'p-047', name: 'Nina Rivera', title: null, role: 'decider', weight: 1 }, { personId: 'p-042', name: 'Rhea', title: null, role: 'contributor', weight: 1 }],
  decidedBy: null, outcome: null, history: [], viewerMayDecide: true,
};
const POST = '/api/graph/decisions/d-eval-judge-model/decide';

async function decide(args: Record<string, unknown>, opts: { allow?: Action[]; routes: Route[]; answer?: CardAnswer; mayDecide?: boolean }) {
  const { fetch, log } = fakeFetch(opts.routes);
  const page = decisionPageContext(JUDGE, PATH, opts.mayDecide ?? true);
  const ctx = toolContext({ tenant: 'orgiq', role: 'sme', allow: opts.allow ?? ['DecideDecision', 'VoiceNavigate'], fetch, page: () => page });
  const p = prepareToolCall('decide', args, ctx);
  assert.ok(p.ok, JSON.stringify(p));
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { card: null as ConfirmPlan | null, result: planned?.result as ToolResult, log };
  assert.equal(log.filter((l) => l.method !== 'GET').length, 0, 'nothing is decided before the confirm');
  const result = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data, opts.answer);
  return { card: planned.plan, result, log };
}
const writes = (log: Array<{ method: string; url: string; body: unknown }>) => log.filter((l) => l.method !== 'GET').map((l) => [l.method, l.url, l.body]);

test('decide is click-only (G40) and takes resolve for a decision', () => {
  const tool = VOICE_TOOLS.find((t) => t.name === 'decide')!;
  assert.equal(tool.confirmBy, 'click');
  assert.ok(JSON.stringify(tool.parameters).includes('"resolve"'));
});

test('the decider resolves the judge-model decision from the dock: the page\'s row, the card, then the page\'s route with the note as the rationale', async () => {
  const r = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE, scope: 'this-page' }, {
    routes: [route('GET', '/api/graph/decisions/d-eval-judge-model', 200, JUDGE), route('POST', POST, 200, { ...JUDGE, status: 'resolved' })],
    answer: { decision: 'approve', note: '' },
  });
  assert.equal(r.card!.title, 'Resolve "Judge model for canary evaluation"');
  assert.deepEqual(r.card!.detail, ['It is open; Nina Rivera decides.', `Note: ${NOTE}`]);
  assert.deepEqual(r.card!.fields, { decision: 'approve', notePlaceholder: 'What was decided, and why (needed)' });
  assert.equal(r.result.outcome, 'done');
  assert.equal(r.result.summary, 'Resolved: "Judge model for canary evaluation"');
  assert.deepEqual(writes(r.log), [['POST', POST, { outcome: 'resolved', rationale: NOTE }]]);
  assert.equal(r.result.output['href'], PATH);
});

test('flipped to reject on the card, with the card\'s own words; with no rationale anywhere nothing is sent', async () => {
  const routes = [route('GET', '/api/graph/decisions/d-eval-judge-model', 200, JUDGE), route('POST', POST, 200, {})];
  const flipped = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { routes, answer: { decision: 'reject', note: 'Rerun the rubric first.' } });
  assert.deepEqual(writes(flipped.log), [['POST', POST, { outcome: 'rejected', rationale: 'Rerun the rubric first.' }]]);
  // No note said: the card still shows (the rationale may be typed on it); Confirm without one sends nothing.
  const bare = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve' }, { routes, answer: { decision: 'approve', note: '  ' } });
  assert.ok(bare.card, 'the card is shown to type the rationale on');
  assert.equal(bare.result.outcome, 'refused');
  assert.match(bare.result.summary, /outcome and why/);
  assert.deepEqual(writes(bare.log), []);
});

test('a non-decider, a role without DecideDecision and a settled decision are refused; the route\'s 403 and 409 are said as the route said them', async () => {
  const role = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { allow: ['VoiceNavigate'], routes: [] });
  assert.equal(role.result.outcome, 'refused');
  assert.equal(role.log.length, 0, 'refused before any read');

  const notMine = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { routes: [route('GET', '/api/graph/decisions/d-eval-judge-model', 200, { ...JUDGE, viewerMayDecide: false })] });
  assert.equal(notMine.result.outcome, 'refused');
  assert.match(notMine.result.summary, /waiting on Nina Rivera, not you/);

  const settled = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { routes: [route('GET', '/api/graph/decisions/d-eval-judge-model', 200, { ...JUDGE, status: 'resolved' })] });
  assert.match(settled.result.summary, /already decided/);

  const forbidden = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { routes: [
    route('GET', '/api/graph/decisions/d-eval-judge-model', 200, JUDGE),
    route('POST', POST, 403, { error: 'only the decider, the initiative\'s owner or an org-leader can decide this', code: 'NOT_DECIDER' }),
  ], answer: { decision: 'approve', note: '' } });
  assert.equal(forbidden.result.outcome, 'refused');
  assert.match(forbidden.result.summary, /Not decided: only the decider/);

  const raced = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', note: NOTE }, { routes: [
    route('GET', '/api/graph/decisions/d-eval-judge-model', 200, JUDGE), route('POST', POST, 409, { error: 'this decision is already resolved', status: 'resolved' }),
  ], answer: { decision: 'approve', note: '' } });
  assert.match(raced.result.summary, /Not decided: this decision is already resolved/);
});

test('get decision: a settled one carries its outcome, a waiting one says who it waits on', async () => {
  const { VOICE_RUNNERS: runners } = await import('../actions.ts');
  const run = async (body: unknown, ref: string) => {
    const { fetch } = fakeFetch([route('GET', `/api/graph/decisions/${ref}`, 200, body)]);
    const ctx = toolContext({ tenant: 'orgiq', role: 'sme', fetch });
    const p = prepareToolCall('get', { ref: `decision:${ref}` }, ctx);
    assert.ok(p.ok, JSON.stringify(p));
    return runPreparedCall(p.call, ctx, runners);
  };
  const outcome = 'Self-hosted OpenTelemetry collectors in an agent and gateway topology, exporting OTLP to the current backend.';
  const settled = await run({ id: 'd-otel-vendor', topic: 'Self-hosted OTel collectors over vendor agents', status: 'resolved', decidedAt: '2026-11-03', outcome,
    decidedBy: { id: 'p-004', name: 'Nora DaSilva' }, participants: [{ personId: 'p-004', name: 'Nora DaSilva', role: 'decider' }], history: [] }, 'd-otel-vendor');
  assert.equal(settled.outcome, 'done');
  assert.equal(settled.output['subtitle'], `Decided: ${outcome}`);
  const waiting = await run(JUDGE, 'd-eval-judge-model');
  assert.equal(waiting.output['subtitle'], 'waiting on Nina Rivera');
});

// G57: the decision's numbered options by voice. The record page lists them in its context ("option 1. …"), so
// "decide 2" or "go with Nova Pro" is decide { option } mapped to the route's optionId; the card shows the choice.
const OPTIONS = [
  { id: 'nova-pro-10', label: 'Nova Pro, sample rate halved to 10%', detail: '82 percent agreement with human labels, at the current spend.' },
  { id: 'nova-lite-20', label: 'Nova Lite at the current 20% sample rate', detail: '71 percent agreement, at about a sixth of the cost per judged answer.' },
];
const WITH_OPTIONS = { ...JUDGE, options: OPTIONS };
const readWith = () => route('GET', '/api/graph/decisions/d-eval-judge-model', 200, WITH_OPTIONS);

test('decide takes an option: "decide 2" resolves with the second option, shown on the card, and sends its optionId', async () => {
  const tool = VOICE_TOOLS.find((t) => t.name === 'decide')!;
  assert.ok(JSON.stringify(tool.parameters).includes('"option"'));
  const r = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: '2', scope: 'this-page' }, {
    routes: [readWith(), route('POST', POST, 200, { ...WITH_OPTIONS, status: 'resolved' })], answer: { decision: 'approve', note: '' },
  });
  assert.equal(r.card!.title, 'Resolve "Judge model for canary evaluation"');
  assert.deepEqual(r.card!.detail, ['It is open; Nina Rivera decides.', 'Option 2: Nova Lite at the current 20% sample rate']);
  assert.deepEqual(r.card!.fields, { decision: 'approve', notePlaceholder: 'Why (optional)' });
  assert.deepEqual(writes(r.log), [['POST', POST, { optionId: 'nova-lite-20', outcome: 'resolved' }]]);
  assert.equal(r.result.summary, 'Resolved: "Judge model for canary evaluation" (Nova Lite at the current 20% sample rate)');
  assert.equal(r.result.output['option'], 'Nova Lite at the current 20% sample rate');
});

test('deciding names the one story it unblocked in the same sentence; several (or none) are left to the record', async () => {
  const story = (id: string, title: string, blocked = false) => ({ id, title, projectId: 'p-llm-platform', blocked });
  const run = (heldWork: unknown[]) => decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: '1', scope: 'this-page' }, {
    routes: [readWith(), route('POST', POST, 200, { ...WITH_OPTIONS, status: 'resolved', heldWork })], answer: { decision: 'approve', note: '' },
  });
  const one = await run([story('wi-1', 'LLM-as-judge canary rubric')]);
  assert.equal(one.result.output['say'], 'Resolved: "Judge model for canary evaluation" (Nova Pro, sample rate halved to 10%); "LLM-as-judge canary rubric" is unblocked.');
  const two = await run([story('wi-1', 'A'), story('wi-2', 'B')]);
  assert.equal(two.result.summary, 'Resolved: "Judge model for canary evaluation" (Nova Pro, sample rate halved to 10%)');
  const stillBlocked = await run([story('wi-1', 'A', true)]);
  assert.equal(stillBlocked.result.summary, 'Resolved: "Judge model for canary evaluation" (Nova Pro, sample rate halved to 10%)');
});

test('an option by its words, with the why said as the note', async () => {
  const r = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: 'go with Nova Pro', note: 'it agrees with human labels' }, {
    routes: [readWith(), route('POST', POST, 200, {})], answer: { decision: 'approve', note: '' },
  });
  assert.deepEqual(r.card!.detail, ['It is open; Nina Rivera decides.', 'Option 1: Nova Pro, sample rate halved to 10%', 'Why: it agrees with human labels']);
  assert.deepEqual(writes(r.log), [['POST', POST, { optionId: 'nova-pro-10', outcome: 'resolved', rationale: 'it agrees with human labels' }]]);
});

test('the last numbered rows: Reject is a reject (with why), Something else is a resolve whose note is the outcome; a wrong option is refused', async () => {
  const rejected = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: '4', note: 'rerun the rubric first' }, {
    routes: [readWith(), route('POST', POST, 200, {})], answer: { decision: 'reject', note: '' },
  });
  assert.equal(rejected.card!.title, 'Reject "Judge model for canary evaluation"');
  assert.deepEqual(writes(rejected.log), [['POST', POST, { outcome: 'rejected', rationale: 'rerun the rubric first' }]]);

  const other = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: 'something else', note: 'Nova Pro on the hard set only' }, {
    routes: [readWith(), route('POST', POST, 200, {})], answer: { decision: 'approve', note: '' },
  });
  assert.deepEqual(writes(other.log), [['POST', POST, { outcome: 'resolved', rationale: 'Nova Pro on the hard set only' }]]);

  const none = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: '7' }, { routes: [readWith()] });
  assert.equal(none.result.outcome, 'refused');
  assert.match(none.result.summary, /no option "7"; choose 1 to 4/);
  assert.deepEqual(none.result.output['options'], ['1. Nova Pro, sample rate halved to 10%', '2. Nova Lite at the current 20% sample rate', '3. Something else…', '4. Reject']);

  const mixed = await decide({ ref: 'decision:d-eval-judge-model', decision: 'reject', option: '1' }, { routes: [readWith()] });
  assert.equal(mixed.result.outcome, 'refused');
  assert.match(mixed.result.summary, /a rejection takes no option/);
});

test('an option flipped to reject on the card drops the option: with no why nothing is sent', async () => {
  const r = await decide({ ref: 'decision:d-eval-judge-model', decision: 'resolve', option: '1' }, {
    routes: [readWith(), route('POST', POST, 200, {})], answer: { decision: 'reject', note: ' ' },
  });
  assert.equal(r.result.outcome, 'refused');
  assert.deepEqual(writes(r.log), []);
});

test('the record page lists the options for the voice as numbered rows', () => {
  const page = decisionPageContext(WITH_OPTIONS, PATH, true);
  assert.deepEqual(page.choices, ['Nova Pro, sample rate halved to 10%', 'Nova Lite at the current 20% sample rate', 'Something else…', 'Reject']);
});
