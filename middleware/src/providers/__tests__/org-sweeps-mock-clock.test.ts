// The offline findings board is a registered fixture, stamped from the clock.
//
// It used to be a bare `MOCK_FINDINGS` array in providers/org-sweeps.ts, built
// by a local `hoursAgo(h) = new Date(Date.now() - h * 3_600_000)` and mutated
// in place by every demo action (dismiss, promote, re-file a lab signal). Two
// floor rules were broken at once: the stamps could not be frozen, and a
// mutation had nowhere to go back to — `POST /api/__mock/reset` could not
// restore a board it did not know about.
//
// The rows live in mock/org-findings.ts now. What is asserted here is that the
// ages are exact against a frozen clock (a wall-clock mint would drift by the
// test's own runtime), that a mock sweep re-observes rather than invents, and
// that a reset really does take a demo dismissal back.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { freezeClock } from '../../mock/core/index.js';
import { orgFindings } from '../../mock/org-findings.js';
import { fileLabSignal, getFinding, listFindings, runSweep, setFindingStatus } from '../org-sweeps.js';

const NOON = '2026-03-11T12:00:00.000Z';
const hoursBeforeNoon = (h: number): string =>
  new Date(Date.parse(NOON) - h * 3_600_000).toISOString();

let restore = () => {};

beforeEach(() => {
  restore = freezeClock(NOON);
  // Rebuild from the factory *under the freeze*, so the seeded ages are
  // relative to NOON rather than to whenever a previous test read them.
  orgFindings.reset();
});
afterEach(() => {
  restore();
  orgFindings.reset();
});

describe('the seeded findings board reads its ages off the clock', () => {
  it('gives each seeded row the exact age its narrative claims', async () => {
    const byId = new Map((await listFindings()).map((f) => [f.id, f]));

    expect(byId.get('find-mock-1')).toMatchObject({
      firstSeenAt: hoursBeforeNoon(70), lastSeenAt: hoursBeforeNoon(6),
    });
    expect(byId.get('find-mock-6')).toMatchObject({
      firstSeenAt: hoursBeforeNoon(200), lastSeenAt: hoursBeforeNoon(26),
    });
    // The lab signal was seen once and never again — both stamps agree.
    expect(byId.get('find-mock-7')?.firstSeenAt).toBe(hoursBeforeNoon(20));
    expect(byId.get('find-mock-7')?.lastSeenAt).toBe(hoursBeforeNoon(20));
  });

  it('a mock sweep re-observes its rows: last_seen moves to now, nothing is created', async () => {
    const before = await listFindings({ sweep: 'stale_docs' });
    const result = await runSweep('stale_docs');

    expect(result).toMatchObject({ sweep: 'stale_docs', created: 0, resolved: 0 });
    expect(result.found).toBe(before.length);
    expect(result.updated).toBe(before.length);

    const after = await listFindings({ sweep: 'stale_docs' });
    expect(after).toHaveLength(before.length);
    for (const f of after) expect(f.lastSeenAt).toBe(NOON);
    // A different sweep's rows were not touched.
    const bus = await listFindings({ sweep: 'bus_factor' });
    for (const f of bus) expect(f.lastSeenAt).toBe(hoursBeforeNoon(6));
  });

  it('skips a dismissed finding — re-observing it would resurrect it', async () => {
    const dismissed = await getFinding('find-mock-7');
    expect(dismissed?.status).toBe('dismissed');
    const result = await runSweep('bus_factor');
    // One rare skill in the mock cast (MLOps, two holders) — see org-findings.ts.
    expect(result.found).toBe(1);
    expect((await getFinding('find-mock-7'))?.lastSeenAt).toBe(hoursBeforeNoon(20));
  });
});

describe('a lab signal filed offline', () => {
  it('is stamped from the clock and takes an id the seed does not own', async () => {
    // BEFORE filing: once the signal is filed it is itself in `rows()`, so
    // reading the high-water mark afterwards would measure the row under test.
    const seededIds = orgFindings.rows().map((f) => f.id);
    const highWater = Math.max(
      ...seededIds.map((id) => Number(/^find-mock-(\d+)$/.exec(id)?.[1] ?? 0)),
    );

    const filed = await fileLabSignal({
      severity: 'critical', title: 'Workspace is at 96% of its 1 GB quota',
      fingerprint: 'lab:workspace-quota:box-mock-9', repo: 'orgiq-portal',
      initiativeId: 'p-observability',
    });

    expect(filed.firstSeenAt).toBe(NOON);
    expect(filed.lastSeenAt).toBe(NOON);
    // The claim is "an id the seed does not own", so derive it from the seed's
    // own high-water mark rather than hardcoding the next number. This asserted
    // `find-mock-8` until the board gained an eighth row and the test failed
    // for a reason that had nothing to do with what it was protecting —
    // a counter reset with the fixture re-minting an id the seed already holds.
    expect(filed.id).toBe(`find-mock-${highWater + 1}`);
    expect(seededIds).not.toContain(filed.id);
    expect(await getFinding('find-mock-1')).not.toBeNull();
  });

  it('re-filing the same fingerprint updates last_seen instead of duplicating', async () => {
    await fileLabSignal({
      severity: 'warning', title: 'Build cache is stale',
      fingerprint: 'lab:build-cache:box-mock-4', repo: 'orgiq-portal',
    });
    const before = (await listFindings()).length;

    restore();
    restore = freezeClock('2026-03-11T15:30:00.000Z');
    const again = await fileLabSignal({
      severity: 'critical', title: 'Build cache is stale',
      fingerprint: 'lab:build-cache:box-mock-4', repo: 'orgiq-portal',
    });

    expect((await listFindings()).length).toBe(before);
    expect(again.severity).toBe('critical');
    expect(again.firstSeenAt).toBe(NOON);
    expect(again.lastSeenAt).toBe('2026-03-11T15:30:00.000Z');
  });
});

describe('the board is resettable', () => {
  it('a demo dismissal is undone by a fixture reset, not by a restart', async () => {
    expect(await setFindingStatus('find-mock-1', 'dismissed')).toBe(true);
    expect((await getFinding('find-mock-1'))?.status).toBe('dismissed');

    orgFindings.reset();

    expect((await getFinding('find-mock-1'))?.status).toBe('open');
  });

  it('the `empty` scenario really is empty, so the Work page can render its own copy', async () => {
    expect(await listFindings()).not.toHaveLength(0);
    expect(orgFindings.rows('empty')).toHaveLength(0);
  });
});
