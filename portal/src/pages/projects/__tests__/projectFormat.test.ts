// Run with:  cd portal && node --test 'src/pages/projects/__tests__/*.test.ts'
//
// Same runner as the sprints tests — plain node:test, no DOM. Everything in
// projectFormat is pure by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  priorityRank, liveAgentsLabel, pointsFraction, allocationFraction,
  compareProjects, matchesQuery, programTotals, spendLine, workLine,
} from '../projectFormat.ts';
import type { ProjectSummary } from '../types.ts';

function proj(over: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 'p-x', name: 'Some Initiative', status: 'in_progress',
    contributorCount: 3, createdAt: '2026-06-01T00:00:00Z',
    ...over,
  };
}

// ─── Priority ────────────────────────────────────────────────────────────────

test('priorityRank orders critical hottest and null coldest', () => {
  const order = ['critical', 'high', 'medium', 'low'].map(priorityRank);
  assert.deepEqual(order, [0, 1, 2, 3]);
  assert.ok(priorityRank(null) > priorityRank('low'));
  assert.ok(priorityRank('bogus') > priorityRank('low'));
});

// ─── Live agents ─────────────────────────────────────────────────────────────

test('liveAgentsLabel pluralizes and hides at zero', () => {
  assert.equal(liveAgentsLabel(proj({ activeAgentRuns: 0 })), null);
  assert.equal(liveAgentsLabel(proj()), null);
  assert.equal(liveAgentsLabel(proj({ activeAgentRuns: 1 })), '1 agent on it now');
  assert.equal(liveAgentsLabel(proj({ activeAgentRuns: 3 })), '3 agents on it now');
});

// ─── Fractions ───────────────────────────────────────────────────────────────

test('pointsFraction: 0/0 is "not started", not 0%', () => {
  assert.equal(pointsFraction(proj({ pointsDone: 0, pointsTotal: 0 })), null);
  assert.equal(pointsFraction(proj()), null);
  assert.equal(pointsFraction(proj({ pointsDone: 5, pointsTotal: 10 })), 0.5);
});

test('allocationFraction is uncapped and null without an allocation', () => {
  assert.equal(allocationFraction(proj({ agentSpendUsd: 10 })), null);
  assert.equal(allocationFraction(proj({ agentSpendUsd: 12, allocatedUsd: 10 })), 1.2);
});

// ─── Sorting ─────────────────────────────────────────────────────────────────

test('activity sort: running agents first, then recency', () => {
  const idle = proj({ id: 'a', activeAgentRuns: 0, lastActivityAt: '2026-08-31T00:00:00Z' });
  const busy = proj({ id: 'b', activeAgentRuns: 2, lastActivityAt: '2026-08-01T00:00:00Z' });
  const fresh = proj({ id: 'c', activeAgentRuns: 0, lastActivityAt: '2026-09-01T00:00:00Z' });
  const sorted = [idle, busy, fresh].sort((a, b) => compareProjects(a, b, 'activity'));
  assert.deepEqual(sorted.map((p) => p.id), ['b', 'c', 'a']);
});

test('progress sort puts furthest-behind first and unmeasured last', () => {
  const behind = proj({ id: 'a', pointsDone: 1, pointsTotal: 10 });
  const ahead = proj({ id: 'b', pointsDone: 9, pointsTotal: 10 });
  const unknown = proj({ id: 'c' });
  const sorted = [ahead, unknown, behind].sort((a, b) => compareProjects(a, b, 'progress'));
  assert.deepEqual(sorted.map((p) => p.id), ['a', 'b', 'c']);
});

test('priority sort ranks critical over none', () => {
  const none = proj({ id: 'a' });
  const crit = proj({ id: 'b', priority: 'critical' });
  const sorted = [none, crit].sort((a, b) => compareProjects(a, b, 'priority'));
  assert.deepEqual(sorted.map((p) => p.id), ['b', 'a']);
});

// ─── Search ──────────────────────────────────────────────────────────────────

test('matchesQuery hits name, owner, SME and repo, case-insensitively', () => {
  const p = proj({
    name: 'Observability Platform', ownerName: 'Nora DaSilva',
    smeNames: ['Layla Hassan'], repoFullName: 'org/orgiq-observability',
  });
  assert.ok(matchesQuery(p, ''));
  assert.ok(matchesQuery(p, 'nora'));
  assert.ok(matchesQuery(p, 'LAYLA'));
  assert.ok(matchesQuery(p, 'orgiq-obs'));
  assert.ok(matchesQuery(p, 'OBS')); // the derived key
  assert.ok(!matchesQuery(p, 'zebra'));
});

// ─── Program rollup ──────────────────────────────────────────────────────────

test('programTotals sums live agents, work, points and money', () => {
  const t = programTotals([
    proj({ status: 'in_progress', activeAgentRuns: 2, openStories: 3, openBugs: 1,
           priority: 'critical', pointsDone: 5, pointsTotal: 10, agentSpendUsd: 4, allocatedUsd: 10 }),
    proj({ status: 'planning', activeAgentRuns: 0, openStories: 2, openBugs: 0,
           priority: 'high', pointsDone: 0, pointsTotal: 8, agentSpendUsd: 0 }),
    proj({ status: 'completed' }),
  ]);
  assert.equal(t.inFlight, 1);
  assert.equal(t.planning, 1);
  assert.equal(t.agentsActive, 2);
  assert.equal(t.agentsActiveInitiatives, 1);
  assert.equal(t.openStories, 5);
  assert.equal(t.openBugs, 1);
  assert.equal(t.criticalCount, 1);
  assert.equal(t.pointsDone, 5);
  assert.equal(t.pointsTotal, 18);
  assert.equal(t.spendUsd, 4);
  assert.equal(t.allocatedUsd, 10);
});

// program-owner DEFECTS #2: with Show=Mine, `/api/graph/projects?scope=mine`
// returns just the caller's own initiatives (e.g. Mia's single Mobile App
// Redesign, status "active", no agent runs today) — `programTotals` must
// derive both numbers from that SAME one-project array, so "Agents active"
// and "Active initiatives" describe two different, individually true things
// rather than reading like one self-contradicting tile ("Agents active 0 ·
// 1 in flight").
test('programTotals on a Mine-scoped single initiative: agents-active and in-flight never contradict', () => {
  const mine = [proj({ id: 'p-mobile-redesign', status: 'active', activeAgentRuns: 0 })];
  const t = programTotals(mine);
  assert.equal(t.agentsActive, 0);
  assert.equal(t.agentsActiveInitiatives, 0);
  assert.equal(t.inFlight, 1);
  // The two tiles now read independently true statements ("Agents active 0 ·
  // none running" and "Active initiatives 1") instead of one tile whose
  // value and hint disagree.
});

// ─── Existing lines still hold ───────────────────────────────────────────────

test('spendLine keeps its three distinct claims', () => {
  assert.match(spendLine(proj({ agentSpendUsd: 3.5 })).text, /agent spend this month/);
  assert.match(spendLine(proj({ agentSpendUsd: 0, lastAgentActivityAt: '2026-06-01T00:00:00Z' })).text, /no agent spend this month/);
  assert.equal(spendLine(proj()).text, 'no agent runs yet');
});

test('workLine omits absent parts rather than zeroing them', () => {
  assert.equal(workLine(proj()), null);
  assert.equal(workLine(proj({ openStories: 1 })), '1 story');
});
