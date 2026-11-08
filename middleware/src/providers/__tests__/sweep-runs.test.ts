// Sweep runs: a failing run is answerable since a date, an ok run carries its
// findings count, a throw records `failed` with the message only, tenants are
// separate, `since` filters, and a store failure never breaks a sweep.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { freezeClock } from '../../mock/core/index.js';
import { sweepRuns } from '../../mock/sweep-runs.js';
import { orgFindings } from '../../mock/org-findings.js';
import { runSweep, runAllSweeps, SWEEP_NAMES } from '../org-sweeps.js';
import * as store from '../sweep-runs.js';

const DAY = 86_400_000;
const NOON = '2026-03-11T12:00:00.000Z';
let restore = () => {};

beforeEach(() => { restore = freezeClock(NOON); sweepRuns.reset(); orgFindings.reset(); });
afterEach(() => { restore(); sweepRuns.reset(); orgFindings.reset(); jest.restoreAllMocks(); });

describe('sweep_runs', () => {
  it('an ok run has its findings count and finish stamps', async () => {
    const r = await runSweep('stale_docs');
    const [row] = await store.listSweepRuns({ tenant: 'orgiq' });
    expect(row).toMatchObject({ sweep: 'stale_docs', status: 'ok', findings: r.found, error: null, botId: null });
    expect(row!.finishedAt).not.toBeNull();
    expect(row!.durationMs).toBe(0);
  });

  it('runAllSweeps writes one row per sweep', async () => {
    await runAllSweeps();
    const rows = await store.listSweepRuns({ tenant: 'orgiq' });
    expect(rows.map((r) => r.sweep).sort()).toEqual([...SWEEP_NAMES].sort());
    expect(rows.every((r) => r.status === 'ok')).toBe(true);
  });

  it('a throw records failed with the message only, and still throws', async () => {
    const boom = new Error('relation "skills" does not exist\n    at secret (/app/stack.js:1:1)');
    jest.spyOn(Array.prototype, 'filter').mockImplementationOnce(() => { throw boom; });
    await expect(runSweep('bus_factor')).rejects.toThrow('relation "skills" does not exist');
    const [row] = await store.listSweepRuns({ tenant: 'orgiq' });
    expect(row).toMatchObject({ sweep: 'bus_factor', status: 'failed', error: 'relation "skills" does not exist', findings: null });
    expect(row!.error).not.toMatch(/stack|\bat /);
  });

  it('answers "has a sweep failed since yesterday"', async () => {
    const rows = sweepRuns.rows();
    const base = { tenant: 'orgiq', botId: null, finishedAt: NOON, findings: null, durationMs: 5 };
    rows.push({ ...base, id: 'old-fail', sweep: 'bus_factor', startedAt: new Date(Date.parse(NOON) - 3 * DAY).toISOString(), status: 'failed', error: 'old' });
    rows.push({ ...base, id: 'new-fail', sweep: 'stale_docs', startedAt: new Date(Date.parse(NOON) - 3_600_000).toISOString(), status: 'failed', error: 'timeout' });
    rows.push({ ...base, id: 'new-ok', sweep: 'orphan_decisions', startedAt: new Date(Date.parse(NOON) - 1_800_000).toISOString(), status: 'ok', error: null, findings: 2 });
    const since = new Date(Date.parse(NOON) - DAY).toISOString();
    const failed = await store.listSweepRuns({ tenant: 'orgiq', since, failedOnly: true });
    expect(failed.map((r) => r.id)).toEqual(['new-fail']);
    const all = await store.listSweepRuns({ tenant: 'orgiq', since });
    expect(all.map((r) => r.id)).toEqual(['new-ok', 'new-fail']); // newest first
    expect(await store.listSweepRuns({ tenant: 'orgiq', failedOnly: true })).toHaveLength(2);
  });

  it("another tenant's rows are invisible", async () => {
    await store.startSweepRun('bus_factor', { tenant: 'social' });
    expect(await store.listSweepRuns({ tenant: 'orgiq' })).toHaveLength(0);
    expect(await store.listSweepRuns({ tenant: 'social' })).toHaveLength(1);
  });

  it('caps the limit at 200', () => {
    expect(store.clampSweepRunLimit(5000)).toBe(200);
    expect(store.clampSweepRunLimit(0)).toBe(1);
    expect(store.clampSweepRunLimit(undefined)).toBe(50);
  });

  it('a store failure never breaks the sweep', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(sweepRuns, 'rows').mockImplementation(() => { throw new Error('store down'); });
    await expect(runSweep('stale_docs')).resolves.toMatchObject({ sweep: 'stale_docs' });
  });
});
