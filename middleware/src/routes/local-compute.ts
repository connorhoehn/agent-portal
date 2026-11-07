// Local compute — a developer's machine as a fleet participant.
//
//   POST   /api/local-compute/pair/start      mint a pairing code (browser session)
//   POST   /api/local-compute/pair/claim      claim it, receive the node token (machine, no session)
//   POST   /api/local-compute/register        advertise capabilities (machine, node token)
//   POST   /api/local-compute/announce        presence snapshot (machine, node token)
//   POST   /api/local-compute/heartbeat       proof of life (machine, node token)
//   POST   /api/local-compute/sessions/:id/end  a session ended (machine, node token)
//   POST   /api/local-compute/claim           take the next runnable job (machine, node token)
//   POST   /api/local-compute/jobs/:id/start      claimed → running (machine, fenced)
//   POST   /api/local-compute/jobs/:id/heartbeat  still working (machine, fenced)
//   POST   /api/local-compute/jobs/:id/complete   terminal state + cost (machine, fenced)
//   POST   /api/local-compute/jobs/:id/skills     R8: the org's skill library for this run (machine, fenced)
//   POST   /api/local-compute/jobs/:id/log        ship a chunk of run output (machine, fenced)
//   GET    /api/local-compute/jobs/:id/log        read the run log (browser session, owner-scoped)
//   GET    /api/local-compute/jobs/:id/log/stream tail the run log, as SSE (browser session, owner-scoped)
//   POST   /api/local-compute/log             ship operational log lines — the worker's own
//                                              scrollback between jobs (machine, node token)
//   GET    /api/local-compute/nodes/:id/log         read a machine's operational log (browser session, owner-scoped)
//   GET    /api/local-compute/nodes/:id/log/stream  tail it, as SSE (browser session, owner-scoped)
//   GET    /api/local-compute/nodes           my machines + live sessions (browser session)
//   GET    /api/local-compute/nodes/all       fleet-wide, session detail stripped (fleet-wide role)
//   GET    /api/local-compute/presence/repos  org-wide, per-repo presence counts only (fleet-wide role)
//   GET    /api/local-compute/stream          same, as SSE (browser session)
//   GET    /api/local-compute/events          presence + job SSE, hello snapshot on connect (browser session)
//   GET    /api/local-compute/runs            what my machines have been doing (browser session, owner-scoped)
//   PATCH  /api/local-compute/nodes/:id       rename / accept-jobs toggle (owner)
//   POST   /api/local-compute/nodes/:id/work  hand this machine a job (owner)
//   DELETE /api/local-compute/nodes/:id       revoke the machine's token (owner)
//
// ⚠️ Gate machine-callback routes per-route, never at the mount (CLAUDE.md:
// same rule as approvals/harness). The machine routes carry NODE-TOKEN auth —
// a session floor on this router would 401 every laptop's presence writes.
// The browser routes each carry their own session/capability gate below.
//
// Design doc: docs/local-compute-presence.md. Durable nodes:
// providers/local-compute.ts. Live sessions: lib/local-compute-fleet.ts.

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { reasonLine } from '../lib/upstream.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { rateLimit } from '../lib/rate-limit.js';
import { requireAction, requireSession, requireTenant, resolveSession } from '../lib/authz.js';
import { FLEET_WIDE_ROLES } from '../lib/devbox-visibility.js';
import {
  claimPairingCode,
  createPairingCode,
  getNodeByToken,
  getNode,
  getPairingCodeStatus,
  hasNodeCapabilityColumns,
  listAllNodes,
  listNodesByOwner,
  recordNodeCapabilities,
  renameNode,
  revokeNode,
  setAcceptJobs,
  touchNode,
  touchNodeClaim,
  type ComputeNode,
} from '../providers/local-compute.js';
import {
  recordAnnounce,
  recordHeartbeat,
  endSession,
  presenceOf,
  metricsOf,
  subscribePresence,
  localBoxId,
  nodeIdFromBoxId,
  type LocalSession,
  type NodePresence,
  type NodeMetrics,
  type NodeMetricsSnapshot,
} from '../lib/local-compute-fleet.js';
import {
  appendLog,
  markLogDone,
  getLog,
  subscribeLog,
  MAX_LOG_CHUNK,
} from '../lib/local-compute-logs.js';
import {
  appendNodeLog,
  getNodeLog,
  subscribeNodeLog,
  MAX_NODE_LOG_LINE,
  MAX_NODE_LOG_BATCH,
} from '../lib/local-compute-node-logs.js';
import {
  getJob,
  enqueueJob,
  listJobsForBoxes,
  hasPullSideColumns,
  claimNextJobForWorker,
  countLiveJobsForBox,
  heartbeatJob,
  markRunning,
  completeJob,
  jobEvents,
  type AgentJob,
  type JobChangeEvent,
} from '../providers/agent-jobs.js';
import { getWorkItem } from '../providers/work-items.js';
import { getBot } from '../providers/bots.js';
import { getAgentProject } from '../providers/agent-projects.js';
import { grantScopedDispatchVerdict, preflightWorkItem, renderPrompt } from '../lib/bot-runner.js';
import { isAllowed } from '../lib/authz.js';
import {
  decideClaim,
  allowedKinds,
  capConcurrency,
  frameLocalPrompt,
  briefForClaim,
  LOCAL_JOB_KINDS,
  LOCAL_HEARTBEAT_INTERVAL_S,
} from '../lib/local-work.js';
import { STALE_MINUTES } from '../lib/job-dispatcher.js';
import { parseReportedCost, resolveRunCost } from '../lib/run-cost.js';
import { recordSpend } from '../providers/spend-ledger.js';
import { DEMO_NODE_ID, demoPresenceSessions, demoMetrics } from '../mock/local-compute.js';
import {
  emitLocalAnnounce,
  emitLocalHeartbeat,
  emitLocalDisconnected,
  emitLocalSessionEnd,
} from '../work-graph/compute-emitter.js';
import { invalidateComputeCapabilitySource } from '../work-graph/compute-capability-runtime.js';
import { REPO_FULL_NAME_RE } from '../lib/repo-token-provider.js';

export const localComputeRouter = Router();

const MAX_SESSIONS_PER_ANNOUNCE = 20;

// The BROWSER half of this router is orgiq-only.
//
// Applied per route, never at the mount: `/announce`, `/heartbeat`,
// `/sessions/:id/end` and `/pair/claim` are machine callers with no session at
// all, and a blanket tenant gate would 401/403 every laptop's presence write —
// the trap CLAUDE.md's auth-floor gotcha describes.
//
// It is needed because filtering by OWNER is not the same question as which
// workspace you are standing in. An assessment user who also happens to own an
// orgiq machine saw it, and the initiative and branch it was working on, in
// the assessment header — with an action leading out of the tenant. `admin` is
// cross-tenant by design and still passes.
const browserTenant = requireTenant('orgiq');

// Mock-mode demo presence: dev:mock has no laptop announcing, so the seeded
// fixture node re-announces itself every minute, keeping its derived status
// honestly 'connected' rather than looking broken ninety seconds after boot.
// The session comes FROM the fixture (mock/local-compute.ts) rather than being
// retyped here: this block used to carry its own copy naming `p-realtime` and
// `realtime-platform`, two ids no seed creates, and because it overwrites the
// node every 60s those invented strings beat the fixture's real ones in a live
// dev:mock. Env-read directly, like every flag in devbox.ts, to stay importable
// under the CJS jest config.
if (process.env['MOCK_AURORA'] === 'true') {
  // demoMetrics() is clock-derived, not a frozen literal — see its own
  // comment — so the re-announce also keeps the demo machine's CPU/memory
  // numbers visibly moving, the offline-world stand-in for a real worker's
  // node:os reads.
  const announceDemo = () => recordAnnounce(DEMO_NODE_ID, demoPresenceSessions(), demoMetrics());
  announceDemo();
  setInterval(announceDemo, 60_000).unref();
}

