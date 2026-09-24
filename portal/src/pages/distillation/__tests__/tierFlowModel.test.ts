// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tierFlowModel, attentionFor, activityDot, agoLabel, tierCount, tierHealth } from '../tierFlowModel.ts';
import type { TierLevel } from '../types.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function tiers(over: Partial<Record<'L0' | 'L1' | 'L2', Partial<TierLevel>>> = {}): TierLevel[] {
  return [
    { level: 'L0', count: 304, writers: 3, backlog: 40, health: { state: 'ok', reason: '', lagSeconds: 0 }, ...over.L0 },
    { level: 'L1', count: 22, backlog: 0, lastCompletedAt: '2026-09-24T11:10:00Z', health: { state: 'ok', reason: '', lagSeconds: 0 }, ...over.L1 },
    { level: 'L2', count: 11, backlog: 0, lastCompletedAt: '2026-09-24T00:00:00Z', health: { state: 'ok', reason: '', lagSeconds: 0 }, ...over.L2 },
  ];
}

test('strip: four items and three labelled connectors, in order', () => {
  const m = tierFlowModel(tiers(), 6, { nowMs: NOW });
  assert.deepEqual(m.items.map((i) => [i.id, i.label, i.value]), [
    ['L0', 'Run notes', 304], ['L1', 'Patterns', 22], ['L2', 'Guides & findings', 11], ['library', 'Library', 6],
  ]);
  assert.deepEqual(m.connectors.map((c) => c.label), ['Compact', 'Compact', 'Publish']);
  assert.equal(m.items[0].href, '/iq/distillation/knowledge?view=notes');
  assert.equal(m.items[2].href, '/iq/distillation/knowledge');
  assert.equal(m.items[3].href, '/iq/library');
});

test('healthy tiers: L0 says who is writing, a backlog says waiting, no attention', () => {
  const m = tierFlowModel(tiers({ L1: { backlog: 5 } }), 6, { nowMs: NOW });
  assert.deepEqual(m.items[0].status, { label: '3 writing', tone: 'info' });
  assert.deepEqual(m.items[1].status, { label: '5 waiting', tone: 'neutral' });
  assert.equal(m.items[2].status, undefined);
  assert.equal(m.attention, null);
  assert.equal(m.dot, null);
  assert.equal(m.connectors[0].tone, undefined);
});

test('behind and stalled come from health and colour the inbound connector', () => {
  const m = tierFlowModel(tiers({
    L1: { health: { state: 'behind', reason: 'backlog growing', lagSeconds: 3000 } },
    L2: { health: { state: 'stalled', reason: 'no pass in 12h', lagSeconds: 43200 } },
  }), 6, { nowMs: NOW });
  assert.deepEqual(m.items[1].status, { label: '50m behind', tone: 'warning' });
  assert.deepEqual(m.items[2].status, { label: 'Stalled', tone: 'danger' });
  assert.equal(m.items[1].reason, 'backlog growing');
  assert.equal(m.connectors[0].tone, 'warning');
  assert.equal(m.connectors[1].tone, 'danger');
  assert.equal(m.connectors[2].tone, undefined);
  assert.equal(m.dot, 'danger');
});

test('status line picks the most severe tier and quotes its last run', () => {
  const a = attentionFor(tiers({
    L1: { health: { state: 'behind', reason: 'r1', lagSeconds: 9000 } },
    L2: { health: { state: 'stalled', reason: 'no pass since midnight', lagSeconds: 100 } },
  }), [], NOW);
  assert.ok(a);
  assert.equal(a.level, 'L2');
  assert.equal(a.title, 'Guide updates stalled · Last run 12h ago');
  assert.equal(a.detail, 'no pass since midnight');
  assert.equal(a.tone, 'danger');
  assert.equal(a.actionLabel, 'View runs');
  assert.equal(a.actionHref, '/iq/distillation/activity?level=L2');
});

test('"Guide updates delayed · Last run 12h ago" for a behind L2', () => {
  const a = attentionFor(tiers({ L2: { health: { state: 'behind', reason: 'x', lagSeconds: 600 } } }), [], NOW);
  assert.equal(a?.title, 'Guide updates delayed · Last run 12h ago');
  assert.equal(a?.tone, 'warning');
});

test('ties go to the larger lag; a tier with no completed run says so', () => {
  const a = attentionFor(tiers({
    L1: { lastCompletedAt: null, health: { state: 'behind', reason: 'a', lagSeconds: 7200 } },
    L2: { health: { state: 'behind', reason: 'b', lagSeconds: 600 } },
  }), [], NOW);
  assert.equal(a?.level, 'L1');
  assert.equal(a?.title, 'Pattern updates delayed · No completed run yet');
});

test('an old lastCompletedAt with an ok verdict is NOT a problem', () => {
  const m = tierFlowModel(tiers({ L2: { lastCompletedAt: '2026-09-01T00:00:00Z' } }), 6, { nowMs: NOW });
  assert.equal(m.attention, null);
  assert.equal(m.dot, null);
  assert.equal(m.items[2].status, undefined);
});

test('no verdict at all is unknown — not healthy, not a warning', () => {
  const bare: TierLevel[] = [{ level: 'L0', items: 5 }, { level: 'L1' }, { level: 'L2', count: 2 }];
  const m = tierFlowModel(bare, null, { nowMs: NOW });
  assert.deepEqual(m.items.map((i) => i.verdict), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(m.items.map((i) => i.value), [5, null, 2, null], 'legacy items read; missing stays null');
  assert.equal(m.items[3].ariaLabel, 'Library, linked count unknown');
  assert.equal(m.dot, null);
});

test('legacy health[] verdicts are read when a level carries none', () => {
  const bare: TierLevel[] = [{ level: 'L0', items: 5 }, { level: 'L1', items: 2, lagSeconds: 1800 }, { level: 'L2', items: 1 }];
  const legacy = [{ level: 'L1' as const, status: 'behind' as const, reason: 'old verdict' }];
  assert.deepEqual(tierHealth(bare[1], legacy), { state: 'behind', reason: 'old verdict', lagSeconds: 1800 });
  assert.equal(activityDot(bare, legacy), 'warning');
  const m = tierFlowModel(bare, 0, { legacyHealth: legacy, nowMs: NOW });
  assert.deepEqual(m.items[1].status, { label: '30m behind', tone: 'warning' });
});

test('activityDot', () => {
  assert.equal(activityDot(tiers()), null);
  assert.equal(activityDot(tiers({ L0: { health: { state: 'behind', reason: '', lagSeconds: 1 } } })), 'warning');
  assert.equal(activityDot(tiers({ L1: { health: { state: 'stalled', reason: '', lagSeconds: 1 } } })), 'danger');
});

test('agoLabel and tierCount', () => {
  assert.equal(agoLabel('2026-09-24T11:59:30Z', NOW), 'just now');
  assert.equal(agoLabel('2026-09-24T11:10:00Z', NOW), '50m ago');
  assert.equal(agoLabel('2026-09-24 00:00:00+00', NOW), '12h ago');
  assert.equal(agoLabel('2026-09-20T12:00:00Z', NOW), '4d ago');
  assert.equal(agoLabel(null, NOW), '');
  assert.equal(agoLabel('not a date', NOW), '');
  assert.equal(tierCount({ level: 'L0', count: 0, items: 9 }), 0);
  assert.equal(tierCount(undefined), null);
});
