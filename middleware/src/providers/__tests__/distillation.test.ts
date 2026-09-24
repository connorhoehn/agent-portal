// The compaction store's decision rules + the mock level/job state end-to-end.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import {
  dedupeRatio, writeAmplification, compactionHealth, samplingVerdict,
  levels, ingest, listCompactions, sampling, compactNow,
  type CompactionJob, type LevelState, __setCompactRunMs } from '../distillation.js';

function job(over: Partial<CompactionJob> & Pick<CompactionJob, 'id' | 'level' | 'startedAt'>): CompactionJob {
  return {
    finishedAt: null, status: 'succeeded',
    inputItems: 100, outputItems: 50, dedupedItems: 50, bytesReclaimed: 1000, costUsd: 0.02,
    produced: { cluster_ids: [], artifact_ids: [] },
    queued_at: over.startedAt, queue: 'distill-compact-l1', repo: null, requested_by: null,
    input_ids: [], output_ids: [], log: [], what_changed: '', duration_ms: null, cost_usd: 0.02,
    phase: 'done', percent: 100, stepLabel: null, attempts: 1,
    ...over,
  };
}

function level(over: Partial<LevelState> & Pick<LevelState, 'level'>): LevelState {
  return { items: 100, sizeBytes: 10_000, oldestAt: new Date().toISOString(), lagSeconds: 0, ...over };
}

// A hand-triggered pass runs for 3s by default; these suites assert the
// corpus right after the call, so complete synchronously here.
beforeAll(() => __setCompactRunMs(0));

describe('dedupeRatio — the number that justifies the machine', () => {
  it('computes deduped / input', () => {
    expect(dedupeRatio({ inputItems: 200, dedupedItems: 80 })).toBe(0.4);
  });

  it('a job that consumed nothing is not 100% efficient — null, not a ratio', () => {
    expect(dedupeRatio({ inputItems: 0, dedupedItems: 0 })).toBeNull();
  });

  it('a job with zero dedupes still reports a real 0 ratio when it consumed input', () => {
    expect(dedupeRatio({ inputItems: 100, dedupedItems: 0 })).toBe(0);
  });
});

describe('writeAmplification — output/input across a job set', () => {
  it('averages across jobs weighted by volume, not by job count', () => {
    const jobs = [
      job({ id: 'a', level: 'L1', startedAt: '2026-01-01', inputItems: 100, outputItems: 50 }),
      job({ id: 'b', level: 'L1', startedAt: '2026-01-02', inputItems: 300, outputItems: 90 }),
    ];
    expect(writeAmplification(jobs)).toBeCloseTo(140 / 400, 5);
  });

  it('an empty job set reports 0, not NaN', () => {
    expect(writeAmplification([])).toBe(0);
    expect(Number.isNaN(writeAmplification([]))).toBe(false);
  });

  it('a job set that consumed nothing reports 0 even with nonzero output', () => {
    expect(writeAmplification([job({ id: 'a', level: 'L1', startedAt: '2026-01-01', inputItems: 0, outputItems: 5 })])).toBe(0);
  });
});

describe('compactionHealth — per level, always names what to do', () => {
  it('L0 is always healthy — nothing ever compacts into the write head', () => {
    const h = compactionHealth([level({ level: 'L0', items: 5000, lagSeconds: 999_999 })], []);
    expect(h[0]).toMatchObject({ level: 'L0', status: 'healthy' });
    expect(h[0]!.reason).toMatch(/write head/);
  });

  it('a level with low lag and a recent job is healthy', () => {
    const jobs = [job({ id: 'a', level: 'L1', startedAt: new Date().toISOString() })];
    const h = compactionHealth([level({ level: 'L1', items: 50, lagSeconds: 300 })], jobs);
    expect(h[0]!.status).toBe('healthy');
  });

  it('a level whose lag exceeds the threshold, but is still attended, is behind', () => {
    const jobs = [job({ id: 'a', level: 'L1', startedAt: new Date().toISOString() })];
    const h = compactionHealth([level({ level: 'L1', items: 50, lagSeconds: 3000 })], jobs);
    expect(h[0]!.status).toBe('behind');
    expect(h[0]!.reason).toMatch(/L1 is \d+ minutes behind/);
  });

  it('a level with backlog and no recent attempt is stalled, and names the level', () => {
    const staleJob = job({ id: 'a', level: 'L2', startedAt: new Date(Date.now() - 10 * 3_600_000).toISOString() });
    const h = compactionHealth([level({ level: 'L2', items: 40, lagSeconds: 40_000 })], [staleJob]);
    expect(h[0]!.status).toBe('stalled');
    // Names the tier and what is waiting FOR it (the unclaimed patterns), not
    // the tier's own row count — "L2 has 40 items waiting" meant 40 guides.
    expect(h[0]!.reason).toMatch(/\d+ patterns? waiting for L2/);
    expect(h[0]!.reason).not.toMatch(/40/);
  });

  it('a level with backlog and NO job ever run against it is stalled', () => {
    const h = compactionHealth([level({ level: 'L2', items: 12, lagSeconds: 500 })], []);
    expect(h[0]!.status).toBe('stalled');
    expect(h[0]!.reason).toMatch(/no compaction has ever run/);
  });

  it('a level with zero backlog is healthy even with no jobs at all', () => {
    const h = compactionHealth([level({ level: 'L1', items: 0, lagSeconds: 0 })], []);
    expect(h[0]!.status).toBe('healthy');
  });
});

