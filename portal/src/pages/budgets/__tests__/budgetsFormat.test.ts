// Run with:  cd portal && node --test 'src/pages/budgets/__tests__/*.test.ts'
//
// Same runner as the projects tests — plain node:test, no DOM. Everything in
// budgetsFormat is pure by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  usd, modelLabelFor, ago, maintenanceStats, maintenanceTitle,
  mergeInitiativesWithBudgets, remainingHint, remainingTitle, rowBudgetStats,
} from '../budgetsFormat.ts';
import type { BudgetRow } from '../types.ts';

function budgetRow(over: Partial<BudgetRow> & { orgProjectId: string }): BudgetRow {
  return {
    orgProjectName: null, allocatedUsd: null, period: null, updatedBy: null,
    updatedAt: null, spentThisPeriodUsd: 0, runCountThisPeriod: 0,
    lastAgentActivityAt: null, maintenanceUsd: 0,
    ...over,
  };
}

// ─── usd ─────────────────────────────────────────────────────────────────────

test('usd always shows two decimals and thousands separators', () => {
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(1234.5), '$1,234.50');
  assert.equal(usd(-42), '$-42.00');
});

// ─── modelLabelFor ───────────────────────────────────────────────────────────

test('modelLabelFor resolves a known Bedrock id and passes an unknown one through', () => {
  assert.notEqual(modelLabelFor('us.anthropic.claude-haiku-4-5-20251001-v1:0'), 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
  assert.equal(modelLabelFor('some-unlisted-model'), 'some-unlisted-model');
});

// ─── ago ─────────────────────────────────────────────────────────────────────

test('ago handles null, recent, and Aurora-shaped (no T/Z) timestamps', () => {
  assert.equal(ago(null), 'never');
  const now = new Date().toISOString();
  assert.equal(ago(now), 'just now');
  const auroraShaped = now.replace('T', ' ').replace('Z', '');
  assert.equal(ago(auroraShaped), 'just now');
});

test('ago buckets into minutes, hours, days', () => {
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  assert.match(ago(minsAgo(5)), /^5m ago$/);
  assert.match(ago(minsAgo(120)), /^2h ago$/);
  assert.match(ago(minsAgo(2880)), /^2d ago$/);
});

// ─── maintenanceStats ────────────────────────────────────────────────────────

test('maintenanceStats: zero spend reads as "scheduled bots", not a percent', () => {
  const stats = maintenanceStats(0, 0);
  assert.equal(stats.hint, 'scheduled bots');
  assert.equal(stats.floorIsAllSpend, false);
});

test('maintenanceStats: a floor that IS all spend says so in words, not "100%"', () => {
  const stats = maintenanceStats(10, 10);
  assert.equal(stats.floorIsAllSpend, true);
  assert.equal(stats.hint, 'all spend so far · no new work funded');
});

test('maintenanceStats: partial floor shows the percent', () => {
  const stats = maintenanceStats(100, 25);
  assert.equal(stats.floorIsAllSpend, false);
  assert.equal(stats.floorPct, 25);
  assert.equal(stats.hint, '25% of spend · scheduled bots');
});

test('maintenanceTitle switches copy on floorIsAllSpend', () => {
  assert.match(maintenanceTitle(true, 'September 2026'), /September 2026/);
  assert.match(maintenanceTitle(false, 'September 2026'), /recurring baseline/);
});

// ─── remaining ────────────────────────────────────────────────────────────────

test('remainingHint flags over-allocation instead of a bare negative number', () => {
  assert.equal(remainingHint(-5), 'over allocation');
  assert.equal(remainingHint(0), 'allocated − spent');
  assert.equal(remainingHint(100), 'allocated − spent');
});

test('remainingTitle only mentions the floor when one exists', () => {
  assert.match(remainingTitle(10, 40, 'September 2026'), /scheduled-bot floor/);
  assert.equal(remainingTitle(0, 40, 'September 2026'), 'Allocated minus spend so far this period.');
});

// ─── rowBudgetStats ───────────────────────────────────────────────────────────

test('rowBudgetStats: unallocated with spend is the blind spot', () => {
  const s = rowBudgetStats({ allocatedUsd: null, spentThisPeriodUsd: 12 });
  assert.equal(s.blindSpot, true);
  assert.equal(s.remaining, null);
  assert.equal(s.burn, null);
});

test('rowBudgetStats: unallocated with no spend is not a blind spot', () => {
  const s = rowBudgetStats({ allocatedUsd: null, spentThisPeriodUsd: 0 });
  assert.equal(s.blindSpot, false);
});

test('rowBudgetStats: allocated computes remaining and burn ratio', () => {
  const s = rowBudgetStats({ allocatedUsd: 100, spentThisPeriodUsd: 40 });
  assert.equal(s.blindSpot, false);
  assert.equal(s.remaining, 60);
  assert.equal(s.burn, 0.4);
});

test('rowBudgetStats: zero-dollar allocation never divides by zero', () => {
  const s = rowBudgetStats({ allocatedUsd: 0, spentThisPeriodUsd: 0 });
  assert.equal(s.burn, null);
  assert.equal(s.remaining, 0);
});

// ─── mergeInitiativesWithBudgets (program-owner DEFECTS #7) ──────────────────

test('mergeInitiativesWithBudgets: every initiative appears, allocated or not', () => {
  const initiatives = [
    { id: 'p-a', name: 'Alpha' },
    { id: 'p-b', name: 'Beta' },
    { id: 'p-mobile-redesign', name: 'Mobile App Redesign' },
  ];
  const budgets = [budgetRow({ orgProjectId: 'p-a', orgProjectName: 'Alpha', allocatedUsd: 60 })];
  const merged = mergeInitiativesWithBudgets(initiatives, budgets);

  assert.equal(merged.length, 3);
  const byId = new Map(merged.map((r) => [r.orgProjectId, r]));
  assert.equal(byId.get('p-a')?.allocatedUsd, 60);
  // Neither allocated nor spent — still a row, so "Set budget" has something
  // to attach to, unlike when the table was sourced from /api/budgets alone.
  assert.equal(byId.get('p-mobile-redesign')?.allocatedUsd, null);
  assert.equal(byId.get('p-mobile-redesign')?.spentThisPeriodUsd, 0);
  assert.equal(byId.get('p-mobile-redesign')?.orgProjectName, 'Mobile App Redesign');
});

test('mergeInitiativesWithBudgets: a budget row missing from the initiative list is kept, not dropped', () => {
  const initiatives = [{ id: 'p-a', name: 'Alpha' }];
  const budgets = [
    budgetRow({ orgProjectId: 'p-a', allocatedUsd: 10 }),
    budgetRow({ orgProjectId: 'p-stale', orgProjectName: 'Stale', spentThisPeriodUsd: 5 }),
  ];
  const merged = mergeInitiativesWithBudgets(initiatives, budgets);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((r) => r.orgProjectId === 'p-stale' && r.spentThisPeriodUsd === 5));
});
