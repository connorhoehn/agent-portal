/**
 * Converts authenticated local-compute records into the narrow structural
 * event shape consumed by the Active now projection.
 *
 * This module deliberately does not import realtime-modules: this checkout
 * carries a different fork. The coordinator wires these structural events to
 * the C0 `AuthenticatedWorkEvent` contract when that dependency is updated.
 * The output is private service-to-service data, never a browser DTO.
 */

/** Mirrors C0 WORK_GRAPH_LIMITS. The AWS fork cannot import its unpinned API. */
export const LOCAL_COMPUTE_HEARTBEAT_FRESH_MS = 45_000;
export const LOCAL_COMPUTE_HEARTBEAT_STALE_MS = 5 * 60_000;

export type LocalJobStatus =
  | 'queued' | 'claimed' | 'running' | 'awaiting_review' | 'done' | 'failed' | 'cancelled';

/** Durable, paired-machine facts only. `ownerId` is server-established. */
export interface LocalComputeMachineRecord {
  id: string;
  ownerId?: string;
  label?: string;
  lastSeenAt?: string | null;
  /** Intentionally present to prevent accidental disclosure through this mapper. */
  platform?: string | null;
  tokenHash?: string;
}

/** A private local-presence session, as supplied by an authenticated machine. */
export interface LocalComputeSessionRecord {
  sessionId: string;
  projectId?: string;
  startedAt?: string | number;
  lastSeenAt?: string;
  /** These private fields must never reach a work-graph event. */
  repo?: string;
  branch?: string;
  worktree?: string;
  intent?: string;
  touching?: string[];
  log?: string;
  output?: string;
  token?: string;
}

/** Minimal queue record needed to represent a job owned by a local machine. */
export interface LocalComputeJobRecord {
  id: string;
  boxId: string | null;
  status: LocalJobStatus;
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  payload: Record<string, unknown>;
  /** Never copied: task title, prompt, result, failure and token use are private. */
  title?: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  output?: string | null;
  tokenCount?: number;
}

export interface AuthenticatedLocalComputeContext {
  /** Verified server-side identity mapping, never a machine-provided owner. */
  actor: {
    actorId: string;
    organizationId: string;
    sourceSubject: string;
  };
  producer: {
    serviceId: string;
    organizationId: string;
    credentialId: string;
  };
  receivedAt: string;
}

export type LocalComputeLifecycle =
  | 'session-started' | 'session-ended' | 'job-started' | 'job-finished' | 'heartbeat' | 'disconnected';

/** Structural equivalent of the C0 local-compute event, pending coordinator wiring. */
export interface LocalComputeWorkEvent {
  schemaVersion: 1;
  eventId: string;
  idempotencyKey: string;
  source: 'local-compute';
  sourceSequence?: string;
  occurredAt: string;
  receivedAt: string;
  actor: AuthenticatedLocalComputeContext['actor'];
  producer: AuthenticatedLocalComputeContext['producer'];
  resource: {
    source: 'local-compute';
    resourceId: string;
    resourceVersion?: string;
  };
  payload: {
    kind: 'local-compute';
    lifecycle: LocalComputeLifecycle;
    machineId: string;
    sessionId?: string;
    jobId?: string;
    projectId?: string;
    heartbeatAt?: string;
  };
}

export type LocalComputeMapResult =
  | { supported: true; event: LocalComputeWorkEvent }
  | {
    supported: false;
    unsupported: true;
    partial: true;
    reason:
      | 'missing-owner'
      | 'owner-does-not-match-authenticated-subject'
      | 'missing-machine'
      | 'missing-identity-context'
      | 'machine-does-not-match-job'
      | 'invalid-attempt'
      | 'missing-session-id'
      | 'invalid-heartbeat'
      | 'invalid-session-time';
  };

export type LocalComputeHeartbeatFreshness = 'fresh' | 'delayed' | 'disconnected';

