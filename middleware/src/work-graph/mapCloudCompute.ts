/**
 * Converts the private cloud-work records owned by this service into the
 * narrow event shape consumed by the Active now projection.
 *
 * This module intentionally does not import realtime-modules. This checkout
 * pins a different fork; the coordinator wires this structural output to the
 * C0 `AuthenticatedWorkEvent` export when the shared dependency is updated.
 * Nothing from this module is safe to send straight to a browser.
 */

export type FleetBoxStatus = 'idle' | 'running' | 'waiting' | 'stopped' | 'error';
export type AgentJobStatus =
  | 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

/** The fields consumed from lib/devbox-fleet.ts::FleetBox. */
export interface FleetBoxRecord {
  id: string;
  label: string;
  sessionId: string;
  createdAt: string;
  status: FleetBoxStatus;
  lastActivityAt: string;
  ownerId?: string;
  projectId?: string;
  /** Deliberately listed to make it impossible for this mapper to use it. */
  currentTask?: string;
}

/** The fields consumed from providers/agent-jobs.ts::AgentJob. */
export interface AgentJobRecord {
  id: string;
  status: AgentJobStatus;
  boxId: string | null;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  payload: Record<string, unknown>;
  /** These source fields are never copied into an event. */
  title?: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

/** lib/job-dispatcher.ts::dispatcherEvents's `job` event. */
export interface DispatcherJobEvent {
  kind: 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed';
  jobId: string;
  boxId?: string;
  ts: string;
}

/** providers/agent-jobs.ts::jobEvents's `change` event. */
export interface JobChangeRecord {
  jobId: string;
  boxId: string | null;
  status: AgentJobStatus;
  title: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface AuthenticatedCloudComputeContext {
  /** Verified server-side identity mapping, never a browser-provided owner. */
  actor: {
    actorId: string;
    organizationId: string;
    sourceSubject: string;
  };
  producer: {
    serviceId: 'aws-agentcore';
    organizationId: string;
    credentialId: string;
  };
  receivedAt: string;
}

export type CloudComputeLifecycle =
  | 'created' | 'started' | 'waiting' | 'completed' | 'stopped' | 'failed' | 'deleted';

/** Structural equivalent of the C0 cloud-compute event, pending coordinator wiring. */
export interface CloudComputeWorkEvent {
  schemaVersion: 1;
  eventId: string;
  idempotencyKey: string;
  source: 'cloud-compute';
  sourceSequence?: string;
  occurredAt: string;
  receivedAt: string;
  actor: AuthenticatedCloudComputeContext['actor'];
  producer: AuthenticatedCloudComputeContext['producer'];
  resource: {
    source: 'cloud-compute';
    resourceId: string;
    resourceVersion?: string;
  };
  payload: {
    kind: 'cloud-compute';
    lifecycle: CloudComputeLifecycle;
    boxId: string;
    jobId?: string;
    projectId?: string;
    attempt?: number;
    safeLabel?: string;
  };
}

export type CloudComputeMapResult =
  | { supported: true; event: CloudComputeWorkEvent }
  | {
    supported: false;
    unsupported: true;
    partial: true;
    reason:
      | 'missing-owner'
      | 'owner-does-not-match-authenticated-subject'
      | 'missing-box'
      | 'missing-identity-context'
      | 'project-attribution-conflict'
      | 'invalid-attempt'
      | 'event-job-mismatch'
      | 'event-box-mismatch';
  };

function unsupported(reason: Extract<CloudComputeMapResult, { supported: false }>['reason']): CloudComputeMapResult {
  return { supported: false, unsupported: true, partial: true, reason };
}

function lifecycleForBox(status: FleetBoxStatus): CloudComputeLifecycle {
  switch (status) {
    case 'idle': return 'created';
    case 'running': return 'started';
    case 'waiting': return 'waiting';
    case 'stopped': return 'stopped';
    case 'error': return 'failed';
  }
}

function lifecycleForJob(status: AgentJobStatus): CloudComputeLifecycle {
  switch (status) {
    case 'queued':
    case 'claimed': return 'created';
    case 'running': return 'started';
    case 'awaiting_review': return 'waiting';
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'stopped';
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function explicitPayloadProject(payload: Record<string, unknown>): string | undefined {
  const candidate = payload['projectId'];
  return isNonEmptyString(candidate) ? candidate : undefined;
}

function hasIdentityContext(context: AuthenticatedCloudComputeContext): boolean {
  const { actor, producer } = context;
  return [
    actor.actorId, actor.organizationId, actor.sourceSubject,
    producer.serviceId, producer.organizationId, producer.credentialId, context.receivedAt,
  ].every(isNonEmptyString) && actor.organizationId === producer.organizationId;
}

function authorizeBox(box: Pick<FleetBoxRecord, 'ownerId'>, context: AuthenticatedCloudComputeContext): CloudComputeMapResult | null {
  if (!hasIdentityContext(context)) return unsupported('missing-identity-context');
  if (!isNonEmptyString(box.ownerId)) return unsupported('missing-owner');
  if (box.ownerId !== context.actor.sourceSubject) return unsupported('owner-does-not-match-authenticated-subject');
  return null;
}

function sourceProject(box: Pick<FleetBoxRecord, 'projectId'> | undefined, job: Pick<AgentJobRecord, 'payload'> | JobChangeRecord): string | CloudComputeMapResult | undefined {
  const boxProject = box?.projectId;
  const jobProject = explicitPayloadProject(job.payload);
  if (isNonEmptyString(boxProject) && jobProject && boxProject !== jobProject) {
    return unsupported('project-attribution-conflict');
  }
  return jobProject ?? (isNonEmptyString(boxProject) ? boxProject : undefined);
}

function eventFor(
  context: AuthenticatedCloudComputeContext,
  input: {
    eventId: string;
    sourceSequence?: string;
    occurredAt: string;
    boxId: string;
    lifecycle: CloudComputeLifecycle;
    resourceId: string;
    resourceVersion?: string;
    jobId?: string;
    projectId?: string;
    attempt?: number;
    safeLabel?: string;
  },
): CloudComputeMapResult {
  return {
    supported: true,
    event: {
      schemaVersion: 1,
      eventId: input.eventId,
      idempotencyKey: input.eventId,
      source: 'cloud-compute',
      ...(input.sourceSequence ? { sourceSequence: input.sourceSequence } : {}),
      occurredAt: input.occurredAt,
      receivedAt: context.receivedAt,
      actor: context.actor,
      producer: context.producer,
      resource: {
        source: 'cloud-compute',
        resourceId: input.resourceId,
        ...(input.resourceVersion ? { resourceVersion: input.resourceVersion } : {}),
      },
      payload: {
        kind: 'cloud-compute',
        lifecycle: input.lifecycle,
        boxId: input.boxId,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.attempt != null ? { attempt: input.attempt } : {}),
        ...(input.safeLabel ? { safeLabel: input.safeLabel } : {}),
      },
    },
  };
}

/** Maps an owned FleetBox. `currentTask` and `sessionId` are never disclosed. */
export function mapFleetBox(box: FleetBoxRecord, context: AuthenticatedCloudComputeContext): CloudComputeMapResult {
  const denied = authorizeBox(box, context);
  if (denied) return denied;
  return eventFor(context, {
    eventId: `cloud-compute:box:${box.id}:${box.status}:${box.lastActivityAt}`,
    sourceSequence: box.lastActivityAt,
    occurredAt: box.lastActivityAt,
    boxId: box.id,
    lifecycle: lifecycleForBox(box.status),
    resourceId: `box:${box.id}`,
    resourceVersion: box.lastActivityAt,
    // Fleet labels are the only producer-declared safe label; currentTask is not.
    ...(isNonEmptyString(box.label) ? { safeLabel: box.label } : {}),
    ...(isNonEmptyString(box.projectId) ? { projectId: box.projectId } : {}),
  });
}

/**
 * Maps a removed FleetBox before the registry discards its durable owner
 * attribution.  The session id and task transcript remain intentionally
 * absent: deletion is a lifecycle fact, not permission to disclose a shell.
 */
export function mapFleetBoxDeleted(box: FleetBoxRecord, context: AuthenticatedCloudComputeContext): CloudComputeMapResult {
  const denied = authorizeBox(box, context);
  if (denied) return denied;
  return eventFor(context, {
    eventId: `cloud-compute:box:${box.id}:deleted:${box.lastActivityAt}`,
    sourceSequence: `deleted:${box.lastActivityAt}`,
    occurredAt: box.lastActivityAt,
    boxId: box.id,
    lifecycle: 'deleted',
    resourceId: `box:${box.id}`,
    resourceVersion: `deleted:${box.lastActivityAt}`,
    ...(isNonEmptyString(box.projectId) ? { projectId: box.projectId } : {}),
  });
}

/** Maps a queue row together with its authoritative owning FleetBox. */
export function mapAgentJob(
  job: AgentJobRecord,
  box: FleetBoxRecord | undefined,
  context: AuthenticatedCloudComputeContext,
): CloudComputeMapResult {
  if (!box || !isNonEmptyString(job.boxId)) return unsupported('missing-box');
  if (job.boxId !== box.id) return unsupported('event-box-mismatch');
  const denied = authorizeBox(box, context);
  if (denied) return denied;
  if (!Number.isInteger(job.attempts) || job.attempts < 0) return unsupported('invalid-attempt');
  const projectId = sourceProject(box, job);
  if (typeof projectId !== 'string' && projectId) return projectId;
  const occurredAt = job.finishedAt ?? job.startedAt ?? job.claimedAt ?? job.createdAt;
  return eventFor(context, {
    eventId: `cloud-compute:job:${job.id}:${job.status}:${job.attempts}:${occurredAt}`,
    sourceSequence: `${job.status}:${job.attempts}`,
    occurredAt,
    boxId: box.id,
    lifecycle: lifecycleForJob(job.status),
    resourceId: `job:${job.id}`,
    resourceVersion: `${job.status}:${job.attempts}`,
    jobId: job.id,
    attempt: job.attempts,
    ...(projectId ? { projectId } : {}),
  });
}

/** Maps a dispatcher event after joining it to the authoritative job and box. */
export function mapDispatcherJobEvent(
  change: DispatcherJobEvent,
  job: AgentJobRecord,
  box: FleetBoxRecord | undefined,
  context: AuthenticatedCloudComputeContext,
): CloudComputeMapResult {
  if (change.jobId !== job.id) return unsupported('event-job-mismatch');
  if (!box || !isNonEmptyString(change.boxId)) return unsupported('missing-box');
  if (change.boxId !== box.id || job.boxId !== box.id) return unsupported('event-box-mismatch');
  const denied = authorizeBox(box, context);
  if (denied) return denied;
  if (!Number.isInteger(job.attempts) || job.attempts < 0) return unsupported('invalid-attempt');
  const projectId = sourceProject(box, job);
  if (typeof projectId !== 'string' && projectId) return projectId;
  return eventFor(context, {
    eventId: `cloud-compute:dispatcher:${change.jobId}:${change.kind}:${change.ts}`,
    sourceSequence: `${change.kind}:${job.attempts}`,
    occurredAt: change.ts,
    boxId: box.id,
    lifecycle: lifecycleForJob(change.kind),
    resourceId: `job:${job.id}`,
    resourceVersion: `${change.kind}:${job.attempts}`,
    jobId: job.id,
    attempt: job.attempts,
    ...(projectId ? { projectId } : {}),
  });
}

/** Maps a provider jobEvents change after joining it to its owning FleetBox. */
export function mapJobChange(
  change: JobChangeRecord,
  box: FleetBoxRecord | undefined,
  context: AuthenticatedCloudComputeContext,
): CloudComputeMapResult {
  if (!box || !isNonEmptyString(change.boxId)) return unsupported('missing-box');
  if (change.boxId !== box.id) return unsupported('event-box-mismatch');
  const denied = authorizeBox(box, context);
  if (denied) return denied;
  const projectId = sourceProject(box, change);
  if (typeof projectId !== 'string' && projectId) return projectId;
  return eventFor(context, {
    eventId: `cloud-compute:job-change:${change.jobId}:${change.status}:${change.at}`,
    sourceSequence: change.status,
    occurredAt: change.at,
    boxId: box.id,
    lifecycle: lifecycleForJob(change.status),
    resourceId: `job:${change.jobId}`,
    resourceVersion: change.status,
    jobId: change.jobId,
    ...(projectId ? { projectId } : {}),
  });
}
