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
