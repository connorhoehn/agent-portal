// Coverage (10 November), capability 5: decisions. "What is waiting on me" (each waiting decision's own page read says
// whether the user may decide it), "what did we decide about X" (the Decisions page's read, narrowed), and get said as
// the outcome line or who it waits on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultMemory, runVoiceTool, type ToolContext } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';

const DECISIONS = [
  { id: 'd-cognito-cutover', topic: 'Cutover order for legacy SSO tenants', summary: 'Twelve tenants remain on the SAML shim.', status: 'escalated', projectId: 'p-auth-migration', outcome: null },
  { id: 'd-eval-judge-model', topic: 'Judge model for canary evaluation', summary: 'The canary judge scores every sampled answer.', status: 'open', projectId: 'p-llm-platform', outcome: null },
  { id: 'd-dep-map', topic: 'Dependency map source of truth', summary: 'Which system owns the service dependency map.', status: 'resolved', projectId: 'p-platform', outcome: 'The service catalog owns the dependency map; the graph mirrors it nightly.' },
];
const DECIDER = (name: string) => [{ name: 'Vera Green', role: 'contributor' }, { name, role: 'decider' }];
const DETAILS: Record<string, unknown> = {
  'd-cognito-cutover': { ...DECISIONS[0], participants: DECIDER('Sienna Garcia'), viewerMayDecide: true, heldWork: [{ id: 'wi-auth-e2-s2', title: 'Tenant-by-tenant cutover runbook with rollback', blocked: true }] },
  'd-eval-judge-model': { ...DECISIONS[1], participants: DECIDER('Marcus Lee'), viewerMayDecide: false },
  'd-dep-map': { ...DECISIONS[2], participants: DECIDER('Vera Green'), viewerMayDecide: true },
};

function ctxFor(over: Partial<ToolContext> & { extra?: Route[] } = {}) {
  const { extra, ...rest } = over;
  const { fetch, log } = fakeFetch([
    ...(extra ?? []),
    ...Object.entries(DETAILS).map(([id, body]) => route('GET', `/api/graph/decisions/${id}`, 200, body)),
    route('GET', '/api/graph/decisions/d-nope', 404, { error: 'not found' }),
    route('GET', '/api/graph/decisions', 200, DECISIONS),
  ]);
  const ctx = toolContext({ fetch, results: new ResultMemory(), role: 'org-leader', ...rest });
  return { ctx, log };
}

test('list decision who me: the waiting decisions whose page says the user may decide them; count first', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('list', { kind: 'decision', filter: { who: 'me' } }, ctx);
  assert.equal(r.outcome, 'done');
  assert.equal(r.output['count'], 1);
  assert.ok(log.some((l) => l.url === '/api/graph/decisions/d-eval-judge-model'), 'each waiting decision\'s own read');
  assert.ok(!log.some((l) => l.url === '/api/graph/decisions/d-dep-map'), 'a settled one is not read');
  assert.equal(r.output['say'], '1 decision waits on you; first "Cutover order for legacy SSO tenants" is escalated.');
  assert.equal(ctx.results!.find('1')!.ref, 'decision:d-cognito-cutover');
  // Someone else's queue is not read through the list.
  const other = await runVoiceTool('list', { kind: 'decision', filter: { who: 'Sienna' } }, ctx);
  assert.equal(other.output['code'], 'invalid-arguments');
});

test('list decision about X, decided: the outcome line; status waiting names who each waits on', async () => {
  const { ctx } = ctxFor();
  const r = await runVoiceTool('list', { kind: 'decision', filter: { q: 'dependency map', status: 'decided' } }, ctx);
  assert.equal(r.output['count'], 1);
  assert.equal(r.output['say'], '"Dependency map source of truth" was decided: The service catalog owns the dependency map; the graph mirrors it nightly.');
  const waiting = await runVoiceTool('list', { kind: 'decision', filter: { status: 'waiting' } }, ctx);
  assert.equal(waiting.output['count'], 2);
  const rows = waiting.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows[1]!['subtitle'], 'waiting on Marcus Lee');
});

test('get decision: the outcome line when settled; who it waits on and the work it holds when not', async () => {
  const { ctx } = ctxFor();
  const settled = await runVoiceTool('get', { ref: 'decision:d-dep-map' }, ctx);
  assert.equal(settled.output['outcome'], 'The service catalog owns the dependency map; the graph mirrors it nightly.');
  assert.match(String(settled.output['say']), /^"Dependency map source of truth" was decided: The service catalog owns/);
  const open = await runVoiceTool('get', { ref: 'decision:d-cognito-cutover' }, ctx);
  assert.equal(open.output['youMayDecide'], true);
  assert.equal(open.output['say'], '"Cutover order for legacy SSO tenants" is escalated, waiting on Sienna Garcia; it holds 1 work item.');
  const none = await runVoiceTool('get', { ref: 'decision:d-nope' }, ctx);
  assert.equal(none.outcome, 'refused');
});
