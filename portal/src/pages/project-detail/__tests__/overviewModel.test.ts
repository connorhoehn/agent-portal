// Run with:  cd portal && node --test 'src/pages/project-detail/__tests__/*.test.ts'
//
// The Overview tab (v2): the stats line reads the mockup's numbers from rows,
// "Needs attention" is every blocked item in Work order (its count is their
// number), "Up next" is the top of Next up without them, and a failed /work
// read is a state.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildOverview, failedLastWeek, headerStatsLine, learningAttention, money, overviewStats, peopleGroups } from '../overviewModel.ts';
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
    key: null,
    title: 'Stop duplicate alerts during a dependency outage',
    reason: 'Waiting on the dependency map.',
    assigneeName: 'Eli Garcia',
    assigneeAvatarUrl: null,
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


test('both overview lists preserve contributor portraits by id, including missing portraits and namesakes', () => {
  const project = { ...OBS_PROJECT, contributors: OBS_PROJECT.contributors.map(person => ({ ...person, avatarUrl: `/portraits/${person.personId}.jpg` })) };
  const model = buildOverview(project, { tree: OBS_TREE });
  if (model.state !== 'ready') throw new Error(model.state);
  assert.equal(model.attention[0]?.assigneeAvatarUrl, '/portraits/p-011.jpg');
  assert.deepEqual(model.upNext.map(row => row.assigneeAvatarUrl), ['/portraits/p-008.jpg', '/portraits/p-004.jpg', '/portraits/p-011.jpg']);
  const tree = [node({ id: 'epic', type: 'epic', children: [
    node({ id: 'unknown', assigneeId: 'another-eli', assigneeName: 'Eli Garcia' }),
    node({ id: 'unassigned', assigneeId: null, assigneeName: null }),
  ] })];
  const missing = buildOverview(project, { tree });
  if (missing.state !== 'ready') throw new Error(missing.state);
  assert.ok(missing.upNext.every(row => row.assigneeAvatarUrl === null));
});

test('failedLastWeek counts failed reports ended in the last seven days only', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const day = 86_400_000;
  const at = (ago: number) => new Date(now - ago).toISOString();
  assert.equal(failedLastWeek([
    { outcome: 'failed', endedAt: at(day) },
    { outcome: 'failed', endedAt: at(6.9 * day) },
    { outcome: 'failed', endedAt: at(8 * day) },
    { outcome: 'done', endedAt: at(day) },
    { outcome: 'failed', endedAt: 'not a date' },
    { outcome: 'failed', endedAt: at(-day) },
  ], now), 2);
});

test('learningAttention adds a line per non-zero count, each linking to the Learning tab', () => {
  assert.deepEqual(learningAttention('p-1', { failedRuns: 0, proposals: null }), []);
  const lines = learningAttention('p 1', { failedRuns: 1, proposals: 2 });
  assert.deepEqual(lines.map((l) => l.text), ['1 run failed in the last seven days', '2 runbook proposals awaiting review']);
  assert.ok(lines.every((l) => l.href === '/iq/projects/p%201?tab=learning'));
});

test('a freshly created initiative (no work, no runs, no spend, no summary, owner only) builds a ready overview without NaN', () => {
  const fresh = {
    ...OBS_PROJECT, id: 'p-fresh', name: 'Fresh', status: 'planning', summary: null,
    sponsorId: null, sponsorName: null, sponsorTitle: null, repoFullName: null,
    agentSpendUsd: 0, allocatedUsd: null, activeAgentRuns: 0,
    ownerId: 'p-1', ownerName: 'Owner One',
    contributors: [{ personId: 'p-1', name: 'Owner One', title: '', role: 'owner', weight: 1, avatarUrl: null }],
  } as typeof OBS_PROJECT;
  const model = buildOverview(fresh, { tree: [] });
  assert.equal(model.state, 'ready');
  if (model.state !== 'ready') return;
  assert.equal(model.workCount, 0);
  assert.equal(model.viewAll, null);
  assert.deepEqual(model.attention, []);
  assert.deepEqual(model.upNext, []);
  const [points, agents, spend] = model.stats;
  assert.equal(`${points!.value} ${points!.label}`, '0 points planned');
  assert.equal(points!.progress, undefined);
  assert.equal(`${agents!.value} ${agents!.label}`, '0 agents running');
  assert.equal(`${spend!.value} ${spend!.label}`, '$0 spent');
  for (const s of model.stats) assert.ok(!/NaN|Infinity/.test(`${s.value}${s.label}`));
  assert.equal(headerStatsLine(fresh, []), '$0 spent');
  assert.deepEqual(peopleGroups(fresh), [{ label: 'Owner', names: ['Owner One'] }]);
});
