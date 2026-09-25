// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The Overview tab: the stat strip reads the mockup's numbers from rows, the
// attention item is the first blocked item in Work order, Plan next is the
// top of Next up without it, and a failed /work read is a state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOverview, headerStatsLine, money, overviewStats, peopleGroups } from '../overviewModel.ts';
import { OBS_PROJECT, OBS_TREE, node } from './obsFixture.ts';

test('stat strip: "18 / 52 points delivered", "2 agents running", "$1.73 spent of $95 allocated"', () => {
  const [points, agents, spend] = overviewStats(OBS_PROJECT, OBS_TREE);
  assert.equal(`${points!.value} ${points!.label}`, '18 / 52 points delivered');
  assert.ok(Math.abs(points!.progress! - 18 / 52) < 1e-9);
  assert.equal(`${agents!.value} ${agents!.label}`, '2 agents running');
  assert.equal(`${spend!.value} ${spend!.label}`, '$1.73 spent of $95 allocated');
});

test('unknown rollups read unknown, never zero; no allocation says so', () => {
  const [points, agents, spend] = overviewStats({ ...OBS_PROJECT, activeAgentRuns: null, allocatedUsd: null }, null);
  assert.equal(points!.value, '—');
  assert.equal(agents!.value, '—');
  assert.equal(`${spend!.value} ${spend!.label}`, '$1.73 spent · no allocation');
  assert.equal(overviewStats({ ...OBS_PROJECT, activeAgentRuns: 1 }, OBS_TREE)[1]!.label, 'agent running');
  assert.equal(overviewStats(OBS_PROJECT, [])[0]!.progress, undefined);
});

test('money drops cents only on whole dollars', () => {
  assert.equal(money(95), '$95');
  assert.equal(money(1.7), '$1.70');
  assert.equal(money(1200), '$1,200');
});

test('the Work header line: "18 / 52 points delivered · $1.73 spent"', () => {
  assert.equal(headerStatsLine(OBS_PROJECT, OBS_TREE), '18 / 52 points delivered · $1.73 spent');
  assert.equal(headerStatsLine({ ...OBS_PROJECT, agentSpendUsd: null }, null), null);
});

test('attention is the blocked bug, with its summary + reason and "Blocked · Eli Garcia · 2 points"', () => {
  const m = buildOverview(OBS_PROJECT, { tree: OBS_TREE });
  assert.equal(m.state, 'ready');
  if (m.state !== 'ready') return;
  assert.equal(m.attention?.id, 'wi-obs-e2-b4');
  assert.equal(m.attention?.title, 'Stop duplicate alerts during a dependency outage');
  assert.equal(m.attention?.body, 'One failing dependency can trigger forty pages. Waiting on the dependency map.');
  assert.deepEqual(m.attention?.meta, [{ label: 'Blocked', tone: 'warning' }, { label: 'Eli Garcia' }, { label: '2 points' }]);
  assert.equal(m.attention?.actionLabel, 'Open work');
  assert.equal(m.attention?.href, '/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4');
});

test('plan next is the Next-up order minus the attention item: StatsD, dashboard, cardinality', () => {
  const m = buildOverview(OBS_PROJECT, { tree: OBS_TREE });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.deepEqual(m.planNext.map((r) => [r.title, r.description, r.meta]), [
    ['Decommission the legacy StatsD bridge', 'Move remaining service metrics to OpenTelemetry.', 'Layla Hassan · 5 points'],
    ['Error-budget dashboard per team', "Make each team's remaining error budget visible.", 'Nora DaSilva · 3 points'],
    ['Metric cardinality budgets', 'Define limits before new metrics increase storage costs.', 'Eli Garcia · 5 points'],
  ]);
  assert.equal(m.workCount, 11);
  assert.equal(m.seeAll?.label, 'See all 11 work items');
  assert.equal(m.seeAll?.href, '/iq/projects/p-observability?tab=work');
});

test('nothing blocked: attention is null; a done item keeps its label but never draws attention', () => {
  const tree = [node({ id: 'e', type: 'epic', children: [
    node({ id: 'a', status: 'done', labels: ['blocked'] }),
    node({ id: 'b', summary: null }),
  ] })];
  const m = buildOverview(OBS_PROJECT, { tree });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.equal(m.attention, null);
  assert.deepEqual(m.planNext.map((r) => [r.id, r.description, r.meta]), [['b', null, 'Unassigned']]);
});

test('a failed /work read is an error state, even with a stale tree; unread is loading', () => {
  assert.equal(buildOverview(OBS_PROJECT, { tree: OBS_TREE, error: 'HTTP 500' }).state, 'error');
  assert.equal(buildOverview(OBS_PROJECT, { tree: null }).state, 'loading');
  const empty = buildOverview(OBS_PROJECT, { tree: [] });
  assert.equal(empty.state === 'ready' && empty.seeAll, null);
});

test('people line: owner, then the SMEs by name', () => {
  assert.deepEqual(peopleGroups(OBS_PROJECT), [
    { label: 'Owner', names: ['Nora DaSilva'] },
    { label: 'SMEs', names: ['Layla Hassan', 'Eli Garcia'] },
  ]);
});
