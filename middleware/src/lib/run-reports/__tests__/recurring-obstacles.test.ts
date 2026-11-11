import { groupRecurringObstacles, normaliseObstacle } from '../recurring-obstacles.js';
import type { RunReport } from '../types.js';

const rep = (runRef: string, over: Partial<RunReport> = {}): RunReport => ({
  runRef, workItemId: `wi-${runRef}`, initiativeId: 'p-a', executor: 'fleet', model: null, startedAt: null,
  endedAt: '2026-11-01T10:00:00.000Z', outcome: 'done', failureCode: null, summary: '', changes: { files: [], changeRequestId: null },
  verification: [], obstacles: [], runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: null, reportedUsd: null, basis: 'unknown' },
  kept: [], selfReport: 'present', briefId: null, createdAt: '2026-11-01T10:00:00.000Z', ...over,
}) as RunReport;

describe('normaliseObstacle', () => {
  it('folds case, whitespace and punctuation', () => {
    expect(normaliseObstacle('  The CSRF gate,  failed (403).\n')).toBe('the csrf gate failed 403');
    expect(normaliseObstacle('the csrf gate failed 403')).toBe('the csrf gate failed 403');
  });
});

describe('groupRecurringObstacles', () => {
  it('groups equal normalised text across different runs and counts what a reviewer reads', () => {
    const out = groupRecurringObstacles([
      rep('r1', { obstacles: ['The CSRF gate blocked the push.'], endedAt: '2026-11-01T00:00:00.000Z', outcome: 'failed' }),
      rep('r2', { obstacles: ['the csrf gate blocked the push'], endedAt: '2026-11-03T00:00:00.000Z', workItemId: 'wi-r2' }),
      rep('r3', { obstacles: ['Something else.'] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      text: 'the csrf gate blocked the push', runs: 2, workItems: 2, failedRuns: 1,
      firstSeen: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-03T00:00:00.000Z', runRefs: ['r2', 'r1'],
      scope: { kind: 'initiative', ref: 'p-a' },
    });
  });

  it('needs two different runs: one run saying it twice is one run', () => {
    expect(groupRecurringObstacles([rep('r1', { obstacles: ['Wall.', 'wall'] })])).toEqual([]);
  });

  it('keeps initiatives apart, and joins them by repository when the repository is known', () => {
    const reports = [rep('r1', { obstacles: ['Wall.'] }), rep('r2', { initiativeId: 'p-b', obstacles: ['Wall.'] })];
    expect(groupRecurringObstacles(reports)).toEqual([]);
    const joined = groupRecurringObstacles(reports, { repoOf: () => 'org/svc' });
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ scope: { kind: 'repo', ref: 'org/svc' }, runs: 2, initiativeIds: ['p-a', 'p-b'] });
  });

  it('filters by initiative and by repository, and keeps only the five newest run refs', () => {
    const many = Array.from({ length: 7 }, (_, i) => rep(`r${i}`, { obstacles: ['Wall.'], endedAt: `2026-11-0${i + 1}T00:00:00.000Z` }));
    expect(groupRecurringObstacles(many)[0]!.runRefs).toEqual(['r6', 'r5', 'r4', 'r3', 'r2']);
    expect(groupRecurringObstacles(many, { initiativeId: 'p-z' })).toEqual([]);
    expect(groupRecurringObstacles(many, { repoOf: () => 'org/svc', repo: 'svc' })).toHaveLength(1);
    expect(groupRecurringObstacles(many, { repoOf: () => 'org/svc', repo: 'other' })).toEqual([]);
  });
});
