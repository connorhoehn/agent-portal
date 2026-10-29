// Internal HMAC-only devbox router — the computer lab surface for
// platform-api's chat agent loop (`/agent`, LOOP-BRIEF.md §2/§3), mounted at
// `/internal/devbox` BEFORE `sessionMiddleware()` in index.ts, exactly like
// `internal-work-graph-compute.ts`. There is no browser session on this
// path: the only credential is a signed `X-Service-Auth` envelope
// (`@connorhoehn/service-runtime`), verified fresh on every request.
//
//   GET    /internal/devbox/status                resolved runtime ARN + config
//   POST   /internal/devbox/sessions               mint + register a box for a run
//   POST   /internal/devbox/:sessionId/task        Claude Code headless run (SSE)
//   GET    /internal/devbox/boxes/:boxId/tail      replay + live tail (SSE)
//   POST   /internal/devbox/:sessionId/shell-url   presigned/mock terminal URL
//   GET    /internal/devbox/:sessionId/files        workspace file list
//   GET    /internal/devbox/:sessionId/files/:fileId  one file's bytes
//   DELETE /internal/devbox/:sessionId             stop the runtime session
//
// Every route calls the SAME handler code the public `/api/devbox` router
// uses (`runTaskAndForward`, `streamBoxTail`, `mintShellUrl`,
// `respondStopSession`, `buildDevboxStatusPayload`, `requireArn`,
// `mockAgentCore` — all exported from `routes/devbox.ts`) rather than a
// second copy of the same 300 lines. The only thing that differs between the
// two routers is WHO may reach a given box: the public router asks
// `lib/devbox-visibility.ts::canSee` against a browser session; this router
// asks nothing beyond "did platform-api sign this envelope" — it is a
// service-to-service surface, and the HMAC check IS the authorization.
//
// That is also the one rule this router must never violate: it must not
// become a second way for a BROWSER to reach a box's task/shell/tail surface
// without going through `canSee`. Mounting before `sessionMiddleware()`, and
// verifying the envelope on every route with no session-cookie fallback
// anywhere in this file, is what keeps that true — a request carrying only a
// browser session cookie and no valid `X-Service-Auth` header 401s here,
// same as a request carrying nothing at all.
//
// MOCK_AGENTCORE=true swaps `POST /:sessionId/task` to
// `mock/devbox-agent-loop.ts` instead of the real-transport
// `runTaskAndForward` — see that module for why it is not
// `mock/devbox-shell.ts::mockDevboxClient()`. `GET .../tail` needs no
// special-casing for mock mode: it replays whatever the task route appended
// to the box's fleet log, real or mock frames alike.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { asyncHandler } from '../lib/async-handler.js';
import { userStewardsInitiative, userReachesBox } from '../lib/initiative-scope.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { normalizeRuntimeSessionId, RUNTIME_SESSION_ID_MIN_LENGTH } from '../lib/runtime-session.js';
import { registerBox, getBox, getBoxBySession, appendEvent } from '../lib/devbox-fleet.js';
import {
  mockAgentCore,
  requireArn,
  runTaskAndForward,
  streamBoxTail,
  mintShellUrl,
  respondStopSession,
  buildDevboxStatusPayload,
  applyTaskProfile,
} from './devbox.js';
import { profileForInitiative, profileStamp } from '../lib/devbox-profile.js';
import { buildLoopMockFrames, loopMockPaceMs, clearMockWorkspace } from '../mock/devbox-agent-loop.js';
import { randomUUID } from 'node:crypto';
import { parseReportedCost, parseResultUsage, settleRunCost } from '../lib/run-cost.js';
import { estimateUsageCost } from '../lib/model-prices.js';
import { recordSpend } from '../providers/spend-ledger.js';
import {
  isValidFileId,
  listMockFiles,
  readMockFile,
  listRealFiles,
  readRealFile,
} from '../lib/devbox-files.js';

export const internalDevboxRouter = Router();

/** Which caller this router trusts. Overridable for tests/rotation, same
 *  knob `internal-work-graph-compute.ts` uses for its own platform check. */
function allowedServiceId(): string {
  return process.env['WORK_GRAPH_PLATFORM_SERVICE_ID']?.trim() || 'platform-api';
}

function configuredSecret(): string {
  return (process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] ?? process.env['SERVICE_AUTH_SECRET'] ?? '').trim();
}