// The pairing route is the only unauthenticated one — a pairing code is the
// entire credential — so it gets the same brake as the login picker.
const claimLimit = rateLimit('local-compute-claim', 30, 60_000);

// The work-loop routes poll. A worker holding two slots asks for work every few
// seconds and heartbeats every 30, so legitimate traffic from one machine is a
// handful of requests a minute; this ceiling is far above that and exists only so
// an unauthenticated flood cannot turn each request into a token-hash lookup
// against Aurora. Sized per-IP, and several machines can sit behind one NAT.
//
// ⚠️ This limiter and the concurrency brake both answer 429, and they mean
// opposite things — "slow down" versus "you are already at your slot limit and
// should wait for one of YOUR jobs to finish". They are told apart by the body:
// the limiter sends `{ error, bucket }`, the brake sends `{ error, gate }`. That
// is why `ClaimGate` exists rather than the worker reading the status alone.
const workLoopLimit = rateLimit('local-compute-work', 600, 60_000);

// ─── Machine auth: the node token ────────────────────────────────────────────
// `Authorization: Bearer lcn_…`. The provider resolves by sha256 lookup, so
// the plaintext token never persists anywhere but the machine's own config.

async function nodeFromRequest(req: Request): Promise<ComputeNode | null> {
  const header = req.headers['authorization'];
  const token = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : '';
  if (!token) return null;
  return getNodeByToken(token);
}

function requireNodeToken(
  handler: (req: Request, res: Response, node: ComputeNode) => Promise<void>,
) {
  return asyncHandler(async (req: Request, res: Response) => {
    const node = await nodeFromRequest(req);
    if (!node) {
      res.status(401).json({ error: 'invalid or revoked node token' });
      return;
    }
    await handler(req, res, node);
  });
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

localComputeRouter.post(
  '/pair/start',
  browserTenant,
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const pairing = await createPairingCode(session.sub);
    res.json(pairing);
  }),
);

// The browser that minted a code polls this while its dialog is open, so the
// dialog can say "paired" the moment the machine claims — instead of sitting
// on a code until someone closes it by hand. Owner-scoped: a code you did not
// mint 404s, the same answer as a code that never existed.
localComputeRouter.get(
  '/pair/:code',
  browserTenant,
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const code = String(req.params['code'] ?? '').trim();
    const status = code ? await getPairingCodeStatus(code, session.sub) : null;
    if (!status) {
      res.status(404).json({ error: 'no such pairing code' });
      return;
    }
    res.json({ ...status, claimed: status.claimedAt !== null });
  }),
);

localComputeRouter.post('/pair/claim', claimLimit, asyncHandler(async (req, res) => {
  const { code, node } = (req.body ?? {}) as {
    code?: unknown;
    node?: { nodeId?: unknown; label?: unknown; platform?: unknown };
  };
  const label = typeof node?.label === 'string' ? node.label.trim().slice(0, 80) : '';
  if (typeof code !== 'string' || !code.trim() || !label) {
    res.status(400).json({ error: 'code and node.label are required' });
    return;
  }
  const claimed = await claimPairingCode(code.trim(), {
    label,
    ...(typeof node?.nodeId === 'string' ? { nodeId: node.nodeId.slice(0, 64) } : {}),
    ...(typeof node?.platform === 'string' ? { platform: node.platform.slice(0, 40) } : {}),
  });
  if (!claimed) {
    // One message for expired, spent and unknown alike — a claim probe learns
    // nothing about which codes exist.
    res.status(404).json({ error: 'pairing code invalid or expired' });
    return;
  }
  res.status(201).json(claimed);
}));

// ─── Presence writes (machine) ───────────────────────────────────────────────

function parseSessions(body: unknown): LocalSession[] | null {
  const sessions = (body as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions) || sessions.length > MAX_SESSIONS_PER_ANNOUNCE) return null;
  const out: LocalSession[] = [];
  for (const raw of sessions) {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = raw as Record<string, unknown>;
    if (typeof s['sessionId'] !== 'string' || !s['sessionId']) return null;
    out.push({
      sessionId: s['sessionId'],
      harness: typeof s['harness'] === 'string' ? s['harness'] : 'unknown',
      ...(typeof s['projectId'] === 'string' ? { projectId: s['projectId'] } : {}),
      ...(typeof s['repo'] === 'string' ? { repo: s['repo'] } : {}),
      ...(typeof s['branch'] === 'string' ? { branch: s['branch'] } : {}),
      ...(typeof s['worktree'] === 'string' ? { worktree: s['worktree'] } : {}),
      ...(typeof s['intent'] === 'string' ? { intent: s['intent'] } : {}),
      ...(Array.isArray(s['touching'])
        ? { touching: s['touching'].filter((t): t is string => typeof t === 'string') }
        : {}),
      ...(typeof s['modelProvider'] === 'string' ? { modelProvider: s['modelProvider'] } : {}),
      ...(typeof s['model'] === 'string' ? { model: s['model'] } : {}),
      ...(typeof s['contextUsed'] === 'number' && Number.isFinite(s['contextUsed'])
        ? { contextUsed: Math.max(0, Math.min(1, s['contextUsed'])) }
        : {}),
      ...(typeof s['memory'] === 'object' && s['memory'] !== null
        ? { memory: s['memory'] as LocalSession['memory'] }
        : {}),
      ...(typeof s['startedAt'] === 'number' ? { startedAt: s['startedAt'] } : {}),
      lastSeenAt: '', // stamped server-side by the fleet
    });
  }
  return out;
}

/**
 * The optional `metrics` object off an announce body — all fields
 * independently optional, matching the contract worker.mjs reads from
 * `node:os` and may fail to fully populate. `false` means present but
 * malformed (wrong type, a negative/non-finite/absurd number) — the whole
 * write is rejected rather than storing a value nobody would trust; `null`
 * means the field was absent or explicitly null, a no-op for an older or
 * degraded worker.
 */
const METRIC_BOUNDS: Record<string, number> = {
  loadAvg1: 1_000,
  cpuCount: 4_096,
  memTotalMb: 100_000_000, // ~100 TB — headroom, not a real ceiling
  memFreeMb: 100_000_000,
  uptimeS: 3_155_760_000, // ~100 years
  activeJobs: 1_000,
};
const INTEGER_METRICS = new Set(['cpuCount', 'activeJobs']);
const MAX_WORKER_VERSION_LEN = 40;

function parseMetrics(body: unknown): NodeMetrics | null | false {
  const raw = (body as { metrics?: unknown })?.metrics;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return false;
  const m = raw as Record<string, unknown>;
  const out: NodeMetrics = {};
  for (const [key, max] of Object.entries(METRIC_BOUNDS)) {
    const v = m[key];
    if (v === undefined) continue;
    if (
      typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max
      || (INTEGER_METRICS.has(key) && !Number.isInteger(v))
    ) {
      return false;
    }
    (out as Record<string, number>)[key] = v;
  }
  if (m['workerVersion'] !== undefined) {
    if (typeof m['workerVersion'] !== 'string') return false;
    out.workerVersion = m['workerVersion'].trim().slice(0, MAX_WORKER_VERSION_LEN);
  }
  return out;
}

