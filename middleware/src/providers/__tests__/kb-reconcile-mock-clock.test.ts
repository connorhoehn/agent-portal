// The reconcile page's synthetic sync state is stamped from the clock.
//
// `syncState`'s mock branch answered `new Date(Date.now() - 3 * 3_600_000)` —
// a wall-clock mint in a provider's `config.mock.aurora` branch, which rule 3
// of the mock floor forbids for two reasons this file exercises in turn.
//
// The second one is the one worth spelling out. What the page reads off this
// stamp is the DAY ("last sync: today" versus an index that has been behind for
// a while), not the age — the age is narrative flavor. Run the process at 00:20
// UTC and a flat sub-day offset puts the last sync on *yesterday*, so a
// knowledge base that just synced renders as a day stale. `keepWithinToday`
// clamps the offset to the elapsed part of the UTC day, which in the worst case
// is UTC midnight exactly: still today.
//
// WHAT MOVED. The stamp is no longer minted by the provider at all. `syncState`'s
// mock branch used to state four literals, including a `hoursAgo(3, …)` of its
// own; it now derives from `kbIngestionJobRows`, so the clamp has to hold in the
// *fixture's* helper. This file therefore stopped asserting the old branch's
// `09:00` literal — that number described code that no longer exists — and
// asserts the two properties that were ever the point: the stamp tracks the
// frozen clock (no wall-clock leak), and it never lands on yesterday.
//
// AND A TRAP THIS FILE FELL INTO. Fixture rows are materialized lazily and
// cached until reset (`mock/core/fixture.ts`: "a factory runs on first read, and
// again after every reset"). So freezing the clock *after* a read replays the
// previous freeze's timestamps — which is exactly what made the 00:20 case here
// report a stamp from the noon case. Re-freezing without resetting the registry
// is not a time change; it is a no-op with a misleading name. `freeze()` below
// does both, and that is also why the mock control plane's `POST /api/__mock/reset`
// is what re-stamps a running server's rows against the current clock.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { fixtureRegistry, freezeClock } from '../../mock/core/index.js';
import { reconcileKnowledgeBases } from '../kb-reconcile.js';

let restore = () => {};
afterEach(() => {
  restore();
  fixtureRegistry.resetAll('default');
});

/** Freeze at `at` AND drop materialized rows, so factories re-run under it. */
function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
  fixtureRegistry.resetAll('default');
}

/** The rows that matched a live knowledge base — the only ones with a sync. */
async function synced(): Promise<Array<{ slug: string | null; lastSyncAt: string | null }>> {
  const { entries } = await reconcileKnowledgeBases();
  return entries
    .filter((e) => e.lastSyncAt !== null)
    .map((e) => ({ slug: e.slug, lastSyncAt: e.lastSyncAt }));
}

describe('offline sync state', () => {
  it('stamps the last sync from the frozen clock, not the wall clock', async () => {
    freeze('2026-03-11T12:00:00.000Z');
    const rows = await synced();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Same UTC day as the freeze, and in its past — a wall-clock mint would
      // land on the real today, which is the failure this asserts against and
      // the one no fixed literal can express (the literal would just be wrong
      // on the day someone changes the fixture's offset).
      expect(r.lastSyncAt?.slice(0, 10)).toBe('2026-03-11');
      expect(Date.parse(r.lastSyncAt!)).toBeLessThanOrEqual(
        Date.parse('2026-03-11T12:00:00.000Z'),
      );
      // Recently, not weeks back: the newest job is what `syncState` reports,
      // and the fixture's newest is a sub-day offset.
      expect(Date.parse('2026-03-11T12:00:00.000Z') - Date.parse(r.lastSyncAt!))
        .toBeLessThan(12 * 3_600_000);
    }
  });

  it('at 00:20 UTC the last sync is still TODAY, clamped to midnight', async () => {
    freeze('2026-03-12T00:20:00.000Z');
    const rows = await synced();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Unclamped, the newest job's offset would put this on 2026-03-11 — the
      // previous day, which is the bug. Clamped, the worst case is exactly UTC
      // midnight of the current day.
      expect(r.lastSyncAt?.slice(0, 10)).toBe('2026-03-12');
      expect(Date.parse(r.lastSyncAt!))
        .toBeGreaterThanOrEqual(Date.parse('2026-03-12T00:00:00.000Z'));
      // And never the future: the clamp collapses the offset toward `now`, so
      // the `+minutes` addend has to be capped too.
      expect(Date.parse(r.lastSyncAt!))
        .toBeLessThanOrEqual(Date.parse('2026-03-12T00:20:00.000Z'));
    }
  });

  it('the drifted row has no sync state at all — it names a KB that does not exist', async () => {
    freeze('2026-03-11T12:00:00.000Z');
    const { entries } = await reconcileKnowledgeBases();
    const gone = entries.find((e) => e.slug === 'orgiq-legacy');
    expect(gone?.drift).toBe('missing');
    expect(gone?.lastSyncAt).toBeNull();
  });
});