function unsupported(reason: Extract<LocalComputeMapResult, { supported: false }>['reason']): LocalComputeMapResult {
  return { supported: false, unsupported: true, partial: true, reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasIdentityContext(context: AuthenticatedLocalComputeContext): boolean {
  const { actor, producer } = context;
  return [
    actor.actorId, actor.organizationId, actor.sourceSubject,
    producer.serviceId, producer.organizationId, producer.credentialId, context.receivedAt,
  ].every(isNonEmptyString) && actor.organizationId === producer.organizationId;
}

function authorizeMachine(
  machine: LocalComputeMachineRecord | undefined,
  context: AuthenticatedLocalComputeContext,
): LocalComputeMapResult | null {
  if (!hasIdentityContext(context)) return unsupported('missing-identity-context');
  if (!machine || !isNonEmptyString(machine.id)) return unsupported('missing-machine');
  if (!isNonEmptyString(machine.ownerId)) return unsupported('missing-owner');
  if (machine.ownerId !== context.actor.sourceSubject) return unsupported('owner-does-not-match-authenticated-subject');
  return null;
}

function isoFromStartedAt(value: string | number | undefined, fallback: string): string | null {
  if (typeof value === 'number') {
    const date = new Date(value * 1_000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const candidate = typeof value === 'string' && value.trim().length > 0 ? value : fallback;
  return Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function explicitPayloadProject(payload: Record<string, unknown>): string | undefined {
  const candidate = payload['projectId'];
  return isNonEmptyString(candidate) ? candidate : undefined;
}

function eventFor(
  context: AuthenticatedLocalComputeContext,
  input: {
    eventId: string;
    sourceSequence?: string;
    occurredAt: string;
    machineId: string;
    lifecycle: LocalComputeLifecycle;
    resourceId: string;
    resourceVersion?: string;
    sessionId?: string;
    jobId?: string;
    projectId?: string;
    heartbeatAt?: string;
  },
): LocalComputeMapResult {
  return {
    supported: true,
    event: {
      schemaVersion: 1,
      eventId: input.eventId,
      idempotencyKey: input.eventId,
      source: 'local-compute',
      ...(input.sourceSequence ? { sourceSequence: input.sourceSequence } : {}),
      occurredAt: input.occurredAt,
      receivedAt: context.receivedAt,
      actor: context.actor,
      producer: context.producer,
      resource: {
        source: 'local-compute',
        resourceId: input.resourceId,
        ...(input.resourceVersion ? { resourceVersion: input.resourceVersion } : {}),
      },
      payload: {
        kind: 'local-compute',
        lifecycle: input.lifecycle,
        machineId: input.machineId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.heartbeatAt ? { heartbeatAt: input.heartbeatAt } : {}),
      },
    },
  };
}

/**
 * Evaluates source freshness only. It intentionally says nothing about whether
 * the machine owner is online; human presence is not inferable from a machine
 * callback.
 */
export function heartbeatFreshness(
  heartbeatAt: string,
  observedAt: string,
): LocalComputeHeartbeatFreshness | null {
  const heartbeatMs = Date.parse(heartbeatAt);
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(heartbeatMs) || !Number.isFinite(observedMs)) return null;
  const ageMs = Math.max(0, observedMs - heartbeatMs);
  if (ageMs <= LOCAL_COMPUTE_HEARTBEAT_FRESH_MS) return 'fresh';
  if (ageMs <= LOCAL_COMPUTE_HEARTBEAT_STALE_MS) return 'delayed';
  return 'disconnected';
}

/** Maps one session in an authenticated `/announce` snapshot. */
export function mapLocalSessionAnnounce(
  machine: LocalComputeMachineRecord | undefined,
  session: LocalComputeSessionRecord,
  context: AuthenticatedLocalComputeContext,
): LocalComputeMapResult {
  const denied = authorizeMachine(machine, context);
  if (denied) return denied;
  // `authorizeMachine` verifies this at runtime; retain the guard for TS and
  // for future changes to that helper's result shape.
  if (!machine) return unsupported('missing-machine');
  if (!isNonEmptyString(session.sessionId)) return unsupported('missing-session-id');
  const occurredAt = isoFromStartedAt(session.startedAt, session.lastSeenAt ?? context.receivedAt);
  if (!occurredAt) return unsupported('invalid-session-time');
  return eventFor(context, {
    eventId: `local-compute:session:${machine.id}:${session.sessionId}:started:${occurredAt}`,
    sourceSequence: `session-started:${occurredAt}`,
    occurredAt,
    machineId: machine.id,
    lifecycle: 'session-started',
    resourceId: `session:${machine.id}:${session.sessionId}`,
    resourceVersion: occurredAt,
    sessionId: session.sessionId,
    ...(isNonEmptyString(session.projectId) ? { projectId: session.projectId } : {}),
  });
}

/** Maps an authenticated machine callback that explicitly ended a session. */
export function mapLocalSessionEnd(
  machine: LocalComputeMachineRecord | undefined,
  sessionId: string,
  endedAt: string,
  context: AuthenticatedLocalComputeContext,
): LocalComputeMapResult {
  const denied = authorizeMachine(machine, context);
  if (denied) return denied;
  if (!machine) return unsupported('missing-machine');
  if (!isNonEmptyString(sessionId)) return unsupported('missing-session-id');
  if (!Number.isFinite(Date.parse(endedAt))) return unsupported('invalid-session-time');
  return eventFor(context, {
    eventId: `local-compute:session:${machine.id}:${sessionId}:ended:${endedAt}`,
    sourceSequence: `session-ended:${endedAt}`,
    occurredAt: endedAt,
    machineId: machine.id,
    lifecycle: 'session-ended',
    resourceId: `session:${machine.id}:${sessionId}`,
    resourceVersion: endedAt,
    sessionId,
  });
}

/**
 * Maps a machine heartbeat. A delayed heartbeat remains a heartbeat so the
 * reducer can expose delayed source health; only past C0's stale boundary is a
 * disconnected event. Neither case asserts a human's presence.
 */
export function mapLocalHeartbeat(
  machine: LocalComputeMachineRecord | undefined,
  heartbeatAt: string,
  context: AuthenticatedLocalComputeContext,
): LocalComputeMapResult {
  const denied = authorizeMachine(machine, context);
  if (denied) return denied;
  if (!machine) return unsupported('missing-machine');
  const freshness = heartbeatFreshness(heartbeatAt, context.receivedAt);
  if (!freshness) return unsupported('invalid-heartbeat');
  const lifecycle: LocalComputeLifecycle = freshness === 'disconnected' ? 'disconnected' : 'heartbeat';
  return eventFor(context, {
    eventId: `local-compute:machine:${machine.id}:${lifecycle}:${heartbeatAt}`,
    sourceSequence: `${lifecycle}:${heartbeatAt}`,
    occurredAt: heartbeatAt,
    machineId: machine.id,
    lifecycle,
    resourceId: `machine:${machine.id}`,
    resourceVersion: heartbeatAt,
    heartbeatAt,
  });
}

/** Maps a local queue row after its local-box attribution is verified. */
export function mapLocalJob(
  job: LocalComputeJobRecord,
  machine: LocalComputeMachineRecord | undefined,
  context: AuthenticatedLocalComputeContext,
): LocalComputeMapResult {
  const denied = authorizeMachine(machine, context);
  if (denied) return denied;
  if (!machine) return unsupported('missing-machine');
  if (job.boxId !== `local:${machine.id}`) return unsupported('machine-does-not-match-job');
  if (!Number.isInteger(job.attempts) || job.attempts < 0) return unsupported('invalid-attempt');
  const lifecycle: LocalComputeLifecycle = ['awaiting_review', 'done', 'failed', 'cancelled'].includes(job.status)
    ? 'job-finished'
    : 'job-started';
  const occurredAt = job.finishedAt ?? job.startedAt ?? job.claimedAt ?? job.createdAt;
  const projectId = explicitPayloadProject(job.payload);
  return eventFor(context, {
    eventId: `local-compute:job:${job.id}:${job.status}:${job.attempts}:${occurredAt}`,
    sourceSequence: `${job.status}:${job.attempts}`,
    occurredAt,
    machineId: machine.id,
    lifecycle,
    resourceId: `job:${job.id}`,
    resourceVersion: `${job.status}:${job.attempts}`,
    jobId: job.id,
    ...(projectId ? { projectId } : {}),
  });
}
