// Every stamp the offline queue writes comes from mock/core/clock.ts.
//
// The five transitions below (`enqueue`, `claim`, `markRunning`, `complete`,
// `cancel`) each recorded `new Date().toISOString()` inside their
// `config.mock.aurora` branch — a wall-clock mint living outside src/mock,
// which is rule 3 of the mock floor. Two things break when a fixture stamp is
// minted that way: `freezeClock` cannot pin it, so no test can assert what a
// transition actually wrote; and a row whose claim is the DAY lands in
// yesterday when the process runs just after UTC midnight.
//
// These tests are the proof, and they are written as equality against the
// frozen instant rather than a range: a stamp that still came off the wall
// clock would differ from the freeze by the test's own runtime, which a
// tolerance window would happily absorb.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { freezeClock } from '../../mock/core/index.js';
import {
  cancelJob, claimJob, claimNextJob, completeJob, enqueueJob, getJob, markRunning,
} from '../agent-jobs.js';

const AFTERNOON = '2026-03-11T14:32:07.000Z';
// 00:04 UTC — the instant the "today" bug fires. Nothing here clamps (a queue
// transition is genuinely `NOW()`), but the stamp must still be exactly the
// frozen instant rather than whatever the wall clock says.
const JUST_AFTER_MIDNIGHT = '2026-03-12T00:04:00.000Z';

let restore = () => {};
afterEach(() => restore());

function freeze(at: string): void {
  restore();
  restore = freezeClock(at);
}

describe('the offline queue stamps from the clock', () => {
  it('enqueue records createdAt at the frozen instant', async () => {
    freeze(AFTERNOON);
    const job = await enqueueJob({ kind: 'devbox:task', title: 'Trim the workspace' });
    expect(job?.createdAt).toBe(AFTERNOON);
    expect(job?.claimedAt).toBeNull();
    expect(job?.finishedAt).toBeNull();
  });

  it('carries the whole lifecycle across three different frozen instants', async () => {
    freeze('2026-03-11T09:00:00.000Z');
    const job = await enqueueJob({ kind: 'devbox:task', title: 'Rotate the credentials' });
    expect(job).not.toBeNull();

    freeze('2026-03-11T09:05:00.000Z');
    const claimed = await claimJob(job!.id, 'box-a', 'session-a');
    expect(claimed?.claimedAt).toBe('2026-03-11T09:05:00.000Z');

    freeze('2026-03-11T09:06:30.000Z');
    await markRunning(job!.id);
    expect((await getJob(job!.id))?.startedAt).toBe('2026-03-11T09:06:30.000Z');

    freeze('2026-03-11T09:19:00.000Z');
    await completeJob(job!.id, { status: 'done', result: { summary: 'rotated' } });
    const done = await getJob(job!.id);
    expect(done?.finishedAt).toBe('2026-03-11T09:19:00.000Z');
    // Created under the first freeze and untouched by the later ones — the
    // transitions stamp their own column, they do not restamp the row.
    expect(done?.createdAt).toBe('2026-03-11T09:00:00.000Z');
  });

  it('claimNextJob stamps the head of the queue, not the wall clock', async () => {
    freeze(AFTERNOON);
    const queued = await enqueueJob({ kind: 'devbox:task', title: 'Sweep the findings', priority: 1 });
    const claimed = await claimNextJob('box-b', 'session-b');
    expect(claimed?.id).toBe(queued?.id);
    expect(claimed?.claimedAt).toBe(AFTERNOON);
  });

  it('cancel stamps finishedAt, and a minute past UTC midnight stays on the new day', async () => {
    freeze(JUST_AFTER_MIDNIGHT);
    const job = await enqueueJob({ kind: 'devbox:task', title: 'Abandon this one' });
    expect(await cancelJob(job!.id)).toBe(true);
    const cancelled = await getJob(job!.id);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.finishedAt).toBe(JUST_AFTER_MIDNIGHT);
    // The day the row claims is the day the clock is on — the bug this rule
    // exists for is a row minted at 00:04 that reads as yesterday.
    expect(cancelled?.finishedAt?.slice(0, 10)).toBe('2026-03-12');
  });
});
