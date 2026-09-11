// Run with:  cd portal && node --test 'src/pages/knowledge/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptableEntries, bytes, computeSyncGap, filterEntries, lastSyncLabel, summarizeEntries,
  when, type Reconciled,
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
    // The default is "we read it" — every pre-existing test asserts about facts
    // the server established, and the degraded case is opted into explicitly
    // below so it cannot be entered by accident.
    syncStateKnown: true,
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

// ─── computeSyncGap — a read that failed is not a fact ───────────────────────
//
// The deployed page said "157 documents are in storage but have never been
// indexed" about a knowledge base with two COMPLETE ingestion jobs. The server
// was honest — `bedrock:ListIngestionJobs` was denied, so it returned nulls —
// and `neverRan = !lastSync` promoted those nulls to a claim. The IAM grant
// removed that particular symptom; these tests remove the inference, so the
// next unreadable history reads as unreadable instead.

test('computeSyncGap: an unreadable sync history is not "never ran"', () => {
  const target = entry({
    slug: 'a', drift: 'ok', liveKbId: 'l1',
    // Exactly the deployed shape: the data source count WAS read, the history
    // was not. Losing that asymmetry is what made the page confident.
    dataSourceCount: 1, lastSyncAt: null, lastSyncStatus: null, lastSyncScanned: null,
    syncStateKnown: false,
  });
  const gap = computeSyncGap([target], 157);
  assert.equal(gap.syncUnknown, true);
  assert.equal(gap.neverRan, false, 'must not claim the KB was never indexed');
  assert.equal(gap.behind, false, 'must not claim the KB is behind either');
  // Still the row a manual sync would target — not knowing the history is no
  // reason to hide the only action available.
  assert.equal(gap.syncTarget?.slug, 'a');
});

test('computeSyncGap: one unreadable row makes the fleet-wide lastSync unassertable', () => {
  // `lastSync` is a maximum over every live row, so the newest sync could be
  // the one we could not see — a second row reporting a real sync does not
  // rescue the claim about the first.
  const gap = computeSyncGap([
    entry({ slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 1, syncStateKnown: false }),
    entry({
      slug: 'b', drift: 'ok', liveKbId: 'l2', dataSourceCount: 1,
      lastSyncAt: '2026-09-01T00:00:00Z', lastSyncScanned: 10,
    }),
  ], 100);
  assert.equal(gap.syncUnknown, true);
  assert.equal(gap.behind, false);
  assert.equal(gap.neverRan, false);
});

test('computeSyncGap: a readable history still reports behind/never-ran', () => {
  // The fix must not simply silence the detector — that would trade a false
  // alarm for a missed one, and the stuck pipeline is the state this page
  // exists to catch.
  const gap = computeSyncGap(
    [entry({ slug: 'a', drift: 'ok', liveKbId: 'l1', dataSourceCount: 1, lastSyncAt: null })],
    100,
  );
  assert.equal(gap.syncUnknown, false);
  assert.equal(gap.neverRan, true);
  assert.equal(gap.behind, true);
});

test('summarizeEntries: an unreadable data-source count is not a counted zero', () => {
  // `dataSources === 0` renders as "no data source attached". A null must not
  // reach that branch, so the total ships with a flag saying it is a floor.
  const known = summarizeEntries([
    entry({ slug: 'a', liveKbId: 'l1', dataSourceCount: 0 }),
  ]);
  assert.equal(known.dataSources, 0);
  assert.equal(known.dataSourcesKnown, true, 'a counted zero is a fact');

  const unknown = summarizeEntries([
    entry({ slug: 'a', liveKbId: 'l1', dataSourceCount: null, syncStateKnown: false }),
  ]);
  assert.equal(unknown.dataSources, 0);
  assert.equal(unknown.dataSourcesKnown, false, 'an uncounted zero is not');
});

test('computeSyncGap: a sync in flight is a state, not the absence of a gap', () => {
  // The regression this pins. A running job reports no `numberOfDocumentsScanned`
  // and a fresh `updatedAt`, so `behind` fell through to false and the banner
  // simply vanished — the page looked settled over an index holding nothing.
  const gap = computeSyncGap(
    [entry({ lastSyncStatus: 'IN_PROGRESS', lastSyncAt: '2026-09-11T12:00:00Z', lastSyncScanned: null })],
    157,
  );
  assert.equal(gap.running, true, 'the run is in flight and must be sayable');
  assert.equal(gap.behind, false, 'not "behind" — a sync is already working on it');
  assert.equal(gap.failed, false);
  assert.equal(gap.lastSyncStatus, 'IN_PROGRESS', 'the raw status travels so a UI can name it');

  // STARTING is the same state under a different word, and so is STOPPING.
  for (const status of ['STARTING', 'STOPPING']) {
    const g = computeSyncGap([entry({ lastSyncStatus: status, lastSyncAt: '2026-09-11T12:00:00Z' })], 157);
    assert.equal(g.running, true, `${status} is in flight`);
    assert.equal(g.behind, false, `${status} must not offer another sync`);
  }
});

test('computeSyncGap: a failed run is distinguishable from one nobody started', () => {
  // Both used to render as the same "behind" banner, whose copy reads as
  // "nobody has synced yet" and whose button is the one that just failed.
  const failed = computeSyncGap(
    [entry({ lastSyncStatus: 'FAILED', lastSyncAt: '2026-09-11T12:00:00Z', lastSyncScanned: 0 })],
    157,
  );
  assert.equal(failed.failed, true);
  assert.equal(failed.neverRan, false, 'it ran — it just did not work');
  assert.equal(failed.running, false);

  const never = computeSyncGap([entry({ lastSyncStatus: null, lastSyncAt: null })], 157);
  assert.equal(never.failed, false);
  assert.equal(never.neverRan, true);
  assert.notEqual(failed.failed, never.failed, 'the two states must not collapse');
});

test('computeSyncGap: an unreadable history claims neither running nor failed', () => {
  // `syncStateKnown: false` means the three sync fields mean nothing, and a
  // status read off them would be an invention.
  const gap = computeSyncGap(
    [entry({ syncStateKnown: false, lastSyncStatus: 'FAILED', lastSyncAt: '2026-09-11T12:00:00Z' })],
    157,
  );
  assert.equal(gap.syncUnknown, true);
  assert.equal(gap.running, false);
  assert.equal(gap.failed, false);
  assert.equal(gap.lastSyncStatus, null, 'no status is assertable from an unread history');
});

test('lastSyncLabel: a bare timestamp is only honest for a COMPLETE run', () => {
  // The row's "Last sync" column rendered `when(lastSyncAt)` alone, and
  // `lastSyncAt` is the newest job's timestamp whatever its outcome — so a
  // failure two minutes ago read exactly like a success two minutes ago.
  const iso = new Date(Date.now() - 2 * 60_000).toISOString();
  assert.equal(lastSyncLabel(entry({ lastSyncStatus: 'COMPLETE', lastSyncAt: iso })), '2m ago');
  assert.match(lastSyncLabel(entry({ lastSyncStatus: 'FAILED', lastSyncAt: iso })), /^failed · 2m ago$/);
  assert.match(
    lastSyncLabel(entry({ lastSyncStatus: 'IN_PROGRESS', lastSyncAt: iso })),
    /^in progress · 2m ago$/,
    'underscores are a wire detail, not a word',
  );
  assert.equal(lastSyncLabel(entry({ lastSyncAt: null })), 'never');
  assert.equal(
    lastSyncLabel(entry({ syncStateKnown: false, lastSyncAt: iso })),
    'unreadable',
    'a timestamp from an unread history is not a timestamp',
  );
});