/**
 * Verify the signed envelope over `payload`. Returns the verified serviceId
 * on success (so a route can cross-check it against the body's own declared
 * `principal.service`), or writes an error response and returns null.
 *
 * Copied from `internal-work-graph-compute.ts::signed()` — same secret pair,
 * same 30s ttl / 5s clock-skew tolerance, same header. This is the ONE check
 * standing between this router and the public internet; every route below
 * calls it before touching anything else.
 */
function verifyServiceAuth(req: Request, res: Response, payload: object): string | null {
  const secret = configuredSecret();
  const header = req.header(SERVICE_AUTH_HEADER);
  if (!secret) {
    res.status(503).json({ error: 'DEVBOX_INTERNAL_UNAVAILABLE' });
    return null;
  }
  if (!header) {
    res.status(401).json({ error: 'SERVICE_AUTH_INVALID' });
    return null;
  }
  const result = verifyEnvelope(header, {
    secret,
    allowedServices: [allowedServiceId()],
    payload,
    ttlSec: 30,
    toleranceSec: 5,
  });
  if (!result.ok) {
    res.status(401).json({ error: 'SERVICE_AUTH_INVALID' });
    return null;
  }
  return result.serviceId;
}

interface Principal { service: string; requestedBy: string }

function isPrincipal(value: unknown): value is Principal {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>)['service'] === 'string'
    && ((value as Record<string, unknown>)['service'] as string).length > 0
    && typeof (value as Record<string, unknown>)['requestedBy'] === 'string'
    && ((value as Record<string, unknown>)['requestedBy'] as string).length > 0;
}

/**
 * Every write on this router carries `{ principal: { service, requestedBy } }`
 * in its body (LOOP-BRIEF.md §3). The envelope already proves WHICH service
 * signed the call; this proves the body agrees with what it signed as, so a
 * caller can never sign as platform-api and then claim a body written for a
 * different declared principal.
 */
function requirePrincipal(req: Request, res: Response, verifiedServiceId: string): Principal | null {
  const body = (req.body ?? {}) as { principal?: unknown };
  if (!isPrincipal(body.principal) || body.principal.service !== verifiedServiceId) {
    res.status(400).json({ error: 'a principal matching the signed service is required' });
    return null;
  }
  return body.principal;
}

function sessionIdParam(req: Request, res: Response): string | null {
  const raw = String(req.params['sessionId'] ?? '');
  if (raw.length < RUNTIME_SESSION_ID_MIN_LENGTH) {
    res.status(400).json({
      error: `sessionId must be ≥ ${RUNTIME_SESSION_ID_MIN_LENGTH} characters (AgentCore Runtime constraint) — mint one via POST /internal/devbox/sessions`,
    });
    return null;
  }
  return raw;
}

// ─── GET /status ──────────────────────────────────────────────────────────

internalDevboxRouter.get('/status', asyncHandler(async (req, res) => {
  if (!verifyServiceAuth(req, res, {})) return;
  res.json(await buildDevboxStatusPayload());
}));

// ─── POST /sessions ───────────────────────────────────────────────────────
// Registers the box up front (ownerId = requestedBy, source = the caller's
// own service id) rather than waiting for the first /task to auto-adopt it —
// so `GET .../tail` and the platform-api run record both have a boxId to
// point at before any task has run.

internalDevboxRouter.post('/sessions', asyncHandler(async (req, res) => {
  const serviceId = verifyServiceAuth(req, res, req.body ?? {});
  if (!serviceId) return;
  const principal = requirePrincipal(req, res, serviceId);
  if (!principal) return;

  const body = (req.body ?? {}) as { label?: string; projectId?: string };
  // The same steward check POST /api/devbox/boxes runs: charging a box to an
  // initiative shares it with everyone on it, so the signature proves which
  // service called, not that the user it acts for may claim this initiative.
  const projectId = String(body.projectId ?? '').trim();
  if (projectId && !await userStewardsInitiative(principal.requestedBy, projectId)) {
    res.status(403).json({
      error: 'the requesting user can only charge a computer to an initiative they own or contribute to',
      projectId,
    });
    return;
  }
  const sessionId = normalizeRuntimeSessionId();
  // The rules the box is created under (DE-40): its initiative's profile,
  // else `default`, stamped so a later edit never changes it mid-task.
  const profile = await profileForInitiative(projectId || null);
  const box = registerBox({
    sessionId,
    ownerId: principal.requestedBy,
    source: principal.service,
    ...(body.label ? { label: body.label } : {}),
    ...(projectId ? { projectId } : {}),
    profile: profileStamp(profile),
  });
  res.status(201).json({ sessionId, boxId: box.id, profile: profileStamp(profile) });
}));

