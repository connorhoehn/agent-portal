// Run with:  cd portal && node --test 'src/pages/budgets/__tests__/*.test.ts'
//
// The spend report's pure derivations: options and URLs, how a figure reads
// (unknown never $0, withheld never zero), the floor / discretionary columns,
// the fit pill, envelope burn, the list rail and the people × envelopes join.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  budgetRailRows, discretionaryBudget, envelopeBurn, fitPill, floorFigure, groupLabel, mergeInitiativeLedger,
  moneyOrDash, parseGroupBy, parsePeriod, peopleWithEnvelopes, periodHeading, remainingTone, spendFigure, spendReportUrl,
  OVERVIEW_ROW_ID, botHref, entryCost, spendEntriesUrl, spendReportPageHref,
} from '../spendReportModel.ts';
import type { BudgetRow, SpendEnvelope, SpendGroup } from '../types.ts';

function budget(over: Partial<BudgetRow> & { orgProjectId: string }): BudgetRow {
  return {
    orgProjectName: null, allocatedUsd: null, period: null, updatedBy: null, updatedByName: null, updatedAt: null,
    spentThisPeriodUsd: 0, runCountThisPeriod: 0, lastAgentActivityAt: null, maintenanceUsd: 0, ...over,
  };
}

function group(over: Partial<SpendGroup> & { key: string | null }): SpendGroup {
  return { label: over.key ?? 'Unattributed', knownUsd: 0, unknownCount: 0, entries: 0, burnPerDay7d: 0, projectedPeriodEndUsd: 0, heldUsd: 0, ...over };
}

function envelope(over: Partial<SpendEnvelope> & { grantId: string }): SpendEnvelope {
  return {
    granteePersonId: 'p-1', granteeName: 'Pat', granteeUserId: 'p-data-lake', sprintId: 's1', sprintName: 'Sprint 1', sprintStatus: 'active',
    startsOn: '2026-10-15', endsOn: '2026-10-29', allocatedUsd: 20, spentUsd: 5, unknownCount: 0, heldUsd: 0, remainingUsd: 15,
    attributionAvailable: true, initiativeSpendInWindowUsd: 9, ...over,
  };
}

test('options parse to their defaults and the initiative grouping always reads the budget month', () => {
  assert.equal(parseGroupBy('actor'), 'actor');
  assert.equal(parseGroupBy('team'), 'initiative');
  assert.equal(parsePeriod(null), 'month');
  assert.equal(spendReportUrl('model', '7d'), '/api/spend/report?groupBy=model&period=7d');
  assert.equal(spendReportUrl('initiative', '7d'), '/api/spend/report?groupBy=initiative&period=month');
  assert.equal(spendReportUrl('actor', '30d', 'p-auth-migration'), '/api/spend/report?groupBy=actor&period=month&initiativeId=p-auth-migration');
  assert.equal(periodHeading('7d'), 'Spent, 7 days');
});

test('spendFigure: unknown costs are counted beside the dollars and never read as $0; withheld is null', () => {
  assert.deepEqual(spendFigure(1.5, 0), { text: '$1.50', unknown: null });
  assert.deepEqual(spendFigure(1.5, 2), { text: '$1.50', unknown: '2 unknown' });
  assert.deepEqual(spendFigure(0, 3), { text: 'unknown', unknown: '3 unknown' });
  assert.deepEqual(spendFigure(0, 0), { text: '$0.00', unknown: null });
  assert.equal(spendFigure(undefined, 3), null);
  assert.equal(moneyOrDash(null), '—');
  assert.equal(moneyOrDash(undefined), '—');
});

test('groupLabel resolves a model id to its short label and keeps the server label otherwise', () => {
  assert.notEqual(groupLabel({ key: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'x' }, 'model'), 'x');
  assert.equal(groupLabel({ key: 'unknown', label: 'Model not recorded' }, 'model'), 'Model not recorded');
  assert.equal(groupLabel({ key: 'u-a', label: 'Ann' }, 'actor'), 'Ann');
});

test('remainingTone flags over (danger) and under a tenth of the allocation (warning)', () => {
  assert.equal(remainingTone(-1, 10), 'danger');
  assert.equal(remainingTone(0.5, 10), 'warning');
  assert.equal(remainingTone(5, 10), undefined);
  assert.equal(remainingTone(null, 10), undefined);
});

test('mergeInitiativeLedger joins held, projected and the larger unknown count onto each Budgets row', () => {
  const [a, b] = mergeInitiativeLedger(
    [budget({ orgProjectId: 'p-auth-migration', unknownCostCount: 1 }), budget({ orgProjectId: 'p-cost-opt' })],
    [group({ key: 'p-auth-migration', heldUsd: 2, projectedPeriodEndUsd: 30, unknownCount: 3 })],
  );
  assert.equal(a!.heldUsd, 2);
  assert.equal(a!.projectedPeriodEndUsd, 30);
  assert.equal(a!.ledgerUnknownCount, 3);
  assert.equal(b!.heldUsd, undefined);
  assert.equal(b!.ledgerUnknownCount, 0);
});

test('floorFigure reads the floor against its reserve, says off, and has no reserve without an allocation', () => {
  assert.equal(floorFigure(budget({ orgProjectId: 'p', allocatedUsd: 50, reserveUsd: 3.3, reserveSource: 'auto', floorSpentUsd: 1.2 })).text, '$1.20 of $3.30');
  assert.equal(floorFigure(budget({ orgProjectId: 'p', allocatedUsd: 50, reserveUsd: 0, reserveSource: 'off', floorSpentUsd: 1 })).text, 'off');
  assert.equal(floorFigure(budget({ orgProjectId: 'p', maintenanceUsd: 0.4 })).text, '$0.40 spent');
  assert.equal(floorFigure(budget({ orgProjectId: 'p' })).text, '—');
});

