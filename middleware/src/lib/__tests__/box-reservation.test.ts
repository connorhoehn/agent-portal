// A reserved computer is never handed a queued job.
//
// The claimers read status, and status cannot say who is still counting on a
// box: a governed run waiting on its operator reads `waiting`, a box between
// a demo agent's runs reads `idle`, and both are what the job dispatcher took
// as free. On the shared dev:mock server a queued job landed on the demo's
// Cleo between its run and its next pickup (running → error). Reservations
// (lib/devbox-fleet.ts) are the seam both claimers now ask.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));
jest.mock('../../routes/devbox.js', () => ({ runDevboxTask: jest.fn(async () => ({ ok: true })), wipeDevboxWorkspace: jest.fn(async () => ({ ok: true, removed: 0 })) }));

import { fixtureRegistry } from '../../mock/core/index.js';
import { enqueueJob, getJob } from '../../providers/agent-jobs.js';
import { dispatchOnce } from '../job-dispatcher.js';
import {
  _resetFleet, registerBox, appendEvent, reserveBox, releaseBox, isReserved, getBox,
} from '../devbox-fleet.js';

const sess = (n: number) => `sess-reservation-test-000000000000000000000${n}`;

beforeEach(() => { fixtureRegistry.resetAll('default'); _resetFleet(); });
afterAll(() => { fixtureRegistry.resetAll('default'); _resetFleet(); });

describe('box reservations', () => {
  it('a queued job skips the demo agents\' idle and waiting boxes and lands on a free one', async () => {
    const ada = registerBox({ sessionId: sess(1), label: 'Ada · auth-migration-1' });
    const basil = registerBox({ sessionId: sess(2), label: 'Basil · auth-migration-2' });
    const cleo = registerBox({ sessionId: sess(3), label: 'Cleo · auth-migration-3' });
    // Basil is waiting on his question; Ada and Cleo are idle between runs.
    appendEvent(basil.id, { type: 'task_started', prompt: 'runbook' });
    appendEvent(basil.id, { type: 'result', result: 'Which order?' });
    appendEvent(basil.id, { type: 'devbox_end' });
    expect(getBox(basil.id)!.status).toBe('waiting');
    for (const b of [ada, basil, cleo]) reserveBox(b.id, 'demo-director');

    const job = await enqueueJob({ kind: 'devbox:task', title: 'queued during the demo', payload: { prompt: 'x' } });
    await dispatchOnce();
    expect((await getJob(job!.id))!.boxId).toBeNull();      // nothing free → still queued

    const free = registerBox({ sessionId: sess(4), label: 'spare' });
    await dispatchOnce();
    expect((await getJob(job!.id))!.boxId).toBe(free.id);
  });

  it('several holders may hold one box; it is free when the last lets go', () => {
    const box = registerBox({ sessionId: sess(5) });
    reserveBox(box.id, 'run:1');
    reserveBox(box.id, 'demo-director');
    releaseBox(box.id, 'run:1');
    expect(isReserved(box.id)).toBe(true);
    releaseBox(box.id, 'demo-director');
    expect(isReserved(box.id)).toBe(false);
  });
});
