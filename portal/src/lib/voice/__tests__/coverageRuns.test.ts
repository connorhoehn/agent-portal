// Coverage (10 November), capability 3: runs and agents. An initiative's or a work item's agent runs as its Agents tab
// reads them (status, outcome line, cost, the page a run opens on), one run read back by ref, "run it again" as the
// drawer's dispatch of its work item, and a cancel that only a click confirms.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS } from '../actions.ts';
import { confirmModeOf, planPreparedCall, prepareToolCall, ResultMemory, runVoiceTool, type ToolContext } from '../tools.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import { AUTH_PAGE, AUTH_TREE, DETAIL, P } from './coverageFixtures.ts';

const RUNS = { runs: [
  { id: 'run-mkt-auth-e1-s3-a', trigger: 'marketplace', workItemId: 'wi-auth-e1-s3', status: 'done', costUsd: 2.18, startedAt: '2026-11-01T07:11:54Z', outcome: { reason: 'drafted the cookie max-age and rotation-on-switch change; opened for review' } },
  { id: 'run-mkt-auth-e2-b3', trigger: 'marketplace', workItemId: 'wi-auth-e2-b3', status: 'done', costUsd: 0.96, startedAt: '2026-11-07T07:11:54Z', outcome: { reason: 'traced the logout path that leaves the legacy shim cookie alive', prUrl: 'https://github.com/example/auth/pull/12' } },
  { id: 'bot-run-1', trigger: 'cron', workItemId: null, status: 'done', costUsd: 0.11, startedAt: '2026-11-10T04:11:54Z', outcome: { reason: 'bumped the JWT library in the token verifier; the OIDC conformance suite is green' } },
] };
/** The tree with the logout bug sized, so the drawer would dispatch it. */
const SIZED = [{ ...AUTH_TREE[0]!, children: AUTH_TREE[0]!.children.map((c) => (c.id === 'wi-auth-e2-b3' ? { ...c, storyPoints: 2 } : c)) }];

function ctxFor(over: Partial<ToolContext> & { extra?: Route[] } = {}) {
  const { extra, ...rest } = over;
  const { fetch, log } = fakeFetch([
    ...(extra ?? []),
    route('GET', '/api/bots/initiative-runs', 200, RUNS),
    route('GET', '/api/bots/estimate', 200, { costUsdP25: 0.8, costUsdP75: 1.9 }),
    route('GET', '/api/agent-projects', 200, { projects: [] }),
    route('GET', `/api/graph/projects/${P}/work`, 200, SIZED),
    route('GET', `/api/graph/projects/${P}`, 200, DETAIL),
    route('GET', '/api/graph/work', 200, SIZED[0]!.children),
  ]);
  const ctx = toolContext({ fetch, results: new ResultMemory(), page: () => AUTH_PAGE, jobs: { track: () => {} }, ...rest });
  return { ctx, log };
}

const words = (s: unknown) => String(s).trim().split(/\s+/).length;

test('get initiative part runs: the Agents tab\'s read, newest first, count first; each row opens its work item', async () => {
  const { ctx, log } = ctxFor();
  const r = await runVoiceTool('get', { ref: `initiative:${P}`, part: 'runs' }, ctx);
  assert.equal(r.outcome, 'done');
  assert.ok(log.some((l) => l.url === `/api/bots/initiative-runs?orgProjectId=${P}`));
  assert.equal(r.output['count'], 3);
  const rows = r.output['rows'] as Array<Record<string, unknown>>;
  assert.equal(rows[0]!['ref'], 'agent-run:bot-run-1');
  assert.equal(rows[0]!['href'], `/iq/projects/${P}?tab=agents`);
  assert.equal(rows[1]!['href'], `/iq/projects/${P}?item=wi-auth-e2-b3`);
  assert.match(String(rows[1]!['subtitle']), /\$0\.96 · PR open/);
  assert.match(String(r.output['say']), /^3 agent runs on Auth Migration; latest done, \$0\.11: bumped the JWT library/);
  assert.ok(words(r.output['say']) <= 25);
});

test('get work-item part runs, then the run by ref: one run, its cost and outcome said', async () => {
  const { ctx } = ctxFor();
  const r = await runVoiceTool('get', { ref: 'work-item:wi-auth-e2-b3', part: 'runs' }, ctx);
  assert.equal(r.output['count'], 1);
  assert.equal(r.output['say'], '1 agent run on "Logout leaves the legacy shim cookie alive"; latest done, $0.96: traced the logout path that leaves the legacy shim cookie alive.');
  const one = await runVoiceTool('get', { ref: 'agent-run:run-mkt-auth-e2-b3' }, ctx);
  assert.equal(one.outcome, 'done');
  assert.equal(one.output['costUsd'], 0.96);
  assert.match(String(one.output['pr']), /work item's page/);
  assert.equal(one.output['say'], 'The run on "Logout leaves the legacy shim cookie alive" finished, $0.96: traced the logout path that leaves the legacy shim cookie alive.');
  const none = await runVoiceTool('get', { ref: 'agent-run:nope' }, ctx);
  assert.equal(none.outcome, 'refused');
  assert.doesNotMatch(String(none.output['reason']), /nope/);
});

test('queue_work dispatch on a run read back: its work item, through the drawer\'s dispatch card; a sweep\'s run is not dispatched', async () => {
  const { ctx } = ctxFor();
  await runVoiceTool('get', { ref: `initiative:${P}`, part: 'runs' }, ctx);
  const plan = async (target: string) => {
    const p = prepareToolCall('queue_work', { kind: 'dispatch', target }, ctx);
    assert.ok(p.ok, JSON.stringify(p));
    return planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  };
  const again = await plan('agent-run:run-mkt-auth-e2-b3');
  assert.ok(again && 'plan' in again, JSON.stringify(again));
  assert.equal(again.plan.title, 'Dispatch "Logout leaves the legacy shim cookie alive"');
  const sweep = await plan('agent-run:bot-run-1');
  assert.ok(sweep && 'result' in sweep);
  assert.equal(sweep.result.output['code'], 'not-dispatchable');
  const { ctx: fresh } = ctxFor();
  const p = prepareToolCall('queue_work', { kind: 'dispatch', target: 'agent-run:run-mkt-auth-e2-b3' }, fresh);
  assert.ok(p.ok);
  const unread = await planPreparedCall(p.call, fresh, VOICE_PLANNERS);
  assert.ok(unread && 'result' in unread);
  assert.equal(unread.result.output['code'], 'not-read-yet');
});

test('a cancel is click-only: update fields.status cancelled asks for the click; any other move is voice-confirmable', () => {
  const ctx = toolContext({ tenant: 'pipelines', role: 'operator' });
  const cancel = prepareToolCall('update', { ref: 'run:r-1', fields: { status: 'cancelled' } }, ctx);
  const move = prepareToolCall('update', { ref: 'work-item:w-1', fields: { status: 'in_progress' } }, toolContext());
  assert.ok(cancel.ok && move.ok);
  assert.equal(confirmModeOf(cancel.call), 'click');
  assert.equal(confirmModeOf(move.call), 'voice');
});
