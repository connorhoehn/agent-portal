jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import { verifyEnvelope, SERVICE_AUTH_HEADER } from '@connorhoehn/service-runtime';
import {
  emitCloudBox,
  emitCloudBoxDeleted,
  emitLocalAnnounce,
} from '../compute-emitter.js';
import type { ComputeNode } from '../../providers/local-compute.js';
import type { FleetBox } from '../../lib/devbox-fleet.js';

const secret = 'a-work-graph-test-secret-that-is-long-enough';
const originalEnv = { ...process.env };

const cloudBox: FleetBox = {
  id: 'box-1', label: 'build worker', sessionId: 'private-runtime-session',
  createdAt: '2026-09-20T10:00:00.000Z', lastActivityAt: '2026-09-20T10:01:00.000Z',
  status: 'running', ownerId: 'person-1', projectId: 'project-1', currentTask: 'PRIVATE prompt',
};

const localNode: ComputeNode = {
  id: 'node-1', ownerId: 'person-1', label: 'workstation', platform: 'darwin',
  acceptJobs: true, localModels: [], jobKinds: [], maxConcurrency: 1,
  createdAt: '2026-09-20T10:00:00.000Z', lastSeenAt: '2026-09-20T10:01:00.000Z',
  lastClaimAt: null, revokedAt: null,
};

function configure(): void {
  process.env.PLATFORM_API_URL = 'http://platform.test/';
  process.env.WORK_GRAPH_SERVICE_AUTH_SECRET = secret;
  process.env.WORK_GRAPH_ORGANIZATION_ID = 'org-1';
  process.env.WORK_GRAPH_SOURCE_CREDENTIAL_ID = 'credential-1';
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
}

describe('compute work-graph emitter', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    configure();
    fetchMock.mockReset().mockResolvedValue({ ok: true, status: 202 });
    Object.assign(globalThis, { fetch: fetchMock });
  });

  afterAll(() => restoreEnv());

  function published(): Record<string, unknown> {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://platform.test/internal/work-graph/ingest');
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    const signature = new Headers(options.headers).get(SERVICE_AUTH_HEADER);
    expect(signature).toBeTruthy();
    expect(verifyEnvelope(signature!, {
      secret,
      allowedServices: ['aws-agentcore'],
      payload: body,
      ttlSec: 30,
      toleranceSec: 5,
    }).ok).toBe(true);
    return body;
  }

  it('emits a signed cloud transition using its durable owner, not private runtime fields', async () => {
    await expect(emitCloudBox(cloudBox)).resolves.toBe(true);
    const body = published();
    expect(body).toMatchObject({ source: 'cloud-compute', actor: { actorId: 'person-1', organizationId: 'org-1' } });
    expect(JSON.stringify(body)).not.toContain('private-runtime-session');
    expect(JSON.stringify(body)).not.toContain('PRIVATE prompt');
  });

  it('emits an explicit terminal deletion before the cloud registry loses its owner join', async () => {
    await expect(emitCloudBoxDeleted(cloudBox)).resolves.toBe(true);
    expect(published()).toMatchObject({ payload: { lifecycle: 'deleted', boxId: 'box-1' } });
  });

  it('emits the authenticated local session lifecycle while excluding repo/worktree/intent', async () => {
    await emitLocalAnnounce(localNode, [{
      sessionId: 'session-1', projectId: 'project-1', startedAt: '2026-09-20T10:00:00.000Z',
      repo: 'private/repo', worktree: '/private/worktree', intent: 'PRIVATE plan', lastSeenAt: '2026-09-20T10:01:00.000Z',
    }]);
    const body = published();
    expect(body).toMatchObject({ source: 'local-compute', payload: { lifecycle: 'session-started', sessionId: 'session-1' } });
    expect(JSON.stringify(body)).not.toContain('private/repo');
    expect(JSON.stringify(body)).not.toContain('PRIVATE plan');
  });
});
