jest.mock('../../lib/devbox-fleet.js', () => ({
  getBox: jest.fn(),
  markStopped: jest.fn(),
}));
jest.mock('../../lib/local-compute-fleet.js', () => ({ presenceOf: jest.fn() }));
jest.mock('../../providers/agent-jobs.js', () => ({ getJob: jest.fn(), cancelJob: jest.fn() }));
jest.mock('../../providers/local-compute.js', () => ({ getNode: jest.fn() }));
jest.mock('../../routes/devbox.js', () => ({ stopDevboxSessionForSourceControl: jest.fn() }));

import { getBox, markStopped } from '../../lib/devbox-fleet.js';
import { presenceOf } from '../../lib/local-compute-fleet.js';
import { getJob, cancelJob } from '../../providers/agent-jobs.js';
import { getNode } from '../../providers/local-compute.js';
import { stopDevboxSessionForSourceControl } from '../../routes/devbox.js';
import { computeCapabilitySources } from '../compute-capability-source.js';

const mocked = <T>(fn: T) => fn as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mocked(presenceOf).mockReturnValue({ status: 'connected', sessions: [] });
});

describe('durable compute capability source joins', () => {
  it('derives a cloud box owner from fleet state rather than a platform claim', async () => {
    mocked(getBox).mockReturnValue({ id: 'box-1', sessionId: 'runtime-private', ownerId: 'person-1', status: 'running' });
    await expect(computeCapabilitySources.resolve({ source: 'cloud-compute', resourceId: 'box:box-1' }))
      .resolves.toMatchObject({ ownerId: 'person-1', controllable: true, revocationKeys: ['box:box-1'] });
  });

  it('refuses revoked local durable nodes and non-live local sessions', async () => {
    mocked(getNode).mockResolvedValue({ id: 'node-1', ownerId: 'person-1', revokedAt: '2026-09-21T12:00:00.000Z' });
    await expect(computeCapabilitySources.resolve({ source: 'local-compute', resourceId: 'machine:node-1' })).resolves.toBeNull();
    mocked(getNode).mockResolvedValue({ id: 'node-1', ownerId: 'person-1', revokedAt: null });
    await expect(computeCapabilitySources.resolve({ source: 'local-compute', resourceId: 'session:node-1:session-1' })).resolves.toBeNull();
  });

  it('executes only source-supported control: cloud stop or queued local cancellation', async () => {
    mocked(getBox).mockReturnValue({ id: 'box-1', sessionId: 'runtime-1', ownerId: 'person-1', status: 'running' });
    mocked(stopDevboxSessionForSourceControl).mockResolvedValue('stopped');
    const cloud = await computeCapabilitySources.resolve({ source: 'cloud-compute', resourceId: 'box:box-1' });
    if (!cloud) throw new Error('expected cloud target');
    await expect(computeCapabilitySources.cancel(cloud)).resolves.toBe(true);
    expect(stopDevboxSessionForSourceControl).toHaveBeenCalledWith('runtime-1');
    expect(markStopped).toHaveBeenCalledWith('box-1');

    mocked(getJob).mockResolvedValue({ id: 'job-1', boxId: 'local:node-1', status: 'queued' });
    mocked(getNode).mockResolvedValue({ id: 'node-1', ownerId: 'person-1', revokedAt: null });
    mocked(cancelJob).mockResolvedValue(true);
    const local = await computeCapabilitySources.resolve({ source: 'local-compute', resourceId: 'job:job-1' });
    if (!local) throw new Error('expected local target');
    await expect(computeCapabilitySources.cancel(local)).resolves.toBe(true);
    expect(cancelJob).toHaveBeenCalledWith('job-1');
  });
});