localComputeRouter.post('/announce', requireNodeToken(async (req, res, node) => {
  const sessions = parseSessions(req.body);
  if (sessions === null) {
    res.status(400).json({ error: `sessions must be an array of ≤${MAX_SESSIONS_PER_ANNOUNCE} session records` });
    return;
  }
  const metrics = parseMetrics(req.body);
  if (metrics === false) {
    res.status(400).json({
      error: 'metrics, when present, must be an object of finite non-negative numbers '
        + '(loadAvg1, cpuCount, memTotalMb, memFreeMb, uptimeS, activeJobs, all optional and within '
        + 'sane bounds) plus an optional workerVersion string',
    });
    return;
  }
  const before = presenceOf(node.id);
  const presence = recordAnnounce(node.id, sessions, metrics);
  await touchNode(node.id);
  // The paired node and its owner were resolved before the request body was
  // parsed. Emit only the mapper's safe session lifecycle to the signed,
  // durable platform boundary; repo/worktree/intent never leave this route.
  await emitLocalAnnounce(node, presence.sessions);
  // An announce is an authoritative snapshot. Sessions omitted from it ended;
  // emit their terminal lifecycle from the paired node, not from a client
  // assertion made after the fact.
  const active = new Set(presence.sessions.map((session) => session.sessionId));
  await Promise.all(before.sessions
    .filter((session) => !active.has(session.sessionId))
    .map((session) => {
      invalidateComputeCapabilitySource('local-compute', `session:${node.id}:${session.sessionId}`);
      return emitLocalSessionEnd(node, session.sessionId, presence.lastSeenAt ?? new Date().toISOString());
    }));
  res.json({ ok: true, nodeId: node.id, sessions: presence.sessions.length });
}));

localComputeRouter.post('/heartbeat', requireNodeToken(async (_req, res, node) => {
  recordHeartbeat(node.id);
  await touchNode(node.id);
  const heartbeatAt = presenceOf(node.id).lastSeenAt;
  if (heartbeatAt) await emitLocalHeartbeat(node, heartbeatAt);
  res.json({ ok: true });
}));

localComputeRouter.post('/sessions/:sessionId/end', requireNodeToken(async (req, res, node) => {
  const sessionId = String(req.params['sessionId']);
  const removed = endSession(node.id, sessionId);
  await touchNode(node.id);
  const endedAt = presenceOf(node.id).lastSeenAt;
  if (removed) invalidateComputeCapabilitySource('local-compute', `session:${node.id}:${sessionId}`);
  if (removed && endedAt) await emitLocalSessionEnd(node, sessionId, endedAt);
  res.json({ ok: true, removed });
}));

// ─── Registration: what this machine can run (machine) ───────────────────────
//
// Separate from `/announce` on purpose. An announce is presence — "these
// sessions are alive right now" — and happens constantly; registration is a
// worker starting up and stating its shape, and it is the write that decides
// what the claim route will offer it. Folding the two together would mean a
// presence ping could silently re-narrow capabilities, and a worker that
// stopped sending them would lose its registration by omission.

const MAX_MODELS = 20;
const MAX_MODEL_LEN = 120;

/** A string array off the wire, bounded and trimmed. Anything else reads as
 *  none — a garbled advertisement must narrow what a node is offered rather
 *  than 400 a worker out of the fleet over a stray field. */
function stringList(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, max)
    .map((s) => s.trim().slice(0, len));
}

localComputeRouter.post('/register', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const body = (req.body ?? {}) as {
    localModels?: unknown; jobKinds?: unknown; maxConcurrency?: unknown;
  };
  const localModels = stringList(body.localModels, MAX_MODELS, MAX_MODEL_LEN);
  const asked = stringList(body.jobKinds, LOCAL_JOB_KINDS.length + MAX_MODELS, 40);
  const jobKinds = allowedKinds(asked);
  const maxConcurrency = capConcurrency(body.maxConcurrency);

  const updated = await recordNodeCapabilities(node.id, { localModels, jobKinds, maxConcurrency });
  if (!updated) {
    // `recordNodeCapabilities` returns null on a cluster without the columns,
    // and that has to be LOUD here. Accepting the registration and dropping the
    // capabilities would leave a worker convinced it had registered for kinds
    // nobody recorded, polling forever against a claim route that can never
    // offer it anything.
    const ready = await hasNodeCapabilityColumns();
    res.status(ready ? 404 : 503).json({
      error: ready
        ? 'node not found'
        : 'this cluster has not applied schema/local_compute_worker_schema.sql — '
          + 'apply it and restart the middleware, then register again',
    });
    return;
  }

  // What was DROPPED, said out loud. A worker that advertised `devbox:task` gets
  // told it was not accepted rather than discovering it by never being offered
  // one — silent narrowing is indistinguishable from an empty queue.
  const rejected = asked.filter((k) => !(jobKinds as readonly string[]).includes(k));

  res.json({
    nodeId: updated.id,
    label: updated.label,
    // The owner's switch, echoed back because it is the one thing the worker
    // cannot set for itself and the most common reason a claim is refused.
    acceptJobs: updated.acceptJobs,
    localModels: updated.localModels,
    jobKinds: updated.jobKinds,
    maxConcurrency: updated.maxConcurrency,
    ...(rejected.length ? { rejectedKinds: rejected, runnableKinds: LOCAL_JOB_KINDS } : {}),
    heartbeatIntervalS: LOCAL_HEARTBEAT_INTERVAL_S,
    staleMinutes: STALE_MINUTES,
  });
}));

// ─── The work loop (machine, fenced) ─────────────────────────────────────────
//
// A laptop has no inbound path, so it pulls: claim → start → heartbeat… →
// complete. Every write after the claim carries the fencing token minted by the
// claim, and every one of them ALSO checks that the job belongs to this node's
// box id. The token alone would be enough to authorise the write; the ownership
// check is what makes a wrong token a flat 404 instead of a 409 that confirms
// somebody else's job exists.

/** The job named by `:jobId`, if this node holds it, plus the token it sent. */
async function fencedJob(
  req: Request, res: Response, node: ComputeNode,
): Promise<{ job: AgentJob; claimToken: string } | null> {
  const claimToken = typeof (req.body as { claimToken?: unknown })?.claimToken === 'string'
    ? String((req.body as { claimToken?: unknown }).claimToken)
    : '';
  if (!claimToken) {
    res.status(400).json({ error: 'claimToken is required — it was returned once, by the claim' });
    return null;
  }
  const job = await getJob(String(req.params['jobId'] ?? ''));
  if (!job || job.boxId !== localBoxId(node.id)) {
    // One message for "no such job" and "not yours", so a node cannot probe the
    // queue for ids it does not hold.
    res.status(404).json({ error: 'no such claim on this machine' });
    return null;
  }
  return { job, claimToken };
}

