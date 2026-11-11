// Queue semantics tests. The DB layer is stubbed — what matters here is that
// the SQL we emit encodes the invariants (SKIP LOCKED claim, attempt guard,
// state transitions), because those are what keep two workers off one job.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import {
  enqueueJob, claimNextJob, completeJob, reviewJob, cancelJob, reapStaleJobs, listJobs, queueStats,
} from '../agent-jobs.js';
import { _resetColumnProbes } from '../column-probe.js';

const execMock = exec as unknown as jest.Mock;

const ROW = {
  id: 'job-1', kind: 'devbox:task', title: 'Do the thing', payload: '{"prompt":"go"}',
  status: 'queued', priority: 100, box_id: null, session_id: null, attempts: 0, max_attempts: 2,
  result: null, error: null, created_by: 'portal', created_at: '2026-08-18T00:00:00Z',
  claimed_at: null, started_at: null, finished_at: null,
};

beforeEach(() => {
  execMock.mockReset();
  // reapStaleJobs probes for the pull-side columns, and the probe answer is
  // cached process-wide — reset it so each test controls the exec call sequence.
  _resetColumnProbes();
});

describe('claim protocol', () => {
  it('claims with FOR UPDATE SKIP LOCKED so two dispatchers cannot take one job', async () => {
    execMock.mockResolvedValueOnce([{ n: 2 }]).mockResolvedValue([{ ...ROW, status: 'claimed', box_id: 'box-a' }]);
    const job = await claimNextJob('box-a', 'session-a');
    const sql = execMock.mock.calls.at(-1)[0] as string;
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(/WHERE status = 'queued'/);
    expect(sql).toMatch(/ORDER BY priority, created_at/);
    expect(job?.status).toBe('claimed');
    expect(job?.boxId).toBe('box-a');
  });

  it('increments attempts on claim so retries are bounded', async () => {
    execMock.mockResolvedValueOnce([{ n: 2 }]).mockResolvedValue([{ ...ROW, attempts: 1 }]);
    await claimNextJob('box-a', 'session-a');
    expect(execMock.mock.calls[1][0]).toMatch(/attempts = attempts \+ 1/);
  });

  it('returns null when the queue is empty', async () => {
    execMock.mockResolvedValue([]);
    execMock.mockResolvedValueOnce([{ n: 2 }]);
    expect(await claimNextJob('box-a', 'session-a')).toBeNull();
  });
});

describe('lifecycle', () => {
  it('enqueue passes payload as jsonb and returns the row', async () => {
    execMock.mockResolvedValue([ROW]);
    const job = await enqueueJob({ kind: 'devbox:task', title: 'Do the thing', payload: { prompt: 'go' } });
    expect(execMock.mock.calls[0][0]).toMatch(/:payload::jsonb/);
    expect(job?.payload).toEqual({ prompt: 'go' });
  });

  it('completeJob records terminal state and preserves prior result when none given', async () => {
    execMock.mockResolvedValue([]);
    await completeJob('job-1', { claimToken: 'attempt-1', status: 'awaiting_review', result: { summary: 'done' } });
    const sql = execMock.mock.calls.at(-1)[0] as string;
    expect(sql).toMatch(/COALESCE\(NULLIF\(:result, ''\)::jsonb, result\)/);
    expect(sql).toMatch(/finished_at = NOW\(\)/);
  });

  it('review only applies to awaiting_review rows', async () => {
    execMock.mockResolvedValue([{ ...ROW, status: 'done' }]);
    await reviewJob('job-1', 'accept', 'looks right');
    expect(execMock.mock.calls[0][0]).toMatch(/status = 'awaiting_review'/);
  });

  it('cancel refuses jobs that already started', async () => {
    execMock.mockResolvedValue([]);
    const ok = await cancelJob('job-1');
    expect(execMock.mock.calls.at(-1)[0]).toMatch(/status IN \('queued','claimed'\)/);
    expect(ok).toBe(false);
  });
});

describe('stale recovery', () => {
  it('requeues while attempts remain and fails once exhausted', async () => {
    execMock
      .mockResolvedValueOnce([{ n: 0 }]) // pull-side column probe: not migrated
      .mockResolvedValueOnce([{ id: 'job-1' }])
      .mockResolvedValueOnce([{ id: 'job-2' }]);
    const out = await reapStaleJobs(30);
    const requeueSql = execMock.mock.calls[1][0] as string;
    const failSql = execMock.mock.calls[2][0] as string;
    expect(requeueSql).toMatch(/SET status='queued'/);
    expect(requeueSql).toMatch(/attempts < max_attempts/);
    expect(failSql).toMatch(/attempts >= max_attempts/);
    expect(out).toEqual({ requeued: 1, failed: 1, failedIds: ['job-2'] });
  });
});

describe('listing', () => {
  it('orders live work above finished work', async () => {
    execMock.mockResolvedValue([ROW]);
    await listJobs({ limit: 10 });
    expect(execMock.mock.calls[0][0]).toMatch(/WHEN 'running' THEN 0/);
  });

  it('queueStats returns a zeroed shape when nothing is queued', async () => {
    execMock.mockResolvedValue([]);
    const stats = await queueStats();
    expect(stats.total).toBe(0);
    expect(stats.queued).toBe(0);
  });
});
