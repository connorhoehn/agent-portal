// lib/sweep-jobs.ts (G19): a background sweep is a job its owner reads back,
// paced under MOCK_AURORA, announced on the dispatcher's feed, and honest about
// a sweep that failed.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../providers/org-sweeps.js', () => ({
  SWEEP_NAMES: ['bus_factor', 'stale_docs', 'orphan_decisions'],
  runSweep: jest.fn(),
  runAllSweeps: jest.fn(),
}));
jest.mock('../job-dispatcher.js', () => {
  const { EventEmitter } = jest.requireActual<typeof import('node:events')>('node:events');
  return { dispatcherEvents: new EventEmitter() };
});

import { runAllSweeps, runSweep } from '../../providers/org-sweeps.js';
import { dispatcherEvents } from '../job-dispatcher.js';
import { getSweepJob, resetSweepJobs, startSweepJob, MAX_JOBS } from '../sweep-jobs.js';

const m = <T extends (...a: never[]) => unknown>(fn: T) => fn as unknown as jest.Mock;
const me = { sub: 'u-mia', tenant: 'orgiq' };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  resetSweepJobs();
  m(runSweep).mockReset();
  m(runAllSweeps).mockReset();
  process.env['SWEEP_JOB_MOCK_STEP_MS'] = '0';
});
afterAll(() => { delete process.env['SWEEP_JOB_MOCK_STEP_MS']; });

describe('sweep jobs', () => {
  it('answers queued at once, then runs all sweeps and ends done with the counts; every move is on the work feed', async () => {
    const events: Array<{ kind: string; jobId: string }> = [];
    const on = (e: { kind: string; jobId: string }) => events.push(e);
    dispatcherEvents.on('job', on);
    m(runAllSweeps).mockResolvedValue({
      results: [
        { sweep: 'bus_factor', found: 2, created: 1, updated: 1, resolved: 0 },
        { sweep: 'stale_docs', found: 3, created: 0, updated: 3, resolved: 1 },
        { sweep: 'orphan_decisions', found: 1, created: 0, updated: 1, resolved: 0 },
      ],
      released: 0,
    });
    const job = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: null });
    expect(job).toMatchObject({ kind: 'sweep', sweep: null, state: 'queued', title: 'The nightly org sweeps', href: '/iq/work/findings' });
    expect(job.jobId).toMatch(/^sweepjob-[0-9a-f-]{36}$/);
    await settle();
    expect(getSweepJob(job.jobId, me)).toMatchObject({ state: 'done', detail: '6 findings, 1 new, 1 resolved' });
    expect(events.filter((e) => e.jobId === job.jobId).map((e) => e.kind)).toEqual(['sweep:queued', 'sweep:running', 'sweep:done']);
    dispatcherEvents.off('job', on);
  });

  it('one named sweep runs only that sweep', async () => {
    m(runSweep).mockResolvedValue({ sweep: 'stale_docs', found: 4, created: 0, updated: 4, resolved: 0 });
    const job = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: 'stale_docs' });
    expect(job.title).toBe('The stale docs sweep');
    await settle();
    expect(runSweep).toHaveBeenCalledWith('stale_docs');
    expect(runAllSweeps).not.toHaveBeenCalled();
    expect(getSweepJob(job.jobId, me)?.state).toBe('done');
  });

  it('a throw is failed with the first line of the message; a run-all with a skipped sweep is failed and says how many ran', async () => {
    m(runSweep).mockRejectedValue(new Error('graph unreachable\nstack…'));
    const a = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: 'bus_factor' });
    m(runAllSweeps).mockResolvedValue({ results: [{ sweep: 'bus_factor', found: 1, created: 0, updated: 1, resolved: 0 }], released: 0 });
    const b = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: null });
    await settle();
    expect(getSweepJob(a.jobId, me)).toMatchObject({ state: 'failed', detail: 'graph unreachable' });
    expect(getSweepJob(b.jobId, me)).toMatchObject({ state: 'failed', detail: '1 of 3 sweeps ran; 1 finding' });
  });

  it('only its owner reads a job, and only in the tenant it was started in', async () => {
    m(runSweep).mockResolvedValue({ sweep: 'bus_factor', found: 0, created: 0, updated: 0, resolved: 0 });
    const job = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: 'bus_factor' });
    expect(getSweepJob(job.jobId, { sub: 'u-other', tenant: 'orgiq' })).toBeNull();
    expect(getSweepJob(job.jobId, { sub: me.sub, tenant: 'social' })).toBeNull();
    expect(getSweepJob('sweepjob-nope', me)).toBeNull();
    await settle();
  });

  it('under MOCK_AURORA the states are paced, so a dev:mock run shows queued, then running, then done', async () => {
    jest.useFakeTimers();
    try {
      process.env['SWEEP_JOB_MOCK_STEP_MS'] = '1500';
      m(runAllSweeps).mockResolvedValue({ results: [], released: 0 });
      m(runAllSweeps).mockResolvedValue({ results: ['bus_factor', 'stale_docs', 'orphan_decisions'].map((sweep) => ({ sweep, found: 1, created: 0, updated: 1, resolved: 0 })), released: 0 });
      const job = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: null });
      await jest.advanceTimersByTimeAsync(1400);
      expect(getSweepJob(job.jobId, me)?.state).toBe('queued');
      await jest.advanceTimersByTimeAsync(200);
      expect(getSweepJob(job.jobId, me)?.state).toBe('running');
      await jest.advanceTimersByTimeAsync(1500);
      expect(getSweepJob(job.jobId, me)).toMatchObject({ state: 'done', detail: '3 findings' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('the table is bounded', async () => {
    m(runSweep).mockResolvedValue({ sweep: 'bus_factor', found: 0, created: 0, updated: 0, resolved: 0 });
    const first = startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: 'bus_factor' });
    for (let i = 0; i < MAX_JOBS; i++) startSweepJob({ owner: me.sub, tenant: me.tenant, sweep: 'bus_factor' });
    await settle();
    expect(getSweepJob(first.jobId, me)).toBeNull();
  });
});