localComputeRouter.post('/claim', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const boxId = localBoxId(node.id);
  // Counted against the DATABASE, not against what the worker thinks it holds —
  // a worker that crashed and restarted has forgotten its claims; the rows have
  // not, and the reaper is the thing that releases them.
  const [pullSideReady, liveJobs] = await Promise.all([
    hasPullSideColumns(),
    countLiveJobsForBox(boxId),
  ]);

  const verdict = decideClaim({ node, liveJobs, pullSideReady });
  if (verdict.kind === 'deny') {
    // A refused claim is still a claim: the loop is running, the server said
    // no. Recording it as a poll is what lets the page distinguish "switched
    // off" from "switched on and being turned away".
    await touchNodeClaim(node.id);
    res.status(verdict.status).json({ error: verdict.reason, gate: verdict.gate });
    return;
  }

  // One session id, minted server-side, used for BOTH the queue row and the
  // presence record the worker announces. The worker could invent its own, but
  // then the fleet view would carry two unrelated ids for one piece of work and
  // no way to join them — which is how a running local job showed up as an
  // anonymous session next to a job with an anonymous worker.
  const sessionId = `local-${node.id}-${randomUUID()}`;
  // `nodeId` is what makes a targeted job reachable by exactly one machine — see
  // claimNextJobForWorker's targeting note. It comes from the authenticated node,
  // never from the request, so a worker cannot claim another machine's work by
  // asking for it.
  const claim = await claimNextJobForWorker({ boxId, sessionId, kinds: verdict.kinds, nodeId: node.id });
  // `touchNodeClaim`, not `touchNode`: this is the work loop turning, and
  // presence alone cannot say whether it is. A paired laptop whose worker is
  // switched off still announces.
  await touchNodeClaim(node.id);

  if (!claim) {
    // Empty queue is not an error, and it is the common case: a worker polls a
    // quiet queue all day. 204 keeps that out of the error logs and out of the
    // worker's error path.
    res.status(204).end();
    return;
  }

  // The session brief freezes at claim — the one chokepoint every locally run
  // job passes through — and rides INSIDE the framing (lib/local-work.ts).
  // R8: a worker that installs the org's skill library as project skills says so on the claim
  // (`projectSkills: true`); an older worker does not, and its brief says the skills are not here.
  const brief = await briefForClaim(claim.job, { projectSkills: (req.body as { projectSkills?: unknown } | undefined)?.projectSkills === true });

  res.json({
    // The prompt the worker runs is framed here rather than stored framed, so
    // the job row keeps the task somebody actually asked for. See
    // `frameLocalPrompt` for why an unframed prompt ends the run with a
    // question nobody can answer.
    job: {
      ...claim.job,
      payload: {
        ...claim.job.payload,
        ...(brief ? { brief_id: brief.id, brief_sha: brief.sha256 } : {}),
        ...(typeof claim.job.payload['prompt'] === 'string'
          ? {
            prompt: frameLocalPrompt(
              claim.job.payload['prompt'] as string,
              claim.job.payload['requiresReview'] !== false,
              brief,
            ),
          }
          : {}),
      },
    },
    claimToken: claim.claimToken,
    sessionId,
    // What the frozen brief told the run about the org's skills (null: no brief froze).
    skillLibrary: brief?.skill_library ?? null,
    heartbeatIntervalS: LOCAL_HEARTBEAT_INTERVAL_S,
    staleMinutes: STALE_MINUTES,
    slots: { held: liveJobs + 1, limit: verdict.limit },
  });
}));

localComputeRouter.post('/jobs/:jobId/start', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const held = await fencedJob(req, res, node);
  if (!held) return;
  const ok = await markRunning(held.job.id, held.claimToken);
  await touchNode(node.id);
  if (!ok) {
    res.status(409).json({
      error: 'this claim is no longer live — it was requeued or cancelled; abandon the run',
      gate: 'claim_lost',
    });
    return;
  }
  res.json({ ok: true, jobId: held.job.id });
}));

localComputeRouter.post('/jobs/:jobId/heartbeat', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const held = await fencedJob(req, res, node);
  if (!held) return;
  const alive = await heartbeatJob(held.job.id, held.claimToken);
  // Presence and the node's own last-seen move too: a machine mid-job is the
  // most alive it ever is, and a worker that heartbeats its job but reads as
  // 'offline' in the fleet view is the confusing half of a working system.
  recordHeartbeat(node.id);
  await touchNode(node.id);
  if (!alive) {
    res.status(409).json({
      error: 'this claim is no longer live — it was requeued or cancelled; abandon the run',
      gate: 'claim_lost',
    });
    return;
  }
  res.json({ ok: true, jobId: held.job.id });
}));

// R8 — the org's skill library, for a local run. The same whole set, the same bytes and the same
// content-addressed sha a devbox gets from GET /api/runs/:ref/skills; only the door differs: a
// laptop holds a node token and this job's claim token, not the lab envelope. The worker
// (tools/local-compute-skills.mjs) verifies every file and the set sha exactly as `lab skills`
// does, and installs it as project skills in the run's checkout. `have` (or If-None-Match) is the
// sha the checkout already holds; a match is a 304 and no copy.
localComputeRouter.post('/jobs/:jobId/skills', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const held = await fencedJob(req, res, node);
  if (!held) return;
  // Only while the claim is live: a requeued or cancelled run is not this machine's to equip.
  if (!(await heartbeatJob(held.job.id, held.claimToken))) {
    res.status(409).json({ error: 'this claim is no longer live — it was requeued or cancelled; abandon the run', gate: 'claim_lost' });
    return;
  }
  const { loadSkillLibrary, LIBRARY_FORMAT } = await import('../lib/runbooks/library.js');
  const { runbookStore } = await import('../lib/runbooks/store-select.js');
  const lib = await loadSkillLibrary(await runbookStore());
  res.setHeader('ETag', `"${lib.sha256}"`);
  res.setHeader('X-Skill-Library-Sha256', lib.sha256);
  res.setHeader('Cache-Control', 'private, no-cache');
  const have = (req.body as { have?: unknown } | undefined)?.have;
  const inm = String(req.headers['if-none-match'] ?? '').split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
  if ((typeof have === 'string' && have === lib.sha256) || inm.includes(lib.sha256)) { res.status(304).end(); return; }
  res.json({ format: LIBRARY_FORMAT, sha256: lib.sha256, bytes: lib.bytes, skills: lib.skills, files: lib.files, skipped: lib.skipped });
}));

const TERMINAL: readonly string[] = ['done', 'failed', 'awaiting_review'];

