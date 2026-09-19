import {
  LOCAL_COMPUTE_HEARTBEAT_FRESH_MS,
  LOCAL_COMPUTE_HEARTBEAT_STALE_MS,
  heartbeatFreshness,
  mapLocalHeartbeat,
  mapLocalJob,
  mapLocalSessionAnnounce,
  mapLocalSessionEnd,
  type AuthenticatedLocalComputeContext,
  type LocalComputeJobRecord,
  type LocalComputeMachineRecord,
  type LocalComputeSessionRecord,
} from '../mapLocalCompute.js';

const context: AuthenticatedLocalComputeContext = {
  actor: { actorId: 'person-42', organizationId: 'org-1', sourceSubject: 'user-subject-42' },
  producer: { serviceId: 'orgiq-middleware', organizationId: 'org-1', credentialId: 'node-token-credential-7' },
  receivedAt: '2026-09-19T12:00:05.000Z',
};

const machine: LocalComputeMachineRecord = {
  id: 'node-7', ownerId: 'user-subject-42', label: 'Connor laptop',
  lastSeenAt: '2026-09-19T12:00:00.000Z', platform: 'darwin/arm64', tokenHash: 'PRIVATE token hash',
};

const session: LocalComputeSessionRecord = {
  sessionId: 'session-7', projectId: 'project-auth', startedAt: '2026-09-19T11:30:00.000Z',
  lastSeenAt: '2026-09-19T12:00:00.000Z', repo: 'PRIVATE repo', branch: 'PRIVATE branch',
  worktree: '/private/worktree/path', intent: 'PRIVATE intent', touching: ['private/file.ts'],
  log: 'PRIVATE log', output: 'PRIVATE output', token: 'PRIVATE token',
};

const job: LocalComputeJobRecord = {
  id: 'job-9', boxId: 'local:node-7', status: 'running', attempts: 2,
  createdAt: '2026-09-19T11:30:00.000Z', claimedAt: '2026-09-19T11:31:00.000Z',
  startedAt: '2026-09-19T11:32:00.000Z', finishedAt: null,
  payload: { projectId: 'project-auth', prompt: 'PRIVATE prompt', repo: 'PRIVATE repo', token: 'PRIVATE token' },
  title: 'PRIVATE title', result: { output: 'PRIVATE output' }, error: 'PRIVATE error', output: 'PRIVATE output', tokenCount: 123_456,
};

function eventOf(result: ReturnType<typeof mapLocalSessionAnnounce>) {
  expect(result.supported).toBe(true);
  if (!result.supported) throw new Error(result.reason);
  return result.event;
}

describe('mapLocalCompute', () => {
  it('maps an authenticated announce and session end without private local details', () => {
    const started = eventOf(mapLocalSessionAnnounce(machine, session, context));
    expect(started.payload).toEqual({
      kind: 'local-compute', lifecycle: 'session-started', machineId: 'node-7', sessionId: 'session-7', projectId: 'project-auth',
    });
    expect(started.resource).toEqual({ source: 'local-compute', resourceId: 'session:node-7:session-7', resourceVersion: '2026-09-19T11:30:00.000Z' });
    const ended = eventOf(mapLocalSessionEnd(machine, 'session-7', '2026-09-19T12:01:00.000Z', context));
    expect(ended.payload.lifecycle).toBe('session-ended');
    expect(JSON.stringify([started, ended])).not.toContain('PRIVATE');
    expect(JSON.stringify([started, ended])).not.toContain('/private/worktree');
  });

  it('maps partial heartbeat data without inventing a session, project, or human presence', () => {
    const event = eventOf(mapLocalHeartbeat(machine, '2026-09-19T12:00:00.000Z', context));
    expect(event.payload).toEqual({ kind: 'local-compute', lifecycle: 'heartbeat', machineId: 'node-7', heartbeatAt: '2026-09-19T12:00:00.000Z' });
    expect(JSON.stringify(event)).not.toContain('Connor laptop');
  });

  it('uses C0 freshness and stale thresholds without collapsing delayed into disconnected', () => {
    expect(heartbeatFreshness('2026-09-19T12:00:00.000Z', '2026-09-19T12:00:45.000Z')).toBe('fresh');
    expect(heartbeatFreshness('2026-09-19T12:00:00.000Z', '2026-09-19T12:00:46.000Z')).toBe('delayed');
    expect(heartbeatFreshness('2026-09-19T12:00:00.000Z', '2026-09-19T12:05:00.000Z')).toBe('delayed');
    expect(heartbeatFreshness('2026-09-19T12:00:00.000Z', '2026-09-19T12:05:00.001Z')).toBe('disconnected');
    expect(LOCAL_COMPUTE_HEARTBEAT_FRESH_MS).toBe(45_000);
    expect(LOCAL_COMPUTE_HEARTBEAT_STALE_MS).toBe(300_000);
    const disconnected = eventOf(mapLocalHeartbeat(machine, '2026-09-19T11:54:00.000Z', context));
    expect(disconnected.payload.lifecycle).toBe('disconnected');
  });

  it.each([
    ['queued', 'job-started'], ['claimed', 'job-started'], ['running', 'job-started'],
    ['awaiting_review', 'job-finished'], ['done', 'job-finished'], ['failed', 'job-finished'], ['cancelled', 'job-finished'],
  ] as const)('maps local job %s to %s and retains retry identity only', (status, lifecycle) => {
    const event = eventOf(mapLocalJob({ ...job, status }, machine, context));
    expect(event.payload).toEqual({ kind: 'local-compute', lifecycle, machineId: 'node-7', jobId: 'job-9', projectId: 'project-auth' });
    expect(event.resource).toEqual({ source: 'local-compute', resourceId: 'job:job-9', resourceVersion: `${status}:2` });
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    expect(JSON.stringify(event)).not.toContain('123456');
  });

  it('returns typed partial unsupported results for missing or mismatched ownership and identity', () => {
    expect(mapLocalSessionAnnounce({ ...machine, ownerId: undefined }, session, context)).toEqual({
      supported: false, unsupported: true, partial: true, reason: 'missing-owner',
    });
    expect(mapLocalSessionAnnounce({ ...machine, ownerId: 'other-subject' }, session, context)).toEqual({
      supported: false, unsupported: true, partial: true, reason: 'owner-does-not-match-authenticated-subject',
    });
    expect(mapLocalHeartbeat(machine, '2026-09-19T12:00:00.000Z', {
      ...context, producer: { ...context.producer, organizationId: 'other-org' },
    })).toEqual({ supported: false, unsupported: true, partial: true, reason: 'missing-identity-context' });
  });

  it('does not guess missing project attribution and rejects a job for another machine or bad retry count', () => {
    const withoutProject = eventOf(mapLocalJob({ ...job, payload: { prompt: 'PRIVATE prompt' } }, machine, context));
    expect(withoutProject.payload.projectId).toBeUndefined();
    expect(mapLocalJob({ ...job, boxId: 'local:other-node' }, machine, context)).toMatchObject({
      supported: false, partial: true, reason: 'machine-does-not-match-job',
    });
    expect(mapLocalJob({ ...job, attempts: -1 }, machine, context)).toMatchObject({
      supported: false, partial: true, reason: 'invalid-attempt',
    });
  });
});
