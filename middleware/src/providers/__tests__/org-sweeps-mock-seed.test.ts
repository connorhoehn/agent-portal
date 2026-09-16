// dev:mock is the contract the portal is built against: the Findings list
// must render rows in every status without Aurora, and a mock sweep run must
// report what it re-observed rather than a flat zero.
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import { listFindings, getFinding, runSweep, findingStats } from '../org-sweeps.js';

describe('mock findings seed', () => {
  it('lists seeded findings across open / promoted / resolved / dismissed', async () => {
    const all = await listFindings();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const statuses = new Set(all.map((f) => f.status));
    for (const st of ['open', 'promoted', 'resolved', 'dismissed']) expect(statuses.has(st)).toBe(true);
    // critical first, then warning, then info
    const rank = { critical: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < all.length; i++) expect(rank[all[i - 1].severity]).toBeLessThanOrEqual(rank[all[i].severity]);
  });

  it('honours the status and sweep filters', async () => {
    const open = await listFindings({ status: 'open' });
    expect(open.length).toBeGreaterThanOrEqual(3);
    expect(open.every((f) => f.status === 'open')).toBe(true);
    const bus = await listFindings({ sweep: 'bus_factor' });
    expect(bus.every((f) => f.sweep === 'bus_factor')).toBe(true);
    // One rare skill in the mock cast (MLOps, two holders) — the board files
    // exactly what the sweep would against mock/people.ts.
    expect(bus.length).toBe(1);
  });

  it('resolves a seeded finding by id and a mock sweep re-observes its rows', async () => {
    const [first] = await listFindings();
    expect((await getFinding(first.id))?.id).toBe(first.id);
    const r = await runSweep('stale_docs');
    expect(r.found).toBe(2);
    expect(r.updated).toBe(2);
    expect(r.created).toBe(0);
  });

  it('findingStats groups by sweep/status/severity and sums to the same population listFindings sees', async () => {
    const all = await listFindings();
    const stats = await findingStats();
    const total = stats.reduce((sum, row) => sum + row.n, 0);
    expect(total).toBe(all.length);
    // Every group is non-empty and each finding lands in exactly one group.
    for (const row of stats) expect(row.n).toBeGreaterThan(0);
    const openFromStats = stats.filter((r) => r.status === 'open').reduce((s, r) => s + r.n, 0);
    const openFromList = all.filter((f) => f.status === 'open').length;
    expect(openFromStats).toBe(openFromList);
  });
});