localComputeRouter.post('/jobs/:jobId/complete', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const held = await fencedJob(req, res, node);
  if (!held) return;
  const body = (req.body ?? {}) as {
    status?: unknown; result?: unknown; error?: unknown; costUsd?: unknown;
    model?: unknown; tokensIn?: unknown; tokensOut?: unknown;
  };
  const status = typeof body.status === 'string' && TERMINAL.includes(body.status)
    ? body.status as 'done' | 'failed' | 'awaiting_review'
    : null;
  if (!status) {
    // Required, not defaulted. This is the write that ends the job, and guessing
    // 'done' for a worker that forgot the field would record a success nobody
    // claimed — the same shape as the `subtype: success` bug in lib/run-cost.ts.
    res.status(400).json({ error: `status must be one of ${TERMINAL.join(', ')}` });
    return;
  }

  // The cost decision, in one place and not the worker's to make. `provider` is
  // 'local' because of the ROUTE this arrived on — the middleware's own knowledge
  // of which execution path ran the job — never because the body said so. What
  // the run claimed is kept beside the recorded figure so the override is
  // auditable rather than silent; see lib/run-cost.ts for the measurement that
  // made this necessary (a loopback run reporting first-party Sonnet list price).
  const reported = parseReportedCost({ total_cost_usd: body.costUsd ?? null });
  const cost = resolveRunCost('local', reported);

  const supplied = typeof body.result === 'object' && body.result !== null && !Array.isArray(body.result)
    ? body.result as Record<string, unknown>
    : {};
  const result: Record<string, unknown> = {
    // The worker's own payload first, so the fields below OVERWRITE it. A body
    // that sets `provider: 'bedrock'` or `costUsd: 4.20` cannot win: this is a
    // trust boundary, and the machine is on the far side of it.
    ...supplied,
    provider: cost.provider,
    costUsd: cost.costUsd,
    ...(reported !== null ? { reportedCostUsd: reported } : {}),
    ...(cost.note ? { costNote: cost.note } : {}),
    nodeId: node.id,
    nodeLabel: node.label,
    ...(typeof body.model === 'string' ? { model: body.model.slice(0, MAX_MODEL_LEN) } : {}),
    ...(Number.isFinite(Number(body.tokensIn)) ? { tokensIn: Number(body.tokensIn) } : {}),
    ...(Number.isFinite(Number(body.tokensOut)) ? { tokensOut: Number(body.tokensOut) } : {}),
  };

  const ok = await completeJob(held.job.id, {
    status,
    result,
    ...(typeof body.error === 'string' && body.error.trim() ? { error: body.error.trim().slice(0, 2000) } : {}),
    claimToken: held.claimToken,
  });

  // Presence: the session minted at claim time is over. Done regardless of
  // whether the write applied — either way this machine is no longer running it,
  // and a leftover session would keep the job's worktree and intent on screen.
  if (held.job.sessionId) endSession(node.id, held.job.sessionId);
  // The run is over — tell any tailing browser to stop polling. Done regardless
  // of whether the fence applied: either way this machine has stopped emitting.
  markLogDone(held.job.id);
  await touchNode(node.id);

  if (!ok) {
    // The fence did its job: this claim was requeued (and possibly already
    // re-run) while the worker was working. Refusing is the whole point — the
    // alternative is overwriting a newer result with an older one.
    res.status(409).json({
      error: 'this claim was no longer live, so nothing was recorded — the job was requeued or cancelled',
      gate: 'claim_lost',
    });
    return;
  }
  // The ledger entry (DE-33): a confident $0 with `provider = 'local'`, so
  // local work is metered (not absent) and never mistaken for a Bedrock run
  // that reported $0. A job a bot run owns books nothing here: that run's
  // settle writes its money. No hold was taken for it (local runs cost $0).
  if (!held.job.botId) {
    const initiative = held.job.payload['initiativeId'];
    await recordSpend({
      source: 'job',
      sourceId: `${held.job.id}:${held.job.attempts}`,
      initiativeId: typeof initiative === 'string' && initiative ? initiative : null,
      boxId: held.job.boxId,
      actorId: held.job.createdBy,
      model: typeof body.model === 'string' ? body.model.slice(0, MAX_MODEL_LEN) : null,
      costUsd: cost.costUsd,
      costBasis: 'reported',
      provider: cost.provider,
      inputTokens: Number.isFinite(Number(body.tokensIn)) ? Number(body.tokensIn) : null,
      outputTokens: Number.isFinite(Number(body.tokensOut)) ? Number(body.tokensOut) : null,
    }, { unlessBotRunOwnsJob: held.job.id });
  }
  res.json({ ok: true, jobId: held.job.id, status, costUsd: cost.costUsd, provider: cost.provider });
}));

// ─── Run logs ────────────────────────────────────────────────────────────────
//
// The machine ships stdout/stderr chunks while a claimed job runs (fenced, like
// every other post-claim write); a browser reads or tails them. The ingest side
// is a node-token callback; the read side is owner-scoped exactly like the
// presence reads — a run's output is a person's work, so it stays with the owner
// of the machine that produced it, even from a fleet-wide role.

localComputeRouter.post('/jobs/:jobId/log', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const held = await fencedJob(req, res, node);
  if (!held) return;
  const body = (req.body ?? {}) as { seq?: unknown; chunk?: unknown };
  const seq = Number(body.seq);
  if (!Number.isFinite(seq) || seq < 0) {
    res.status(400).json({ error: 'seq must be a non-negative number' });
    return;
  }
  const chunk = typeof body.chunk === 'string' ? body.chunk : '';
  if (!chunk) {
    res.status(400).json({ error: 'chunk must be a non-empty string' });
    return;
  }
  appendLog(held.job.id, Math.floor(seq), chunk.slice(0, MAX_LOG_CHUNK));
  res.json({ ok: true });
}));

/** The job named by `:jobId` if it runs on a machine THIS session owns, else a
 *  flat 404 — the same opacity fencedJob gives the machine side, so a browser
 *  cannot probe the queue for run ids it has no claim to see. */
async function ownedLocalJob(
  req: Request, res: Response,
): Promise<{ jobId: string } | null> {
  const session = resolveSession(req)!;
  const jobId = String(req.params['jobId'] ?? '');
  const job = await getJob(jobId);
  if (!job || !job.boxId) {
    res.status(404).json({ error: 'no such run log' });
    return null;
  }
  const own = await listNodesByOwner(session.sub);
  const ownBoxIds = new Set(own.map((n) => localBoxId(n.id)));
  if (!ownBoxIds.has(job.boxId)) {
    res.status(404).json({ error: 'no such run log' });
    return null;
  }
  return { jobId };
}

localComputeRouter.get(
  '/jobs/:jobId/log',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const owned = await ownedLocalJob(req, res);
    if (!owned) return;
    const sinceRaw = Number(req.query['since']);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : -1;
    // A run that has shipped nothing yet is not an error — return the empty
    // shape so a poller that opened before the first chunk sees `done:false`
    // and keeps polling rather than 404ing.
    res.json(getLog(owned.jobId, since) ?? {
      jobId: owned.jobId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null, done: false,
    });
  }),
);

localComputeRouter.get(
  '/jobs/:jobId/log/stream',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const owned = await ownedLocalJob(req, res);
    if (!owned) return;
    initSSE(res);
    const snap = getLog(owned.jobId);
    if (snap) {
      for (const e of snap.entries) writeSSE(res, { type: 'log', seq: e.seq, chunk: e.text });
      if (snap.done) writeSSE(res, { type: 'done' });
    }
    const unsubscribe = subscribeLog(owned.jobId, (entry) => {
      writeSSE(res, { type: 'log', seq: entry.seq, chunk: entry.text });
    });
    req.on('close', unsubscribe);
  }),
);

// ─── Node operational log ────────────────────────────────────────────────────
//
// What the machine ships between jobs — `tools/local-compute-worker.mjs`
// `emit()` lines: registered, paired, presence acknowledged, warnings, a claim
// refused. Distinct from `jobs/:jobId/log` above, which carries ONE claimed
// run's stdout and disappears when that run's row ages out. The gap this
// closes: a worker paired and left running is otherwise invisible between
// jobs — the only place its state was ever visible was the terminal it was
// started in, on the machine, which is exactly the situation "I'm elsewhere
// and this thing has been pulling work while I was gone" cannot use.
//
// Ingest is a node-token callback, not fenced by a claim — these lines exist
// BETWEEN jobs by construction, so there is no job claim to fence them with.
// The read side is owner-scoped, same posture as the run log and presence
// detail: a machine's own scrollback is that person's own work.

/** Lines per POST /log batch, and a single line's clamp — see
 *  lib/local-compute-node-logs.ts for why these numbers. */
function parseNodeLogLines(body: unknown): Array<{ seq: number; text: string; run: string }> | null {
  const lines = (body as { lines?: unknown })?.lines;
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_NODE_LOG_BATCH) return null;
  // A batch-level `run` (the worker's boot id) applies to every line in it;
  // a per-line `run` wins if one is ever sent. OPTIONAL on purpose — a worker
  // built before this shipped sends none and lands in the '' run, which is
  // exactly its old behaviour. See appendNodeLog for what run buys.
  const batchRun = typeof (body as { run?: unknown })?.run === 'string'
    ? String((body as { run?: unknown }).run).slice(0, 64) : '';
  const out: Array<{ seq: number; text: string; run: string }> = [];
  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null) return null;
    const l = raw as Record<string, unknown>;
    const seq = Number(l['seq']);
    const text = typeof l['text'] === 'string' ? l['text'] : '';
    if (!Number.isFinite(seq) || seq < 0 || !text) return null;
    const run = typeof l['run'] === 'string' ? l['run'].slice(0, 64) : batchRun;
    out.push({ seq: Math.floor(seq), text: text.slice(0, MAX_NODE_LOG_LINE), run });
  }
  return out;
}