describe('samplingVerdict — the human-in-the-loop dial', () => {
  it('low agreement means undersampled — raise the rate', () => {
    const v = samplingVerdict({ l1SampleRatePct: 4, reviewedLast30d: 100, agreementRatePct: 60, queueDepth: 3 });
    expect(v.verdict).toBe('undersampled');
    expect(v.reason).toMatch(/Raise the L1 sample rate/);
  });

  it('high agreement at a real sample rate means oversampled — turn it down', () => {
    const v = samplingVerdict({ l1SampleRatePct: 10, reviewedLast30d: 500, agreementRatePct: 98, queueDepth: 1 });
    expect(v.verdict).toBe('oversampled');
    expect(v.reason).toMatch(/rubber-stamping/);
  });

  it('high agreement AT the sample-rate floor does not recommend going lower', () => {
    const v = samplingVerdict({ l1SampleRatePct: 2, reviewedLast30d: 40, agreementRatePct: 99, queueDepth: 0 });
    expect(v.verdict).toBe('calibrated');
  });

  it('mid-range agreement at a working sample rate is calibrated', () => {
    const v = samplingVerdict({ l1SampleRatePct: 4, reviewedLast30d: 214, agreementRatePct: 87, queueDepth: 6 });
    expect(v.verdict).toBe('calibrated');
    expect(v.reason).toMatch(/87% agreement/);
  });
});

describe('the mock store end-to-end', () => {
  it('levels reports L0 > L1 > L2 by item count, an LSM tree not a flat log', async () => {
    const ls = await levels();
    const byLevel = Object.fromEntries(ls.map((l) => [l.level, l.items]));
    expect(byLevel['L0']!).toBeGreaterThan(byLevel['L1']!);
    expect(byLevel['L1']!).toBeGreaterThan(byLevel['L2']!);
  });

  it('ingest reports active writers and repo shares', async () => {
    const i = await ingest();
    expect(i.activeWriters).toBeGreaterThan(0);
    expect(i.topRepos.length).toBeGreaterThan(0);
  });

  it('listCompactions filters by level and status, and includes the seeded failure', async () => {
    const l2 = await listCompactions({ level: 'L2' });
    expect(l2.every((j) => j.level === 'L2')).toBe(true);
    const failed = await listCompactions({ status: 'failed' });
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toMatch(/EventBus/);
  });

  it('sampling returns the seeded state', async () => {
    const s = await sampling();
    expect(s.l1SampleRatePct).toBeGreaterThan(0);
  });

  it('compactNow really compacts: L0 observations become L1 cluster members, not deleted rows', async () => {
    const before = await levels();
    const l0Before = before.find((l) => l.level === 'L0')!.items;
    const l1Before = before.find((l) => l.level === 'L1')!.items;

    const j = await compactNow('L1', 'Priya Nair');
    expect(j.level).toBe('L1');
    expect(j.inputItems).toBeGreaterThan(0);
    expect(j.inputItems).toBe(j.outputItems + j.dedupedItems);

    const after = await levels();
    // Observations are members now, never deleted — L0's count is the corpus
    // length and doesn't move.
    expect(after.find((l) => l.level === 'L0')!.items).toBe(l0Before);
    // L1's count is MOCK_CLUSTERS.length, which grew by the new clusters
    // this pass actually created.
    expect(after.find((l) => l.level === 'L1')!.items).toBe(l1Before + j.outputItems);
    expect(after.find((l) => l.level === 'L1')!.lagSeconds).toBe(0);
  });

  it('compactNow appends a job visible in listCompactions', async () => {
    const beforeCount = (await listCompactions()).length;
    const j = await compactNow('L2', 'Priya Nair');
    const jobs = await listCompactions();
    expect(jobs.length).toBe(beforeCount + 1);
    expect(jobs[0]!.id).toBe(j.id);
  });
});
