/** Concrete compute lifecycle → signed Active now producer wiring. */
import {
  mapAgentJob,
  mapFleetBox,
  mapFleetBoxDeleted,
  type FleetBoxRecord,
} from './mapCloudCompute.js';
import {
  mapLocalHeartbeat,
  mapLocalDisconnected,
  mapLocalJob,
  mapLocalSessionAnnounce,
  mapLocalSessionEnd,
  type LocalComputeMachineRecord,
  type LocalComputeSessionRecord,
} from './mapLocalCompute.js';
import {
  publishWorkGraphEvent,
  workGraphContextForOwner,
  type WorkGraphProducerEvent,
} from './producer.js';
import { getBox, listBoxes, subscribeLifecycle, type FleetBox } from '../lib/devbox-fleet.js';
import { nodeIdFromBoxId } from '../lib/local-compute-fleet.js';
import { getJob, jobEvents, type AgentJob, type JobChangeEvent } from '../providers/agent-jobs.js';
import { getNode, type ComputeNode } from '../providers/local-compute.js';
import { invalidateComputeCapabilitySource } from './compute-capability-runtime.js';

type Mapped = { supported: true; event: WorkGraphProducerEvent } | { supported: false; reason: string };

function asCloudBox(box: FleetBox): FleetBoxRecord {
  return {
    id: box.id,
    label: box.label,
    sessionId: box.sessionId,
    createdAt: box.createdAt,
    status: box.status,
    lastActivityAt: box.lastActivityAt,
    ...(box.ownerId ? { ownerId: box.ownerId } : {}),
    ...(box.projectId ? { projectId: box.projectId } : {}),
    ...(box.currentTask ? { currentTask: box.currentTask } : {}),
  };
}

function asLocalMachine(node: ComputeNode): LocalComputeMachineRecord {
  return {
    id: node.id,
    ownerId: node.ownerId,
    label: node.label,
    lastSeenAt: node.lastSeenAt,
    platform: node.platform,
  };
}

function asLocalJob(job: AgentJob) {
  return {
    id: job.id,
    boxId: job.boxId,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    claimedAt: job.claimedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    payload: job.payload,
    title: job.title,
    result: job.result,
    error: job.error,
  };
}

async function emit(mapped: Mapped, ownerId: string | undefined): Promise<boolean> {
  const context = workGraphContextForOwner(ownerId);
  // Feature configuration is intentionally the activation switch. No context
  // means no tenant-safe event exists to publish; do not substitute request
  // metadata or a default organisation.
  if (!context) return false;
  if (!mapped.supported) {
    console.warn(`[work-graph] compute lifecycle not emitted: ${mapped.reason}`);
    return false;
  }
  await publishWorkGraphEvent(mapped.event);
  return true;
}

export async function emitCloudBox(box: FleetBox): Promise<boolean> {
  const context = workGraphContextForOwner(box.ownerId);
  if (!context) return false;
  return emit(mapFleetBox(asCloudBox(box), context), box.ownerId);
}

export async function emitCloudBoxDeleted(box: FleetBox): Promise<boolean> {
  const context = workGraphContextForOwner(box.ownerId);
  if (!context) return false;
  return emit(mapFleetBoxDeleted(asCloudBox(box), context), box.ownerId);
}

export async function emitCloudJob(job: AgentJob, box: FleetBox): Promise<boolean> {
  const context = workGraphContextForOwner(box.ownerId);
  if (!context) return false;
  return emit(mapAgentJob(job, asCloudBox(box), context), box.ownerId);
}

export async function emitLocalAnnounce(node: ComputeNode, sessions: readonly LocalComputeSessionRecord[]): Promise<void> {
  const context = workGraphContextForOwner(node.ownerId);
  if (!context) return;
  await Promise.all(sessions.map((session) => emit(
    mapLocalSessionAnnounce(asLocalMachine(node), session, context), node.ownerId,
  )));
}

export async function emitLocalHeartbeat(node: ComputeNode, heartbeatAt: string): Promise<boolean> {
  const context = workGraphContextForOwner(node.ownerId);
  if (!context) return false;
  return emit(mapLocalHeartbeat(asLocalMachine(node), heartbeatAt, context), node.ownerId);
}

export async function emitLocalDisconnected(node: ComputeNode, occurredAt: string): Promise<boolean> {
  const context = workGraphContextForOwner(node.ownerId);
  if (!context) return false;
  return emit(mapLocalDisconnected(asLocalMachine(node), occurredAt, context), node.ownerId);
}

export async function emitLocalSessionEnd(node: ComputeNode, sessionId: string, endedAt: string): Promise<boolean> {
  const context = workGraphContextForOwner(node.ownerId);
  if (!context) return false;
  return emit(mapLocalSessionEnd(asLocalMachine(node), sessionId, endedAt, context), node.ownerId);
}

export async function emitLocalJob(job: AgentJob, node: ComputeNode): Promise<boolean> {
  const context = workGraphContextForOwner(node.ownerId);
  if (!context) return false;
  return emit(mapLocalJob(asLocalJob(job), asLocalMachine(node), context), node.ownerId);
}

let started = false;

/**
 * Attaches after the source-of-truth registries are loaded. The callback never
 * turns a successful compute transition into a browser-visible false success:
 * route-level local callbacks await their own emissions, while background
 * cloud transitions retain the event identity and retry at the producer
 * boundary. Errors are logged without private payloads.
 */
export function startComputeWorkGraphProducer(): () => void {
  if (started) return () => {};
  started = true;
  // Hydrated boxes predate this process and therefore do not pass through
  // registerBox. Re-emitting their deterministic lifecycle ids repairs a
  // transient platform outage/restart without creating a second transition.
  for (const box of listBoxes()) {
    void emitCloudBox(box).catch((error) => console.warn('[work-graph] cloud box reconciliation failed:', (error as Error).message));
  }
  const stopFleet = subscribeLifecycle((event) => {
    if (event.kind === 'removed') {
      // A removed cloud box is authoritative source revocation. End attached
      // observe/control transports immediately rather than waiting for their
      // next platform poll.
      invalidateComputeCapabilitySource('cloud-compute', `box:${event.box.id}`);
    }
    const emitBox = event.kind === 'removed' ? emitCloudBoxDeleted(event.box) : emitCloudBox(event.box);
    void emitBox.catch((error) => console.warn('[work-graph] cloud box delivery failed:', (error as Error).message));
  });
  const onJob = (change: JobChangeEvent) => {
    void emitJobChange(change).catch((error) => console.warn('[work-graph] compute job delivery failed:', (error as Error).message));
  };
  jobEvents.on('change', onJob);
  return () => {
    started = false;
    stopFleet();
    jobEvents.off('change', onJob);
  };
}

async function emitJobChange(change: JobChangeEvent): Promise<void> {
  const job = await getJob(change.jobId);
  if (!job || job.status !== change.status) return;
  const localNodeId = nodeIdFromBoxId(job.boxId);
  if (localNodeId) {
    const node = await getNode(localNodeId);
    if (node) await emitLocalJob(job, node);
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      invalidateComputeCapabilitySource('local-compute', `job:${job.id}`);
    }
    return;
  }
  if (!job.boxId) return;
  const box = getBox(job.boxId);
  if (box) await emitCloudJob(job, box);
  if (['done', 'failed', 'cancelled'].includes(job.status)) {
    invalidateComputeCapabilitySource('cloud-compute', `job:${job.id}`);
  }
}

/** Test hook: removes process-global listeners between isolated test files. */
export function _resetComputeWorkGraphProducer(): void {
  started = false;
}
