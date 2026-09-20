/** Durable source joins for compute capability sessions. */
import { getBox, markStopped, type FleetBox } from '../lib/devbox-fleet.js';
import { presenceOf } from '../lib/local-compute-fleet.js';
import { getJob, cancelJob, type AgentJob } from '../providers/agent-jobs.js';
import { getNode } from '../providers/local-compute.js';
import { stopDevboxSessionForSourceControl } from '../routes/devbox.js';
import type {
  ComputeCapabilityResource,
  ComputeCapabilitySources,
  ComputeCapabilityTarget,
} from './compute-capability-sessions.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Target = ComputeCapabilityTarget & { box?: FleetBox; job?: AgentJob };

function cloudStatus(box: FleetBox): ComputeCapabilityTarget['status'] {
  if (box.status === 'idle') return 'available';
  if (box.status === 'error') return 'failed';
  return box.status;
}

function jobStatus(job: AgentJob): ComputeCapabilityTarget['status'] {
  if (job.status === 'queued' || job.status === 'claimed') return 'available';
  if (job.status === 'awaiting_review') return 'waiting';
  if (job.status === 'done') return 'stopped';
  return job.status;
}

function cloudBoxTarget(resource: ComputeCapabilityResource, box: FleetBox): Target | null {
  if (!box.ownerId) return null;
  const status = cloudStatus(box);
  return {
    ownerId: box.ownerId, resource, status,
    // Stop is meaningful only while the runtime has a live source lifecycle.
    controllable: status !== 'stopped' && status !== 'failed' && status !== 'cancelled',
    revocationKeys: [`box:${box.id}`], box,
  };
}

async function resolveCloud(resource: ComputeCapabilityResource): Promise<Target | null> {
  if (resource.resourceId.startsWith('box:')) {
    const id = resource.resourceId.slice(4);
    if (!ID.test(id)) return null;
    const box = getBox(id);
    return box ? cloudBoxTarget(resource, box) : null;
  }
  if (!resource.resourceId.startsWith('job:')) return null;
  const id = resource.resourceId.slice(4);
  if (!ID.test(id)) return null;
  const job = await getJob(id);
  // A local worker's job is never a cloud resource, even if its id looks valid.
  if (!job?.boxId || job.boxId.startsWith('local:')) return null;
  const box = getBox(job.boxId);
  const base = box ? cloudBoxTarget(resource, box) : null;
  return base && box ? { ...base, status: jobStatus(job), revocationKeys: [`box:${box.id}`, `job:${job.id}`], job } : null;
}

async function resolveLocal(resource: ComputeCapabilityResource): Promise<Target | null> {
  if (resource.resourceId.startsWith('machine:')) {
    const id = resource.resourceId.slice(8);
    if (!ID.test(id)) return null;
    const node = await getNode(id);
    if (!node || node.revokedAt) return null;
    return {
      ownerId: node.ownerId, resource,
      status: presenceOf(node.id).status === 'connected' ? 'available' : 'stopped',
      controllable: false, revocationKeys: [`machine:${node.id}`],
    };
  }
  if (resource.resourceId.startsWith('session:')) {
    const parts = resource.resourceId.slice(8).split(':');
    if (parts.length !== 2 || !ID.test(parts[0]!) || !ID.test(parts[1]!)) return null;
    const node = await getNode(parts[0]!);
    if (!node || node.revokedAt || !presenceOf(node.id).sessions.some((session) => session.sessionId === parts[1])) return null;
    return { ownerId: node.ownerId, resource, status: 'running', controllable: false, revocationKeys: [`machine:${node.id}`, `session:${node.id}:${parts[1]}`] };
  }
  if (!resource.resourceId.startsWith('job:')) return null;
  const id = resource.resourceId.slice(4);
  if (!ID.test(id)) return null;
  const job = await getJob(id);
  const nodeId = job?.boxId?.startsWith('local:') ? job.boxId.slice(6) : null;
  if (!job || !nodeId || !ID.test(nodeId)) return null;
  const node = await getNode(nodeId);
  if (!node || node.revokedAt) return null;
  return {
    ownerId: node.ownerId, resource, status: jobStatus(job),
    // A remote platform cannot interrupt a running local process. It can only
    // cancel work the durable queue has not begun, which is a real, bounded
    // control rather than pretending a terminal exists where it does not.
    controllable: job.status === 'queued' || job.status === 'claimed',
    revocationKeys: [`machine:${node.id}`, `job:${job.id}`], job,
  };
}

export const computeCapabilitySources: ComputeCapabilitySources = {
  async resolve(resource) {
    if (resource.source === 'cloud-compute') return resolveCloud(resource);
    if (resource.source === 'local-compute') return resolveLocal(resource);
    return null;
  },

  async cancel(target) {
    const concrete = target as Target;
    if (!target.controllable) return false;
    if (target.resource.source === 'local-compute') return concrete.job ? cancelJob(concrete.job.id) : false;
    if (!concrete.box) return false;
    await stopDevboxSessionForSourceControl(concrete.box.sessionId);
    markStopped(concrete.box.id);
    return true;
  },
};