test('discretionaryBudget is the allocation after the larger of the reserve and the floor actually used', () => {
  assert.equal(discretionaryBudget(budget({ orgProjectId: 'p', allocatedUsd: 50, reserveUsd: 5, floorSpentUsd: 2 })), 45);
  assert.equal(discretionaryBudget(budget({ orgProjectId: 'p', allocatedUsd: 50, reserveUsd: 5, floorSpentUsd: 6, floorHeldUsd: 1 })), 43);
  assert.equal(discretionaryBudget(budget({ orgProjectId: 'p' })), null);
});

test('fitPill: fits, over remaining, no estimate, no allocation, and withheld', () => {
  assert.equal(fitPill({ fitsRemaining: true, basis: 'forecast' }, true)!.label, 'fits');
  assert.equal(fitPill({ fitsRemaining: false, basis: 'estimate' }, true)!.state, 'warning');
  assert.equal(fitPill({ fitsRemaining: null, basis: null }, true)!.label, 'no estimate');
  assert.equal(fitPill({ fitsRemaining: null, basis: 'forecast' }, false)!.label, 'no allocation');
  assert.equal(fitPill({ basis: 'forecast' }, true), null);
});

test('envelopeBurn is unknown, never $0, when the grantee cannot be attributed', () => {
  assert.equal(envelopeBurn(envelope({ grantId: 'g', spentUsd: null, granteeUserId: null })).text, 'unknown');
  assert.match(envelopeBurn(envelope({ grantId: 'g', spentUsd: null, granteeUserId: null })).title, /no linked account/);
  assert.deepEqual(
    (({ text, unknown }) => ({ text, unknown }))(envelopeBurn(envelope({ grantId: 'g', spentUsd: 4, unknownCount: 1 }))),
    { text: '$4.00', unknown: '1 unknown' },
  );
});

test('budgetRailRows puts the overview first and marks blind spots', () => {
  const rows = budgetRailRows([
    budget({ orgProjectId: 'p-auth-migration', orgProjectName: 'A', allocatedUsd: 20, spentThisPeriodUsd: 5 }),
    budget({ orgProjectId: 'p-cost-opt', orgProjectName: 'B', spentThisPeriodUsd: 2 }),
    budget({ orgProjectId: 'p-c', orgProjectName: 'C' }),
  ], { allocated: 20, spent: 7 });
  assert.deepEqual(rows.map((r) => [r.id, r.subline, r.blindSpot]), [
    [OVERVIEW_ROW_ID, '$7.00 of $20.00', false],
    ['p-auth-migration', '$5.00 of $20.00', false],
    ['p-cost-opt', '$2.00 · unallocated', true],
    ['p-c', 'unallocated', false],
  ]);
});

test('peopleWithEnvelopes joins spend and envelopes per person, keeps unlinked grantees, and puts "no person" last', () => {
  const rows = peopleWithEnvelopes(
    [group({ key: null, label: 'No person', knownUsd: 9 }), group({ key: 'p-data-lake', label: 'Pat', knownUsd: 3 }), group({ key: 'p-design-v3', label: 'Sam', knownUsd: 7 })],
    [
      envelope({ grantId: 'g1' }),
      envelope({ grantId: 'g0', sprintStatus: 'done' }),
      envelope({ grantId: 'g2', granteeUserId: null, granteePersonId: 'p-9', granteeName: 'Unlinked', spentUsd: null }),
    ],
  );
  assert.deepEqual(rows.map((r) => [r.id, r.envelope?.grantId ?? null, r.otherEnvelopes, r.spend?.knownUsd ?? null]), [
    ['p-data-lake', 'g1', 1, 3],
    ['person:p-9', 'g2', 0, null],
    ['p-design-v3', null, 0, 7],
    ['__none', null, 0, 9],
  ]);
});

test('the bot grouping is an option and parses back', () => {
  assert.equal(parseGroupBy('bot'), 'bot');
});

test('the entries URL carries the group, an empty key for the group with none, and the period', () => {
  assert.equal(spendEntriesUrl('bot', 'b-1', '30d', 25), '/api/spend/entries?groupBy=bot&key=b-1&period=30d&limit=25');
  assert.equal(spendEntriesUrl('bot', null, '7d', 50), '/api/spend/entries?groupBy=bot&key=&period=7d&limit=50');
  assert.equal(spendEntriesUrl('initiative', 'p-1', '7d', 25), '/api/spend/entries?groupBy=initiative&key=p-1&period=month&limit=25');
});

test('the spend report page URL carries the grouping and the period', () => {
  assert.equal(spendReportPageHref('bot', '30d'), '/iq/budgets?group=bot&period=30d');
  assert.equal(spendReportPageHref('bot', 'month'), '/iq/budgets?group=bot');
});

test('only a real bot key has a bot page', () => {
  assert.equal(botHref('b-1'), '/iq/bots/b-1');
  assert.equal(botHref(null), null);
});

test('an entry cost is unknown, never $0; withheld is null; an estimate says so', () => {
  assert.deepEqual(entryCost(null, 'unknown'), { text: 'unknown', note: null });
  assert.equal(entryCost(undefined, 'reported'), null);
  assert.deepEqual(entryCost(0.0123, 'estimated'), { text: '$0.0123', note: 'estimated' });
  assert.deepEqual(entryCost(0, 'reported'), { text: '$0.0000', note: null });
});
