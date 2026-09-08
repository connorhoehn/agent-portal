// Local compute — a developer's machine as a fleet participant.
//
//   POST   /api/local-compute/pair/start      mint a pairing code (browser session)
//   POST   /api/local-compute/pair/claim      claim it, receive the node token (machine, no session)
//   POST   /api/local-compute/announce        presence snapshot (machine, node token)
//   POST   /api/local-compute/heartbeat       proof of life (machine, node token)
//   POST   /api/local-compute/sessions/:id/end  a session ended (machine, node token)
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

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { initSSE, writeSSE } from '../lib/sse.js';
import { rateLimit } from '../lib/rate-limit.js';
import { requireAction, requireSession, resolveSession } from '../lib/authz.js';
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
  type ComputeNode,
} from '../providers/local-compute.js';
import {
  recordAnnounce,
  recordHeartbeat,
  endSession,
  presenceOf,
  subscribePresence,
  type LocalSession,
  type NodePresence,
} from '../lib/local-compute-fleet.js';

export const localComputeRouter = Router();

const MAX_SESSIONS_PER_ANNOUNCE = 20;

// Mock-mode demo presence: dev:mock has no laptop announcing, so the seeded
// fixture node (providers/local-compute.ts) announces itself here — one
// session mixing a platform model with a local one, re-announced every
// minute so the derived status stays honestly 'connected' rather than the
// node looking broken ninety seconds after boot. Env-read directly, like
// every flag in devbox.ts, to stay importable under the CJS jest config.
if (process.env['MOCK_AURORA'] === 'true') {
  const announceDemo = () => recordAnnounce('node-demo-macbook', [
    {
      sessionId: 'demo-local-session-0000000000000000000',
      harness: 'claude-code',
      projectId: 'p-realtime',
      repo: 'realtime-platform',
      branch: 'feat/presence-mesh',
      intent: 'wire the presence mesh into the gateway',
      modelProvider: 'ollama',
      model: 'qwen2.5-coder:14b',
      contextUsed: 0.31,
      memory: { mode: 'pending', pendingOps: 7 },
      lastSeenAt: '',
    },
  ]);
  announceDemo();
  setInterval(announceDemo, 60_000).unref();
}

// The claim route is the only unauthenticated one — a pairing code is the
// entire credential — so it gets the same brake as the login picker.
const claimLimit = rateLimit('local-compute-claim', 30, 60_000);

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
  (req: Request, res: Response, next: NextFunction) => {
    const session = resolveSession(req);
    const role = session?.role ?? '';
    if (session && (role === 'admin' || (FLEET_WIDE_ROLES as readonly string[]).includes(role))) {
      next();
      return;
    }
    res.status(403).json({ error: 'Forbidden', action: 'ViewLocalComputeFleet' });
  },
  asyncHandler(async (_req, res) => {
    // Operational visibility for fleet-wide roles: which machines are
    // contributing and how much — never the session detail.
    const nodes = (await listAllNodes()).map(summarize);
    res.json({ nodes });
  }),
);

localComputeRouter.get('/stream', requireSession('ViewLocalCompute'), asyncHandler(async (req, res) => {
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
  requireAction('ConnectLocalCompute'),
  asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const revoked = await revokeNode(String(req.params['id']), session.sub);
    if (!revoked) { res.status(404).json({ error: 'node not found' }); return; }
    res.json({ ok: true });
  }),
);