localComputeRouter.post('/log', workLoopLimit, requireNodeToken(async (req, res, node) => {
  const lines = parseNodeLogLines(req.body);
  if (!lines) {
    res.status(400).json({
      error: `lines must be a non-empty array of ≤${MAX_NODE_LOG_BATCH} { seq, text } records `
        + '(seq a non-negative number, text a non-empty string)',
    });
    return;
  }
  for (const { seq, text, run } of lines) appendNodeLog(node.id, seq, text, run);
  res.json({ ok: true, nodeId: node.id, lines: lines.length });
}));

/**
 * The node named by `:nodeId`, if this session owns it — else a flat 404, the
 * same opacity `ownedLocalJob` gives the run log so a browser cannot probe
 * for a machine id it has no claim to see.
 *
 * Wrapped in try/catch, unlike most reads on this router: `listNodesByOwner`
 * hits Aurora (or the mock), and this is a route the ask specifically wants
 * to fail HONESTLY rather than 500 — a person checking on a machine they left
 * running should see "could not check" (degraded), not a broken page.
 */
async function ownedNodeForLog(
  req: Request, res: Response,
): Promise<{ nodeId: string } | { degraded: true } | null> {
  const session = resolveSession(req)!;
  const nodeId = String(req.params['nodeId'] ?? '');
  let own: ComputeNode[];
  try {
    own = await listNodesByOwner(session.sub);
  } catch (err) {
    res.json({
      nodeId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null,
      degraded: true,
      error: reasonLine(err),
    });
    return { degraded: true };
  }
  if (!own.some((n) => n.id === nodeId)) {
    res.status(404).json({ error: 'no such machine log' });
    return null;
  }
  return { nodeId };
}

localComputeRouter.get(
  '/nodes/:nodeId/log',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const owned = await ownedNodeForLog(req, res);
    if (!owned || 'degraded' in owned) return; // response already written above
    const sinceRaw = Number(req.query['since']);
    const since = Number.isFinite(sinceRaw) ? sinceRaw : -1;
    // A machine that has never shipped an operational line — an older
    // worker, or one whose first flush hasn't fired yet — is not an error;
    // the empty shape lets the panel say so honestly rather than hanging.
    res.json(getNodeLog(owned.nodeId, since) ?? {
      nodeId: owned.nodeId, entries: [], lastSeq: -1, bytes: 0, updatedAt: null,
    });
  }),
);

localComputeRouter.get(
  '/nodes/:nodeId/log/stream',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const owned = await ownedNodeForLog(req, res);
    if (!owned || 'degraded' in owned) return;
    initSSE(res);
    const snap = getNodeLog(owned.nodeId);
    if (snap) {
      for (const e of snap.entries) writeSSE(res, { type: 'log', seq: e.seq, chunk: e.text });
    }
    const unsubscribe = subscribeNodeLog(owned.nodeId, (entry) => {
      writeSSE(res, { type: 'log', seq: entry.seq, chunk: entry.text });
    });
    req.on('close', unsubscribe);
  }),
);

// ─── Presence reads (browser) ────────────────────────────────────────────────

interface NodeView extends ComputeNode {
  presence: NodePresence;
}

/** What `GET /nodes` and `GET /events`'s hello frame both render — the owned
 *  shape, with the machine's last-reported health alongside its presence. */
interface OwnedNodeView extends NodeView {
  metrics: NodeMetricsSnapshot | null;
}

function ownedView(node: ComputeNode): OwnedNodeView {
  return { ...node, presence: presenceOf(node.id), metrics: metricsOf(node.id) };
}

/** Presence detail is about a person's live work (intents, worktree paths) —
 *  it stays with the owner. Fleet-wide roles see that machines exist and how
 *  many sessions they carry, not what those sessions are doing. */
function summarize(node: ComputeNode): Omit<NodeView, 'presence'> & {
  presence: Omit<NodePresence, 'sessions'> & { sessionCount: number };
} {
  const presence = presenceOf(node.id);
  return {
    ...node,
    presence: {
      nodeId: presence.nodeId,
      status: presence.status,
      lastSeenAt: presence.lastSeenAt,
      sessionCount: presence.sessions.length,
    },
  };
}

localComputeRouter.get(
  '/nodes',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const own = await listNodesByOwner(session.sub);
    const nodes: OwnedNodeView[] = own.map(ownedView);
    res.json({ nodes });
  }),
);

