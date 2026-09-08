// Run with:  cd portal && node --test 'src/pages/knowledge/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptableEntries, bytes, computeSyncGap, filterEntries, summarizeEntries, when,
  type Reconciled,
} from '../knowledgeFormat.ts';

function entry(overrides: Partial<Reconciled>): Reconciled {
  return {
    id: 'kb-1',
    slug: 'orgiq',
    name: 'OrgIQ',
    tenant: 'orgiq',
    registryKbId: 'reg-1',
    registryStatus: 'ACTIVE',
    liveKbId: 'reg-1',
    liveStatus: 'ACTIVE',
    dataSourceCount: 1,
    lastSyncStatus: 'COMPLETE',
    lastSyncAt: null,
    lastSyncScanned: null,
    documentCount: 0,
    drift: 'ok',
    detail: 'in sync',
    ...overrides,
  };
}

// ─── bytes / when ────────────────────────────────────────────────────────────

test('bytes formats zero/undefined/null as 0 B and scales units', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(undefined), '0 B');
  assert.equal(bytes(null), '0 B');
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(2048), '2.0 KB');
  assert.equal(bytes(1_500_000), '1.4 MB');
});

test('when reports never for a missing timestamp and relative age otherwise', () => {
  assert.equal(when(null), 'never');
  assert.equal(when(undefined), 'never');
  const now = new Date().toISOString();
  assert.equal(when(now), 'just now');
});

// ─── filterEntries ───────────────────────────────────────────────────────────

test('filterEntries "attention" status drops rows in sync', () => {
  const ok = entry({ slug: 'a', drift: 'ok' });
  const bad = entry({ slug: 'b', drift: 'missing' });
  const entries = [ok, bad];
  assert.deepEqual(filterEntries(entries, { search: '', status: 'all' }).map((e) => e.slug), ['a', 'b']);
  assert.deepEqual(filterEntries(entries, { search: '', status: 'attention' }).map((e) => e.slug), ['b']);
});

test('filterEntries search matches name, slug or either kb id, case-insensitively', () => {
  const a = entry({ slug: 'assessment', name: 'Assessment KB', registryKbId: 'reg-abc', liveKbId: 'live-xyz' });
  const b = entry({ slug: 'orgiq', name: 'OrgIQ KB', registryKbId: 'reg-def', liveKbId: 'live-uvw' });
  const entries = [a, b];
  assert.deepEqual(filterEntries(entries, { search: 'assessment', status: 'all' }).map((e) => e.slug), ['assessment']);
  assert.deepEqual(filterEntries(entries, { search: 'REG-DEF', status: 'all' }).map((e) => e.slug), ['orgiq']);
  assert.deepEqual(filterEntries(entries, { search: 'live-xyz', status: 'all' }).map((e) => e.slug), ['assessment']);
  assert.deepEqual(filterEntries(entries, { search: 'nope', status: 'all' }), []);
});

// ─── summarizeEntries / adoptableEntries ─────────────────────────────────────

test('summarizeEntries counts live rows, problems, docs and data sources', () => {
  const entries = [
    entry({ slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 2, documentCount: 10 }),
    entry({ slug: 'b', drift: 'missing', liveKbId: null, dataSourceCount: null, documentCount: 5 }),
  ];
  const s = summarizeEntries(entries);
  assert.equal(s.live.length, 1);
  assert.equal(s.problems.length, 1);
  assert.equal(s.docs, 15);
  assert.equal(s.dataSources, 2);
});

test('adoptableEntries only offers rows whose registry pointer is broken', () => {
  const missing = entry({ slug: 'a', drift: 'missing' });
  const unprovisioned = entry({ slug: 'b', drift: 'unprovisioned' });
  const noSlug = entry({ slug: null, drift: 'missing' });
  assert.deepEqual(adoptableEntries([missing, unprovisioned, noSlug]).map((e) => e.slug), ['a']);
});

// ─── computeSyncGap ──────────────────────────────────────────────────────────

test('computeSyncGap: never synced with storage populated is "never ran"', () => {
  const target = entry({ slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 1, lastSyncAt: null });
  const gap = computeSyncGap([target], 100);
  assert.equal(gap.neverRan, true);
  assert.equal(gap.behind, true);
  assert.equal(gap.syncTarget?.slug, 'a');
});

test('computeSyncGap: fully scanned and current is not behind', () => {
  const target = entry({
    slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 1,
    lastSyncAt: '2026-09-01T00:00:00Z', lastSyncScanned: 100,
  });
  const gap = computeSyncGap([target], 100);
  assert.equal(gap.neverRan, false);
  assert.equal(gap.behind, false);
});

test('computeSyncGap: scanned fewer documents than storage holds now is behind', () => {
  const target = entry({
    slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 1,
    lastSyncAt: '2026-09-01T00:00:00Z', lastSyncScanned: 40,
  });
  const gap = computeSyncGap([target], 100);
  assert.equal(gap.neverRan, false);
  assert.equal(gap.behind, true);
});

test('computeSyncGap: empty storage is never "behind"', () => {
  const gap = computeSyncGap([], 0);
  assert.equal(gap.behind, false);
  assert.equal(gap.syncTarget, null);
});

test('computeSyncGap ignores a candidate with no data source', () => {
  const target = entry({ slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 0 });
  const gap = computeSyncGap([target], 100);
  assert.equal(gap.syncTarget, null);
});