// ─── POST /:sessionId/task ────────────────────────────────────────────────

internalDevboxRouter.post('/:sessionId/task', asyncHandler(async (req, res) => {
  const sessionId = sessionIdParam(req, res);
  if (!sessionId) return;
  const serviceId = verifyServiceAuth(req, res, req.body ?? {});
  if (!serviceId) return;
  const principal = requirePrincipal(req, res, serviceId);
  if (!principal) return;

  const body = (req.body ?? {}) as { prompt?: string; resume?: boolean; timeout?: number; model?: string };
  const prompt = (body.prompt ?? '').trim();
  if (!prompt) { res.status(400).json({ error: 'prompt is required' }); return; }
  const resume = Boolean(body.resume);

  // A box must have been minted by POST /sessions: auto-registering an unknown
  // session made the requesting user its owner, so any live session id could
  // be claimed. And the user the call acts for must reach the box (DE-44 row 24).
  const box = getBoxBySession(sessionId);
  if (!box) { res.status(404).json({ error: 'computer not found — mint one via POST /internal/devbox/sessions' }); return; }
  if (!await userReachesBox(principal.requestedBy, box)) {
    res.status(403).json({ error: 'the requesting user cannot reach that computer' });
    return;
  }

  // The box's profile decides the model and the timeout ceiling (DE-40) on
  // this principal exactly as on the browser one — an unlisted model is a 400
  // here too, before either transport is reached.
  const governed = await applyTaskProfile(box, body, res);
  if (!governed) return;

  if (mockAgentCore()) {
    const frames = buildLoopMockFrames({ sessionId, prompt, resume, model: governed.model });
    initSSE(res);
    const [taskStarted, ...rest] = frames;
    // Mirrors runTaskAndForward's own convention: task_started goes into the
    // fleet log for OTHER tailers, not into this caller's own response body.
    if (taskStarted) appendEvent(box.id, taskStarted);
    const pace = loopMockPaceMs();
    let result: Record<string, unknown> | null = null;
    for (const frame of rest) {
      if (pace > 0) await new Promise<void>((resolve) => { const t = setTimeout(resolve, pace); t.unref?.(); });
      writeSSE(res, frame);
      appendEvent(box.id, frame);
      if ((frame as Record<string, unknown>)['type'] === 'result') result = frame as Record<string, unknown>;
    }
    endSSE(res);
    // Same ledger entry the real path writes in runTaskAndForward (DE-30);
    // the mock result carries usage but no figure, so the mock price table
    // prices it (DE-32) — 'estimated', or 'unknown' when a scenario blanks it.
    const model = governed.model;
    const usage = result ? parseResultUsage(result) : null;
    const settled = settleRunCost(
      result ? parseReportedCost(result) : null,
      usage ? estimateUsageCost(model, usage) : null,
    );
    await recordSpend({
      source: 'agent_loop',
      sourceId: `${box.id}:${randomUUID()}`,
      initiativeId: box.projectId ?? null,
      boxId: box.id,
      actorId: principal.requestedBy,
      model,
      costUsd: settled.costUsd,
      costBasis: settled.costBasis,
      estimatedCostUsd: settled.estimatedCostUsd,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
    });
    return;
  }

  const arn = await requireArn(res);
  if (!arn) return;
  await runTaskAndForward({
    sessionId, prompt, resume, res, arn,
    spend: { source: 'agent_loop', actorId: principal.requestedBy },
    model: governed.model,
    timeout: governed.timeout,
  });
}));

// ─── GET /boxes/:boxId/tail ───────────────────────────────────────────────
// No request body on a GET, so the signed payload is the one thing this
// request actually carries: the boxId itself.

internalDevboxRouter.get('/boxes/:boxId/tail', asyncHandler(async (req, res) => {
  const boxId = String(req.params['boxId'] ?? '');
  if (!verifyServiceAuth(req, res, { boxId })) return;
  const box = getBox(boxId);
  if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
  streamBoxTail(box.id, req, res);
}));