localComputeRouter.get(
  '/nodes/all',
  // Tenant check runs AFTER the fleet-wide role check here, deliberately: the
  // bespoke gate below answers a cookie-less caller 403 rather than 401, which
  // is this route's documented contract and pinned by its test. Putting the
  // tenant gate first would turn that into a 401.
  (req: Request, res: Response, next: NextFunction) => {
    const session = resolveSession(req);
    const role = session?.role ?? '';
    if (session && (role === 'admin' || (FLEET_WIDE_ROLES as readonly string[]).includes(role))) {
      next();
      return;
    }
    res.status(403).json({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
  },
  browserTenant,
  asyncHandler(async (_req, res) => {
    // Operational visibility for fleet-wide roles: which machines are
    // contributing and how much — never the session detail.
    const nodes = (await listAllNodes()).map(summarize);
    res.json({ nodes });
  }),
);

// Slice 5 (docs/distillation-concept-audit-2026-09-16.md §2): the one join
// key distillation and local-compute genuinely share is `repo` — the two
// domains mint session/box ids from disjoint spaces, so a row-level join is
// dishonest and only a repo-level one is real. This is the org-wide read
// that answers it: same redaction posture as `/nodes/all`'s `summarize()`
// ("never the session detail") — no nodeId, no label, no sessionId, no
// intent, no model, not even which machine. Just a repo, how many machines
// are touching it, how many live sessions, and the most recent heartbeat.
// Gated the same bespoke way as `/nodes/all` and for the same reason: this
// is fleet-wide operational visibility, not the personal `ConnectLocalCompute`
// authority to pair or drive your own machine.
localComputeRouter.get(
  '/presence/repos',
  (req: Request, res: Response, next: NextFunction) => {
    const session = resolveSession(req);
    const role = session?.role ?? '';
    if (session && (role === 'admin' || (FLEET_WIDE_ROLES as readonly string[]).includes(role))) {
      next();
      return;
    }
    res.status(403).json({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
  },
  browserTenant,
  asyncHandler(async (_req, res) => {
    // Presence lives only in memory (lib/local-compute-fleet.ts, backed by
    // the `local-presence` fixture even outside dev:mock — see that file's
    // header) regardless of whether `compute_nodes` itself is Aurora or
    // mocked, so `listAllNodes()` (which DOES branch on Aurora) supplies the
    // node roster and `presenceOf` supplies the live sessions for each.
    const nodes = await listAllNodes();
    const byRepo = new Map<string, { machines: Set<string>; sessions: number; lastSeenAt: string | null }>();
    for (const node of nodes) {
      // presenceOf already reports zero sessions for an offline node (see
      // its own comment: "reporting them would offer presence the machine
      // can't back"), so everything reachable here is connected or stale.
      const presence = presenceOf(node.id);
      for (const sess of presence.sessions) {
        if (!sess.repo) continue;
        let agg = byRepo.get(sess.repo);
        if (!agg) {
          agg = { machines: new Set(), sessions: 0, lastSeenAt: null };
          byRepo.set(sess.repo, agg);
        }
        agg.machines.add(node.id);
        agg.sessions += 1;
        if (!agg.lastSeenAt || Date.parse(sess.lastSeenAt) > Date.parse(agg.lastSeenAt)) {
          agg.lastSeenAt = sess.lastSeenAt;
        }
      }
    }
    const repos = [...byRepo.entries()]
      .map(([repo, agg]) => ({ repo, machines: agg.machines.size, sessions: agg.sessions, lastSeenAt: agg.lastSeenAt }))
      .sort((a, b) => a.repo.localeCompare(b.repo));
    res.json({ repos });
  }),
);

localComputeRouter.get('/stream', browserTenant, requireSession('ViewLocalCompute'), asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const own = await listNodesByOwner(session.sub);
  const ownIds = new Set(own.map((n) => n.id));

  initSSE(res);
  for (const node of own) {
    writeSSE(res, { type: 'presence', node: { ...node, presence: presenceOf(node.id) } });
  }
  const unsubscribe = subscribePresence((nodeId) => {
    if (!ownIds.has(nodeId)) return;
    const node = own.find((n) => n.id === nodeId);
    if (node) writeSSE(res, { type: 'presence', node: { ...node, presence: presenceOf(nodeId) } });
  });
  req.on('close', unsubscribe);
}));

/**
 * The presence-page live feed: one connect-time snapshot plus every
 * presence/metrics/job event that touches this owner's OWN machines,
 * scoped the same way `/nodes` is (`listNodesByOwner`) and the same way
 * `/stream` already scopes presence (`ownIds`). Two feeds, one stream,
 * because the page that motivated this (connection status, running/stopped
 * state, live metrics) needs both without opening two SSE connections.
 *
 * `/stream` is left exactly as it is — this is additive, not a replacement,
 * and existing callers of `/stream` keep the shape they have.
 */
localComputeRouter.get(
  '/events',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const own = await listNodesByOwner(session.sub);
    const ownIds = new Set(own.map((n) => n.id));

    initSSE(res);
    // One full snapshot in the same shape /nodes returns, so a client that
    // opens this stream cold has something to render before the first live
    // event — never a second round-trip to GET /nodes just to bootstrap.
    writeSSE(res, { type: 'hello', nodes: own.map(ownedView) });

    const onPresence = (nodeId: string) => {
      if (!ownIds.has(nodeId)) return;
      const presence = presenceOf(nodeId);
      writeSSE(res, {
        type: 'presence',
        nodeId,
        status: presence.status,
        lastSeenAt: presence.lastSeenAt,
        // Riding the same notify() a session announce/heartbeat/end already
        // fires — a metrics-only change lands on the SAME frame kind a
        // status transition does, since both are "this machine's presence
        // record changed" and a second frame TYPE for one field would be a
        // distinction the client gains nothing from.
        metrics: metricsOf(nodeId),
      });
    };
    const unsubscribePresence = subscribePresence(onPresence);

    // A job's owner is its box id (`local:<nodeId>`) once claimed, or its
    // TARGETING `payload.nodeId` before that — a queued-but-unclaimed job
    // handed to a machine has no box id yet, and that is exactly the window
    // someone watching "up next on <machine>" cares about.
    const onJob = (ev: JobChangeEvent) => {
      const nodeId = nodeIdFromBoxId(ev.boxId)
        ?? (typeof ev.payload['nodeId'] === 'string' ? (ev.payload['nodeId'] as string) : null);
      if (!nodeId || !ownIds.has(nodeId)) return;
      writeSSE(res, { type: 'job', jobId: ev.jobId, nodeId, status: ev.status, title: ev.title, at: ev.at });
    };
    jobEvents.on('change', onJob);

    req.on('close', () => {
      unsubscribePresence();
      jobEvents.off('change', onJob);
      endSSE(res);
    });
  }),
);

// ─── Node management (owner) ─────────────────────────────────────────────────

localComputeRouter.patch(
  '/nodes/:id',
  browserTenant,
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const id = String(req.params['id']);
    const { label, acceptJobs } = (req.body ?? {}) as { label?: unknown; acceptJobs?: unknown };
    let node: ComputeNode | null = null;
    if (typeof label === 'string' && label.trim()) {
      node = await renameNode(id, session.sub, label.trim().slice(0, 80));
      if (!node) { res.status(404).json({ error: 'node not found' }); return; }
    }
    if (typeof acceptJobs === 'boolean') {
      node = await setAcceptJobs(id, session.sub, acceptJobs);
      if (!node) { res.status(404).json({ error: 'node not found' }); return; }
    }
    if (!node) { res.status(400).json({ error: 'nothing to update' }); return; }
    res.json({ ...node, presence: presenceOf(node.id) });
  }),
);

localComputeRouter.delete(
  '/nodes/:id',
  browserTenant,
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const id = String(req.params['id']);
    const sourceNode = await getNode(id);
    const revoked = await revokeNode(id, session.sub);
    if (!revoked) { res.status(404).json({ error: 'node not found' }); return; }
    invalidateComputeCapabilitySource('local-compute', `machine:${id}`);
    // Token revocation is an authoritative source stop. The node's owner was
    // joined before the write, so a browser cannot use this route to emit a
    // disconnect for another person's machine.
    if (sourceNode) await emitLocalDisconnected(sourceNode, new Date().toISOString());
    res.json({ ok: true });
  }),
);

// ─── Handing work to a machine (owner) ───────────────────────────────────────
//
// A machine that shows as CONNECTED and cannot be given anything to do is a
// status light, not a fleet participant. This is the control that makes the
// pull-side loop reachable from the browser instead of only from a script.
//
// Why it lives here rather than on `POST /api/work/jobs`, which can already
// enqueue a `local:*` kind: that route is gated on `ManageDevbox`, which is the
// right gate for spending an initiative's shared microVM capacity and the wrong
// one for spending your own laptop's. The right question for local work is "is
// this your machine", and the capability that means "you may drive a machine of
// your own" is `ConnectLocalCompute` — the same one that pairs it and flips its
// accept-jobs switch. The generic route stays as it is; nothing here widens it.
//
// The gates are the SAME ones the claim would hit, checked at dispatch instead
// of silently later: queueing into a machine that is switched off, or that never
// registered the kind, produces a row nothing will ever claim and no error
// anybody sees. `decideClaim` is not reused wholesale because concurrency is not
// a dispatch-time question — a full machine is exactly what a queue is for.

/** The machine named by `:nodeId` if this session owns it and it is live. */
async function ownedNode(req: Request, res: Response): Promise<ComputeNode | null> {
  const session = resolveSession(req)!;
  const nodeId = String(req.params['nodeId'] ?? '');
  const own = await listNodesByOwner(session.sub);
  const node = own.find((n) => n.id === nodeId);
  if (!node) {
    res.status(404).json({ error: 'node not found' });
    return null;
  }
  return node;
}

/**
 * The one shape of `repo` a machine is handed: a GitHub repository, as
 * `owner/name`, `https://github.com/owner/name[.git]` or
 * `git@github.com:owner/name[.git]`, with owner/name held to the same
 * pattern the GitHub token provider uses (lib/repo-token-provider.ts). A bare
 * `owner/name` is stored as its https URL. Anything else is null: the worker
 * clones this string, and it once reached a shell (docs/next-steps.md
 * section 7, middleware).
 */
