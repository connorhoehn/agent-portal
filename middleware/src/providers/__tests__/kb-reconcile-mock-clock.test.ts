// The reconcile page's synthetic sync state is stamped from the clock.
//
// `syncState`'s mock branch answered `new Date(Date.now() - 3 * 3_600_000)` —
// a wall-clock mint in a provider's `config.mock.aurora` branch, which rule 3
// of the mock floor forbids for two reasons this file exercises in turn.
//
// The second one is the one worth spelling out. What the page reads off this
// stamp is the DAY ("last sync: today, COMPLETE" versus an index that has been
// behind for a while), not the three hours — the age is narrative flavor. Run
// the process at 00:20 UTC and a flat three-hour offset puts the last sync on
// *yesterday*, so a knowledge base that just synced renders as a day stale.
// `keepWithinToday` clamps the offset to the elapsed part of the UTC day,
// which in the worst case is UTC midnight exactly: still today.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { freezeClock } from '../../mock/core/index.js';
import { reconcileKnowledgeBases } from '../kb-reconcile.js';

let restore = () => {};
afterEach(() => restore());

function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

/** The rows that matched a live knowledge base — the only ones with a sync. */
async function synced(): Promise<Array<{ slug: string | null; lastSyncAt: string | null }>> {
  const { entries } = await reconcileKnowledgeBases();
  return entries
    .filter((e) => e.lastSyncAt !== null)
    .map((e) => ({ slug: e.slug, lastSyncAt: e.lastSyncAt }));
}

describe('offline sync state', () => {
  it('reports the last sync three hours before the frozen instant', async () => {
    freeze('2026-03-11T12:00:00.000Z');
    const rows = await synced();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.lastSyncAt).toBe('2026-03-11T09:00:00.000Z');
  });

  it('at 00:20 UTC the last sync is still TODAY, clamped to midnight', async () => {
    freeze('2026-03-12T00:20:00.000Z');
    const rows = await synced();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      // Three hours back would be 2026-03-11T21:20Z — the previous day, which
      // is the bug. Clamped, the worst case is midnight of the current day.
      expect(r.lastSyncAt).toBe('2026-03-12T00:00:00.000Z');
      expect(r.lastSyncAt?.slice(0, 10)).toBe('2026-03-12');
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