// ─── POST /:sessionId/shell-url ───────────────────────────────────────────

internalDevboxRouter.post('/:sessionId/shell-url', asyncHandler(async (req, res) => {
  const sessionId = sessionIdParam(req, res);
  if (!sessionId) return;
  const serviceId = verifyServiceAuth(req, res, req.body ?? {});
  if (!serviceId) return;
  const principal = requirePrincipal(req, res, serviceId);
  if (!principal) return;

  const box = getBoxBySession(sessionId);
  if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
  // A shell URL is a bearer credential for the box: only for a user who may
  // reach it (DE-44 row 25; the principal used to be parsed and dropped).
  if (!await userReachesBox(principal.requestedBy, box)) {
    res.status(403).json({ error: 'the requesting user cannot reach that computer' });
    return;
  }

  const body = (req.body ?? {}) as { shellId?: string; expiresIn?: number };
  await mintShellUrl(sessionId, body, res);
}));

// ─── GET /:sessionId/files ──────────────────────────────────────────────────
// Workspace file list for the Computer Lab "Files" tab (LOOP-BRIEF.md §7).
// No request body on a GET, so the signed payload is `{ sessionId }`, same
// convention as the tail route's `{ boxId }`. See `lib/devbox-files.ts` for
// why real mode falls back to an exec transport rather than a real file API.

internalDevboxRouter.get('/:sessionId/files', asyncHandler(async (req, res) => {
  const sessionId = sessionIdParam(req, res);
  if (!sessionId) return;
  if (!verifyServiceAuth(req, res, { sessionId })) return;

  if (mockAgentCore()) {
    res.json({ files: listMockFiles(sessionId) });
    return;
  }

  const box = getBoxBySession(sessionId);
  if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
  const arn = await requireArn(res);
  if (!arn) return;
  res.json({ files: await listRealFiles(sessionId, arn) });
}));

// ─── GET /:sessionId/files/:fileId ──────────────────────────────────────────
// One file's bytes. Signed payload `{ sessionId, fileId }` — same shape as
// above plus the id, so a caller cannot replay a signed listing request to
// fetch an arbitrary file's bytes.

internalDevboxRouter.get('/:sessionId/files/:fileId', asyncHandler(async (req, res) => {
  const sessionId = sessionIdParam(req, res);
  if (!sessionId) return;
  const fileId = String(req.params['fileId'] ?? '');
  if (!verifyServiceAuth(req, res, { sessionId, fileId })) return;

  if (!isValidFileId(fileId)) {
    res.status(400).json({ error: 'invalid fileId — path separators and traversal are not allowed' });
    return;
  }

  let file: Awaited<ReturnType<typeof readMockFile>> | Awaited<ReturnType<typeof readRealFile>>;
  if (mockAgentCore()) {
    file = readMockFile(sessionId, fileId);
  } else {
    const box = getBoxBySession(sessionId);
    if (!box) { res.status(404).json({ error: 'computer not found' }); return; }
    const arn = await requireArn(res);
    if (!arn) return;
    file = await readRealFile(sessionId, arn, fileId);
  }
  if (!file) { res.status(404).json({ error: 'file not found' }); return; }

  res.setHeader('Content-Type', file.contentType);
  res.send(file.data);
}));

// ─── DELETE /:sessionId ───────────────────────────────────────────────────

internalDevboxRouter.delete('/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = sessionIdParam(req, res);
  if (!sessionId) return;
  const serviceId = verifyServiceAuth(req, res, req.body ?? {});
  if (!serviceId) return;
  const principal = requirePrincipal(req, res, serviceId);
  if (!principal) return;
  // Stopping ends someone's microVM and wipes its workspace: the same reach
  // check as the task and shell routes (DE-44 row 26).
  const box = getBoxBySession(sessionId);
  if (box && !await userReachesBox(principal.requestedBy, box)) {
    res.status(403).json({ error: 'the requesting user cannot reach that computer' });
    return;
  }

  // Mirrors the real transport stopping the microVM (and its workspace) on
  // session stop — the mock's per-session notes.md temp dir must not
  // outlive the session either.
  if (mockAgentCore()) clearMockWorkspace(sessionId);

  await respondStopSession(sessionId, res);
}));
