// The mock board's order is a function of the seed, not of when it was built.
//
// Each fixture build reads the clock ONCE (mock/work-items.ts `onOneClock`),
// and `searchWorkItems` breaks `updatedAt` ties on id in byte order, as the
// SQL does (`wi.id COLLATE "C"`). Before both, a millisecond tick partway
// through a build made the rows after it 1 ms newer, so the board's first row
// and its 50-row cut moved between boots — and the wire capture's samples
// (the item a PATCH edits, the decisions a link write picks) moved with them.

jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import { workItems } from '../work-items.js';
import { fixtureRegistry } from '../core/index.js';
import { byRecentThenId, searchWorkItems } from '../../providers/work-items.js';

/** A wall clock that advances `step` ms on every read (1 = the worst case for a build). */
function tickingClock(startMs: number, step = 1) {
  let t = startMs;
  return jest.spyOn(Date, 'now').mockImplementation(() => { const now = t; t += step; return now; });
}

afterEach(() => {
  jest.restoreAllMocks();
  fixtureRegistry.resetAll('default');
});

async function boardAfterFreshBuild(startMs: number, step: number): Promise<string[]> {
  tickingClock(startMs, step);
  fixtureRegistry.resetAll('default');
  const ids = (await searchWorkItems({ limit: 50 })).map((i) => i.id);
  jest.restoreAllMocks();
  return ids;
}

describe('the mock work board is deterministic', () => {
  it('two builds give the same first row and the same 50-row cut, even with the clock ticking every read', async () => {
    // A minute apart, as two boots of one capture session are. (Builds hours
    // apart can still reorder a done item whose completion is pinned to its
    // sprint's calendar days — see completedInSprint — against the rows
    // stamped in whole days before now; that is content, not this race.)
    // One build with the clock ticking on every read, one with it standing still:
    // where a tick lands must not matter.
    const a = await boardAfterFreshBuild(Date.UTC(2026, 10, 10, 3, 45, 0, 999), 1);
    const b = await boardAfterFreshBuild(Date.UTC(2026, 10, 10, 3, 46, 0, 0), 0);
    expect(a).toHaveLength(50);
    expect(b[0]).toBe(a[0]);
    expect(b).toEqual(a);
  });

  it('every stamp of one build is offset from a single clock read', () => {
    tickingClock(Date.UTC(2026, 10, 10, 12, 0, 0, 0));
    const rows = workItems.rows('default');
    const ms = new Set(rows.map((r) => r.updatedAt.slice(19)));
    // Seeds are whole days before the epoch, so one read gives one sub-second part.
    expect(ms.size).toBe(1);
  });

  it('the mock order is newest first, then id in byte order', async () => {
    const all = await searchWorkItems({ limit: 200 });
    const sorted = [...all].sort(byRecentThenId);
    expect(all.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
  });
});
