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
//   GET    /api/local-compute/nodes           my machines + live sessions (browser session)
//   GET    /api/local-compute/stream          same, as SSE (browser session)
//   PATCH  /api/local-compute/nodes/:id       rename / accept-jobs toggle (owner)
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
import { initSSE, writeSSE } from '../lib/sse.js';
import { rateLimit } from '../lib/rate-limit.js';
import { requireAction, requireSession, requireTenant, resolveSession } from '../lib/authz.js';
import { FLEET_WIDE_ROLES } from '../lib/devbox-visibility.js';
import {
  createPairingCode,
  claimPairingCode,
  getNodeByToken,
  listNodesByOwner,
  listAllNodes,
  renameNode,
  setAcceptJobs,
  revokeNode,
  touchNode,
  recordNodeCapabilities,
  hasNodeCapabilityColumns,
  type ComputeNode,
} from '../providers/local-compute.js';
import {
  recordAnnounce,
  recordHeartbeat,
  endSession,
  presenceOf,
  subscribePresence,
  localBoxId,
  type LocalSession,
  type NodePresence,
} from '../lib/local-compute-fleet.js';
import {
  getJob,
  hasPullSideColumns,
  claimNextJobForWorker,
  countLiveJobsForBox,
  heartbeatJob,
  markRunning,
  completeJob,
  type AgentJob,
} from '../providers/agent-jobs.js';
import {
  decideClaim,
  allowedKinds,
  capConcurrency,
  LOCAL_JOB_KINDS,
  LOCAL_HEARTBEAT_INTERVAL_S,
} from '../lib/local-work.js';
import { STALE_MINUTES } from '../lib/job-dispatcher.js';
import { parseReportedCost, resolveRunCost } from '../lib/run-cost.js';
import { DEMO_NODE_ID, demoPresenceSessions } from '../mock/local-compute.js';

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
  const announceDemo = () => recordAnnounce(DEMO_NODE_ID, demoPresenceSessions());
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

localComputeRouter.post('/announce', requireNodeToken(async (req, res, node) => {
  const sessions = parseSessions(req.body);
  if (sessions === null) {
    res.status(400).json({ error: `sessions must be an array of ≤${MAX_SESSIONS_PER_ANNOUNCE} session records` });
    return;
  }
  const presence = recordAnnounce(node.id, sessions);
  await touchNode(node.id);
  res.json({ ok: true, nodeId: node.id, sessions: presence.sessions.length });
}));

localComputeRouter.post('/heartbeat', requireNodeToken(async (_req, res, node) => {
  recordHeartbeat(node.id);
  await touchNode(node.id);
  res.json({ ok: true });
}));

localComputeRouter.post('/sessions/:sessionId/end', requireNodeToken(async (req, res, node) => {
  const removed = endSession(node.id, String(req.params['sessionId']));
  await touchNode(node.id);
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

localComputeRouter.post('/claim', workLoopLimit, requireNodeToken(async (_req, res, node) => {
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
    await touchNode(node.id);
    res.status(verdict.status).json({ error: verdict.reason, gate: verdict.gate });
    return;
  }

  // One session id, minted server-side, used for BOTH the queue row and the
  // presence record the worker announces. The worker could invent its own, but
  // then the fleet view would carry two unrelated ids for one piece of work and
  // no way to join them — which is how a running local job showed up as an
  // anonymous session next to a job with an anonymous worker.
  const sessionId = `local-${node.id}-${randomUUID()}`;
  const claim = await claimNextJobForWorker({ boxId, sessionId, kinds: verdict.kinds });
  await touchNode(node.id);

  if (!claim) {
    // Empty queue is not an error, and it is the common case: a worker polls a
    // quiet queue all day. 204 keeps that out of the error logs and out of the
    // worker's error path.
    res.status(204).end();
    return;
  }

  res.json({
    job: claim.job,
    claimToken: claim.claimToken,
    sessionId,
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
  res.json({ ok: true, jobId: held.job.id, status, costUsd: cost.costUsd, provider: cost.provider });
}));

// ─── Presence reads (browser) ────────────────────────────────────────────────

interface NodeView extends ComputeNode {
  presence: NodePresence;
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
    const nodes: NodeView[] = own.map((node) => ({ ...node, presence: presenceOf(node.id) }));
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
    const revoked = await revokeNode(String(req.params['id']), session.sub);
    if (!revoked) { res.status(404).json({ error: 'node not found' }); return; }
    res.json({ ok: true });
  }),
);
