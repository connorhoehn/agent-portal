// The microVM runner's derived names (docs/microvm-runner-design.md §2, §3, §9).
//
// Pure and dependency-free on purpose: the fleet dispatcher and the fleet
// reaper import `isMicrovmBoxId` to keep their hands off the runner's
// transient boxes, and neither may load config or a provider to do it.
//
// Every name here is DERIVED from facts the dispatcher already holds, never
// chosen or read from a request:
//
//   session id  mvm1-<sha256(tenant:sub)[:16]>-<agent_project_id[:12]>-<job_id[:12]>-<attempt>
//               Two actors can never share a session by construction; the
//               same actor's next job (or next attempt) gets a fresh microVM.
//               AgentCore requires at least 33 characters.
//   branch      orgiq/<sub8>/<job8> — what the box pushes (main.py refuses any
//               branch outside orgiq/) and what a resume checks out.
//   box id      mvm:<session id> — the transient FleetBox that lets the tail
//               UI follow the run; never claimable by the fleet.
//   transcript  runs/<job id>/<attempt>/transcript.ndjson in the runs bucket.

import { createHash } from 'node:crypto';

export const MICROVM_SESSION_PREFIX = 'mvm1-';
export const MICROVM_BOX_PREFIX = 'mvm:';
export const MICROVM_BRANCH_PREFIX = 'orgiq/';
/** AgentCore's floor for runtimeSessionId (and the design's). */
export const MIN_SESSION_ID_LENGTH = 33;

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
/** Only what a runtime session id and a git ref both accept. */
const idSafe = (s: string): string => s.replace(/[^A-Za-z0-9-]/g, '-');

/** sha256(`<tenant>:<sub>`) as hex — the actor half of every derived name. */
export function actorHash(tenant: string, sub: string): string {
  return sha256Hex(`${tenant}:${sub}`);
}

export interface SessionIdParts {
  tenant: string;
  actorSub: string;
  agentProjectId: string;
  jobId: string;
  attempt: number;
}

/**
 * The runtime session id for one (actor, agent project, job attempt). Throws
 * when the parts are missing or the result would be under AgentCore's 33
 * characters, so a caller can never invoke with a guessable or shared id.
 */
export function microvmSessionId(p: SessionIdParts): string {
  if (!p.tenant || !p.actorSub) throw new Error('a microVM session id needs a tenant and an actor');
  if (!p.agentProjectId || !p.jobId) throw new Error('a microVM session id needs an agent project and a job');
  if (!Number.isInteger(p.attempt) || p.attempt < 1) throw new Error('a microVM session id needs an attempt >= 1');
  const id = `${MICROVM_SESSION_PREFIX}${actorHash(p.tenant, p.actorSub).slice(0, 16)}-${idSafe(p.agentProjectId.slice(0, 12))}-${idSafe(p.jobId.slice(0, 12))}-${p.attempt}`;
  if (id.length < MIN_SESSION_ID_LENGTH) throw new Error(`microVM session id ${id} is under ${MIN_SESSION_ID_LENGTH} characters`);
  return id;
}

export function isMicrovmSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(MICROVM_SESSION_PREFIX);
}

/** The transient FleetBox id for a session. */
export function microvmBoxId(sessionId: string): string {
  return `${MICROVM_BOX_PREFIX}${sessionId}`;
}

/** True for the runner's transient boxes: the fleet must never claim, adopt or reap one. */
export function isMicrovmBoxId(boxId: string | null | undefined): boolean {
  return typeof boxId === 'string' && boxId.startsWith(MICROVM_BOX_PREFIX);
}

/**
 * `orgiq/<sub8>/<job8>`. `sub8` is the first eight ref-safe characters of the
 * subject (a Cognito sub is a UUID, so its first block), falling back to the
 * actor hash when the subject has none; `job8` skips the table's `job-` prefix,
 * which would otherwise be half of it.
 */
export function microvmBranch(tenant: string, actorSub: string, jobId: string): string {
  const sub8 = actorSub.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || actorHash(tenant, actorSub).slice(0, 8);
  const job8 = jobId.replace(/^job-/, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || actorHash(tenant, jobId).slice(0, 8);
  return `${MICROVM_BRANCH_PREFIX}${sub8}/${job8}`;
}

/** The run's one transcript object, under the bucket's `runs/` prefix (30-day expiry). */
export function transcriptKey(jobId: string, attempt: number): string {
  return `runs/${idSafe(jobId)}/${attempt}/transcript.ndjson`;
}