export function normaliseRepo(raw: string): string | null {
  // The prefix decides the form; nothing else in the string does (a check for
  // "contains github.com" passed `evil.com/github.com` through verbatim).
  const prefix = ['https://github.com/', 'git@github.com:'].find((p) => raw.startsWith(p)) ?? '';
  const full = raw.slice(prefix.length).replace(/\.git$/, '');
  if (!REPO_FULL_NAME_RE.test(full) || full.split('/').some((seg) => /^\.+$/.test(seg) || seg.startsWith('-'))) return null;
  return prefix ? raw : `https://github.com/${raw}`;
}

localComputeRouter.post(
  '/nodes/:nodeId/work',
  browserTenant,
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const node = await ownedNode(req, res);
    if (!node) return;

    const body = (req.body ?? {}) as {
      title?: unknown; prompt?: unknown; kind?: unknown; repo?: unknown;
      requiresReview?: unknown; priority?: unknown;
      workItemId?: unknown; botId?: unknown; instruction?: unknown;
    };
    let title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    let repo: string | null = null;
    if (typeof body.repo === 'string' && body.repo.trim()) {
      repo = normaliseRepo(body.repo.trim().slice(0, 400));
      if (!repo) {
        res.status(400).json({ error: 'repo must be a GitHub repository: owner/name, https://github.com/owner/name or git@github.com:owner/name' });
        return;
      }
    }
    // What the row remembers about where it came from — the pick list on the
    // Local compute page hands a machine an initiative's work item or a bot's
    // mission, never a typed prompt. Both keep the governed checks their
    // fleet-side routes run: a work item is grant-scoped (an SME may only
    // spend inside an envelope they hold) and a bot needs ManageBots.
    const origin: Record<string, unknown> = {};
    const workItemId = typeof body.workItemId === 'string' ? body.workItemId.trim() : '';
    const botId = typeof body.botId === 'string' ? body.botId.trim() : '';
    if (workItemId) {
      const item = await getWorkItem(workItemId);
      if (!item) { res.status(404).json({ error: 'no such work item' }); return; }
      const verdict = await grantScopedDispatchVerdict(item.projectId, req.session);
      if (verdict.kind === 'deny') { res.status(403).json({ error: verdict.reason }); return; }
      if (verdict.kind === 'unavailable') { res.status(503).json({ error: verdict.reason, gate: 'grant-authorization' }); return; }
      // The codebase that delivers the initiative, if one is registered —
      // the worker clones it with its own credentials. No codebase is not a
      // refusal here: the machine can still be asked, it just has nothing to
      // change, so the run lands in `done` rather than review.
      const pre = await preflightWorkItem(workItemId, undefined, session.role, item);
      if (pre.ok && !repo) {
        const project = await getAgentProject(pre.agentProjectId);
        if (project?.repoFullName) repo = `https://github.com/${project.repoFullName}`;
      }
      title = title || item.title.slice(0, 200);
      prompt = prompt || [item.title, item.description ?? ''].filter(Boolean).join('\n\n');
      origin['workItemId'] = item.id;
      origin['initiativeId'] = item.projectId;
    } else if (botId) {
      const bot = await getBot(botId);
      if (!bot) { res.status(404).json({ error: 'no such bot' }); return; }
      const allowed = await isAllowed({ sub: session.sub, role: session.role, tenant: session.tenant }, 'ManageBots');
      if (!allowed) { res.status(403).json({ error: 'running a bot needs ManageBots' }); return; }
      if (!bot.enabled) { res.status(409).json({ gate: 'bot', error: 'bot is disabled' }); return; }
      if (bot.pausedReason) { res.status(409).json({ gate: 'bot', error: `bot is paused: ${bot.pausedReason}` }); return; }
      if (bot.agentProjectId && !repo) {
        const project = await getAgentProject(bot.agentProjectId);
        if (project?.repoFullName) repo = `https://github.com/${project.repoFullName}`;
      }
      title = title || bot.name.slice(0, 200);
      prompt = prompt || renderPrompt(bot.prompt, typeof body.instruction === 'string' ? body.instruction : undefined);
      origin['botId'] = bot.id;
    }
    if (!prompt) {
      res.status(400).json({ error: 'prompt is required — it is what the machine will be asked to do (or name a workItemId / botId)' });
      return;
    }
    const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'local:task';
    if (!(LOCAL_JOB_KINDS as readonly string[]).includes(kind)) {
      res.status(400).json({ error: `kind must be one of ${LOCAL_JOB_KINDS.join(', ')}` });
      return;
    }

    if (!node.acceptJobs) {
      res.status(409).json({
        gate: 'accept_jobs',
        error: 'this machine is not accepting jobs — switch it on before handing it work',
      });
      return;
    }
    const runnable = allowedKinds(node.jobKinds);
    if (!runnable.includes(kind as typeof runnable[number])) {
      res.status(409).json({
        gate: 'kinds',
        error: runnable.length
          ? `this machine runs ${runnable.join(', ')} — it has not registered for ${kind}`
          : 'this machine has registered no runnable kinds — start its worker so it can announce them',
      });
      return;
    }

    // `repo` is a plain URL the worker clones with ITS OWN git credentials
    // (tools/local-compute-worker.mjs `ensureRepo`). No token travels with the
    // job: a node token that leaked would otherwise become a way to read every
    // private repo the service account can reach.

    const job = await enqueueJob({
      kind,
      title: title || prompt.slice(0, 80),
      payload: {
        prompt,
        // The targeting field. Without it this row is claimable by any paired
        // machine registered for the kind, including someone else's — which
        // would put the prompt text on a stranger's disk.
        nodeId: node.id,
        // Honoured on the local path by the worker, which completes with
        // `awaiting_review` rather than `done` when this is true. Review is
        // for a run that produced something a person can accept or reject —
        // a change in a repo. A run with no repo has no capture to review, so
        // it lands in `done`; a caller that wants a look anyway says so.
        requiresReview: typeof body.requiresReview === 'boolean' ? body.requiresReview : Boolean(repo),
        ...(repo ? { repo } : {}),
        ...origin,
      },
      ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
      createdBy: session.sub,
    });
    if (!job) {
      res.status(503).json({ error: 'queue unavailable (Aurora mocked or unreachable)' });
      return;
    }
    res.status(201).json(job);
  }),
);

/**
 * What this person's machines have been doing.
 *
 * Owner-scoped like the presence reads and for the same reason: a run's prompt,
 * repo and output are a person's work. A fleet-wide role sees that machines
 * exist (`/nodes/all`), not what they were asked to do.
 *
 * Includes the still-queued rows, matched by their targeting `nodeId` — a job
 * has no `box_id` until it is claimed, and work you just handed to a machine
 * being invisible until a worker picks it up is precisely the window someone is
 * standing there watching.
 */
localComputeRouter.get(
  '/runs',
  browserTenant,
  requireSession('ViewLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const own = await listNodesByOwner(session.sub);
    if (own.length === 0) { res.json({ runs: [] }); return; }
    const limitRaw = Number(req.query['limit']);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const runs = await listJobsForBoxes(
      own.map((n) => localBoxId(n.id)),
      { nodeIds: own.map((n) => n.id), limit },
    );
    // The node id each run belongs to, resolved here rather than left for the
    // browser to slice out of a box id — `local:` prefixing is this module's
    // convention and not something a client should have to know.
    const byBox = new Map(own.map((n) => [localBoxId(n.id), n]));
    res.json({
      runs: runs.map((job) => {
        const node = (job.boxId ? byBox.get(job.boxId) : undefined)
          ?? own.find((n) => n.id === job.payload['nodeId']);
        return {
          ...job,
          nodeId: node?.id ?? null,
          nodeLabel: node?.label ?? null,
        };
      }),
    });
  }),
);
