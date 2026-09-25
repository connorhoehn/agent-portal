// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The Overview tab (v2): the stats line reads the mockup's numbers from rows,
// "Needs attention" is every blocked item in Work order (its count is their
// number), "Up next" is the top of Next up without them, and a failed /work
// read is a state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOverview, headerStatsLine, money, overviewStats, peopleGroups } from '../overviewModel.ts';
import { OBS_PROJECT, OBS_TREE, node } from './obsFixture.ts';

test('stats line: "18 / 52 points delivered", "2 agents running", "$1.73 of $95 spent"', () => {
  const [points, agents, spend] = overviewStats(OBS_PROJECT, OBS_TREE);
  assert.equal(`${points!.value} ${points!.label}`, '18 / 52 points delivered');
  assert.ok(Math.abs(points!.progress! - 18 / 52) < 1e-9);
  assert.equal(`${agents!.value} ${agents!.label}`, '2 agents running');
  assert.equal(`${spend!.value} ${spend!.label}`, '$1.73 of $95 spent');
});

test('unknown rollups read unknown, never zero; no allocation says so', () => {
  const [points, agents, spend] = overviewStats({ ...OBS_PROJECT, activeAgentRuns: null, allocatedUsd: null }, null);
  assert.equal(points!.value, '—');
  assert.equal(agents!.value, '—');
  assert.equal(`${spend!.value} ${spend!.label}`, '$1.73 spent');
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

test('needs attention: the blocked bug, with its short reason, Eli Garcia and "2 pts"', () => {
  const m = buildOverview(OBS_PROJECT, { tree: OBS_TREE });
  assert.equal(m.state, 'ready');
  if (m.state !== 'ready') return;
  assert.equal(m.attention.length, 1);
  assert.deepEqual(m.attention[0], {
    id: 'wi-obs-e2-b4',
    title: 'Stop duplicate alerts during a dependency outage',
    reason: 'Waiting on the dependency map.',
    assigneeName: 'Eli Garcia',
    points: '2 pts',
    href: '/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4',
  });
});

test('up next is the Next-up order minus the attention items: StatsD, dashboard, cardinality', () => {
  const m = buildOverview(OBS_PROJECT, { tree: OBS_TREE });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.deepEqual(m.upNext.map((r) => [r.title, r.assigneeName, r.points]), [
    ['Decommission the legacy StatsD bridge', 'Layla Hassan', '5 pts'],
    ['Error-budget dashboard per team', 'Nora DaSilva', '3 pts'],
    ['Metric cardinality budgets', 'Eli Garcia', '5 pts'],
  ]);
  assert.equal(m.workCount, 11);
  assert.equal(m.viewAll?.label, 'View all 11');
  assert.equal(m.viewAll?.href, '/iq/projects/p-observability?tab=work');
});

test('nothing blocked: attention is empty; a done item keeps its label but never draws attention', () => {
  const tree = [node({ id: 'e', type: 'epic', children: [
    node({ id: 'a', status: 'done', labels: ['blocked'] }),
    node({ id: 'b', summary: null, assigneeName: null, storyPoints: null }),
  ] })];
  const m = buildOverview(OBS_PROJECT, { tree });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.deepEqual(m.attention, []);
  assert.deepEqual(m.upNext.map((r) => [r.id, r.assigneeName, r.points]), [['b', null, null]]);
});

test('every blocked item is listed, and the reason falls back to the summary', () => {
  const tree = [node({ id: 'e', type: 'epic', children: [
    node({ id: 'x', labels: ['blocked'], blockedReason: null, summary: 'Needs a decision.' }),
    node({ id: 'y', status: 'in_progress', labels: ['blocked'], blockedReason: 'Waiting on legal.' }),
  ] })];
  const m = buildOverview(OBS_PROJECT, { tree });
  if (m.state !== 'ready') throw new Error(m.state);
  assert.deepEqual(m.attention.map((a) => [a.id, a.reason]).sort(), [['x', 'Needs a decision.'], ['y', 'Waiting on legal.']]);
  assert.deepEqual(m.upNext, []);
});

test('a failed /work read is an error state, even with a stale tree; unread is loading', () => {
  assert.equal(buildOverview(OBS_PROJECT, { tree: OBS_TREE, error: 'HTTP 500' }).state, 'error');
  assert.equal(buildOverview(OBS_PROJECT, { tree: null }).state, 'loading');
  const empty = buildOverview(OBS_PROJECT, { tree: [] });
  assert.equal(empty.state === 'ready' && empty.viewAll, null);
});

test('people line: owner, then the SMEs by name', () => {
  assert.deepEqual(peopleGroups(OBS_PROJECT), [
    { label: 'Owner', names: ['Nora DaSilva'] },
    { label: 'SMEs', names: ['Layla Hassan', 'Eli Garcia'] },
  ]);
});
