import {
  mapAgentJob,
  mapDispatcherJobEvent,
  mapFleetBox,
  mapFleetBoxDeleted,
  mapJobChange,
  type AgentJobRecord,
  type AuthenticatedCloudComputeContext,
  type FleetBoxRecord,
} from '../mapCloudCompute.js';

const context: AuthenticatedCloudComputeContext = {
  actor: { actorId: 'person-42', organizationId: 'org-1', sourceSubject: 'session-subject-42' },
  producer: { serviceId: 'aws-agentcore', organizationId: 'org-1', credentialId: 'service-key-7' },
  receivedAt: '2026-09-19T12:00:05.000Z',
};

const box: FleetBoxRecord = {
  id: 'box-7', label: 'Shared build worker', sessionId: 'private-session-id',
  createdAt: '2026-09-19T11:00:00.000Z', lastActivityAt: '2026-09-19T12:00:00.000Z',
  status: 'running', ownerId: 'session-subject-42', projectId: 'project-auth',
  currentTask: 'PRIVATE: rotate a credential and visit a presigned URL',
};

const job: AgentJobRecord = {
  id: 'job-9', status: 'running', boxId: 'box-7', attempts: 2,
  createdAt: '2026-09-19T11:30:00.000Z', claimedAt: '2026-09-19T11:31:00.000Z',
  startedAt: '2026-09-19T11:32:00.000Z', finishedAt: null,
  payload: { projectId: 'project-auth', prompt: 'PRIVATE: use https://signed.example/token', credentials: 'secret' },
  title: 'PRIVATE: production credentials task', result: { output: 'PRIVATE' }, error: 'PRIVATE',
};

function eventOf(result: ReturnType<typeof mapFleetBox>) {
  expect(result.supported).toBe(true);
  if (!result.supported) throw new Error(result.reason);
  return result.event;
}

describe('mapCloudCompute', () => {
  it.each([
    ['idle', 'created'], ['running', 'started'], ['waiting', 'waiting'], ['stopped', 'stopped'], ['error', 'failed'],
  ] as const)('maps FleetBox %s to %s without task/session disclosure', (status, lifecycle) => {
    const event = eventOf(mapFleetBox({ ...box, status }, context));
    expect(event.payload.lifecycle).toBe(lifecycle);
    expect(event.payload.projectId).toBe('project-auth');
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    expect(JSON.stringify(event)).not.toContain('private-session-id');
    expect(JSON.stringify(event)).not.toContain('signed.example');
    expect(JSON.stringify(event)).not.toContain('credentials');
  });

  it('maps retries and the explicit project association from the job record', () => {
    const event = eventOf(mapAgentJob(job, box, context));
    expect(event.payload).toMatchObject({ jobId: 'job-9', boxId: 'box-7', attempt: 2, projectId: 'project-auth', lifecycle: 'started' });
    expect(event.resource).toEqual({ source: 'cloud-compute', resourceId: 'job:job-9', resourceVersion: 'running:2' });
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    expect(JSON.stringify(event)).not.toContain('signed.example');
    expect(JSON.stringify(event)).not.toContain('credentials');
  });

  it('maps the dispatcher event shape using joined, authoritative queue attribution', () => {
    const event = eventOf(mapDispatcherJobEvent(
      { kind: 'awaiting_review', jobId: 'job-9', boxId: 'box-7', ts: '2026-09-19T12:03:00.000Z' },
      { ...job, status: 'awaiting_review' }, box, context,
    ));
    expect(event.payload).toMatchObject({ lifecycle: 'waiting', attempt: 2, projectId: 'project-auth' });
    expect(event.occurredAt).toBe('2026-09-19T12:03:00.000Z');
  });

  it('maps the provider jobEvents change shape without treating its title or payload prompt as safe', () => {
    const event = eventOf(mapJobChange({
      jobId: 'job-9', boxId: 'box-7', status: 'failed', title: 'PRIVATE title',
      payload: { projectId: 'project-auth', prompt: 'PRIVATE prompt', output: 'PRIVATE output' },
      at: '2026-09-19T12:04:00.000Z',
    }, box, context));
    expect(event.payload).toMatchObject({ lifecycle: 'failed', projectId: 'project-auth' });
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
  });

  it('returns a typed partial unsupported result when owner attribution is absent', () => {
    expect(mapFleetBox({ ...box, ownerId: undefined }, context)).toEqual({
      supported: false, unsupported: true, partial: true, reason: 'missing-owner',
    });
  });

  it('does not resolve conflicting project attribution or mismatched source ownership', () => {
    expect(mapAgentJob({ ...job, payload: { projectId: 'project-other' } }, box, context)).toMatchObject({
      supported: false, reason: 'project-attribution-conflict', partial: true,
    });
    expect(mapFleetBox({ ...box, ownerId: 'unverified-owner' }, context)).toMatchObject({
      supported: false, reason: 'owner-does-not-match-authenticated-subject', partial: true,
    });
  });
});

it('keeps same-millisecond box lifecycle transitions distinct while deduplicating replay', () => {
  const running = eventOf(mapFleetBox(box, context));
  const stopped = eventOf(mapFleetBox({ ...box, status: 'stopped' }, context));
  expect(stopped.idempotencyKey).not.toBe(running.idempotencyKey);
  expect(eventOf(mapFleetBox(box, context)).idempotencyKey).toBe(running.idempotencyKey);
});

it('maps removal from the retained server-side box record, not a client-provided owner', () => {
  const removed = eventOf(mapFleetBoxDeleted(box, context));
  expect(removed.payload.lifecycle).toBe('deleted');
  expect(removed.resource.resourceVersion).toBe('deleted:2026-09-19T12:00:00.000Z');
  expect(JSON.stringify(removed)).not.toContain('private-session-id');
});
