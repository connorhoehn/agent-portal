// The lab loop — how a computer-lab agent reaches outside its session.
//
//   POST /api/lab/signals          agent: file an issue → agent_findings
//   POST /api/lab/experiences      agent: record a learning
//   GET  /api/lab/experiences      agent OR human: recall learnings
//   POST /api/lab/consults         agent: ask a human, get an id to poll
//   GET  /api/lab/consults/:id     agent OR human: poll for the answer
//   GET  /api/lab/consults         human: list (Work page "Needs you")
//   POST /api/lab/consults/:id/answer  human: answer (DispatchAgentRun)
//
// The agent-facing routes are sessionless BY DESIGN — a headless `claude -p`
// run inside a microVM has no cookie (same contract as approvals/request and
// harness/trace, per the auth-floor gotcha: gate machine callbacks per-route,
// never with a blanket session mount). Each carries a rate limit and the
// optional-service-auth brake: open when LAB_CALLBACK_SECRET is unset (dev),
// constant-time x-lab-auth header check when set.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireSession, requireTenant } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { fileLabSignal } from '../providers/org-sweeps.js';
import {
  recordExperience, listExperiences, EXPERIENCE_KINDS, type ExperienceKind,
  openConsult, getConsult, listConsults, answerConsult,
} from '../providers/lab.js';
import { requireServiceAuth, LAB_CALLBACK_SERVICE_AUTH } from '../lib/service-auth.js';
import { notifyPipelinesWorkGraphChanged } from '../lib/work-graph/live.js';
import { runRefFromRequest, runTokenMatches } from '../lib/run-token.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';

export const labRouter = Router();

const callbackLimit = rateLimit('lab-callback', 120, 60_000);

// One implementation of the compare, in lib/service-auth.ts — a timing-safe
// comparison copied per route is a security primitive with a fresh chance to be
// subtly wrong in each copy, and copies inherit no test written against the
// shared one. Same contract as before: open when LAB_CALLBACK_SECRET is unset,
// constant-time when it is set.
const requireLabAuth = requireServiceAuth(LAB_CALLBACK_SERVICE_AUTH);

/** The lab is a Work (orgiq) surface: a session from another tenant reads none of it. */
const orgiqOnly = requireTenant('orgiq');

/** Session OR service header — for reads both the portal and the fleet make. */
function sessionOrLabAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session) { orgiqOnly(req, res, next); return; }
  requireLabAuth(req, res, next);
}

/**
 * Where a box's callback is filed (DE-44 row 28). Every box holds the same
 * LAB_CALLBACK_SECRET, so the envelope proves "a box of the fleet" and nothing
 * about which initiative it works for: a body-supplied initiativeId let any
 * box file under any initiative. A dispatched run sends its run token; the
 * initiative and repo then come from that run's frozen brief. No token (an
 * ad-hoc shell) files unattributed; a token that does not verify is refused.
 * Answers the refusal itself; null means stop.
 */
async function runAttribution(req: Request, res: Response, body: Record<string, unknown>):
  Promise<{ initiativeId?: string; repo?: string } | null> {
  const runRef = await runRefFromRequest(req);
  if (runRef === 'invalid') { res.status(403).json({ error: 'the run token does not verify' }); return null; }
  // A body that names a run must name the token's run (sweep 4 M1): the
  // microVM broker stamps its own run_ref on every /api/lab POST, and a box
  // that sends another job's run_ref beside its own token is refused, never
  // filed under either run.
  const bodyRunRef = str(body['run_ref']);
  if (runRef !== 'none' && bodyRunRef !== undefined && !(await runTokenMatches(req, bodyRunRef))) {
    res.status(403).json({ error: 'the run token is not for the run_ref this callback names', code: 'RUN_REF_MISMATCH' });
    return null;
  }
  if (runRef === 'none') return str(body['repo']) !== undefined ? { repo: str(body['repo'])! } : {};
  const { runbookStore } = await import('../lib/runbooks/store-select.js');
  const brief = await runbookStore().getBrief(runRef).catch(() => null);
  const repo = brief?.repo ?? str(body['repo']);
  return {
    ...(brief?.initiative_id ? { initiativeId: brief.initiative_id } : {}),
    ...(repo !== undefined && repo !== null ? { repo } : {}),
  };
}

const SEVERITIES = new Set(['critical', 'warning', 'info']);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

// ── Signals ─────────────────────────────────────────────────────────────────

labRouter.post('/signals', callbackLimit, requireLabAuth, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = str(body['title']);
  if (!title) throw new ValidationError('`title` is required');
  const severity = str(body['severity']) ?? 'info';
  if (!SEVERITIES.has(severity)) throw new ValidationError('`severity` must be critical | warning | info');
  // No caller fingerprint → derive one from what identifies the issue, so a
  // retried hook updates its own finding instead of stacking duplicates.
  const fingerprint = str(body['fingerprint'])
    ?? createHash('sha256').update(`${title}|${str(body['repo']) ?? ''}`).digest('hex').slice(0, 24);

  const opt = (v: string | undefined) => (v !== undefined ? v : undefined);
  const filed = await runAttribution(req, res, body);
  if (!filed) return;
  const finding = await fileLabSignal({
    severity: severity as 'critical' | 'warning' | 'info',
    title,
    fingerprint,
    ...(opt(str(body['detail'])) !== undefined ? { detail: str(body['detail'])! } : {}),
    ...(opt(str(body['sessionId'])) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(opt(str(body['boxId'])) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...filed,
  });
  res.status(201).json({ finding });
}));

// ── Experiences ─────────────────────────────────────────────────────────────

labRouter.post('/experiences', callbackLimit, requireLabAuth, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = str(body['title']);
  if (!title) throw new ValidationError('`title` is required');
  const kind = str(body['kind']) ?? 'gotcha';
  if (!(EXPERIENCE_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`\`kind\` must be one of ${EXPERIENCE_KINDS.join(' | ')}`);
  }
  const tags = Array.isArray(body['tags'])
    ? (body['tags'] as unknown[]).filter((t): t is string => typeof t === 'string').slice(0, 12)
    : [];
  const filed = await runAttribution(req, res, body);
  if (!filed) return;
  const experience = await recordExperience({
    kind: kind as ExperienceKind,
    title,
    tags,
    ...(str(body['body']) !== undefined ? { body: str(body['body'])! } : {}),
    ...(str(body['sessionId']) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(str(body['boxId']) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...filed,
  });
  res.status(201).json({ experience });
}));

// The recall read. A new lab session fetches this for its repo before
// starting work — the loop that makes an experience worth recording.
labRouter.get('/experiences', sessionOrLabAuth, asyncHandler(async (req, res) => {
  const experiences = await listExperiences({
    ...(str(req.query['repo']) !== undefined ? { repo: str(req.query['repo'])! } : {}),
    ...(str(req.query['initiative']) !== undefined ? { initiativeId: str(req.query['initiative'])! } : {}),
    ...(req.query['limit'] ? { limit: parseInt(String(req.query['limit']), 10) || 30 } : {}),
  });
  res.json({ experiences });
}));

// ── Consults ────────────────────────────────────────────────────────────────

labRouter.post('/consults', callbackLimit, requireLabAuth, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const question = str(body['question']);
  if (!question) throw new ValidationError('`question` is required');
  const filed = await runAttribution(req, res, body);
  if (!filed) return;
  const consult = await openConsult({
    question,
    ...(str(body['context']) !== undefined ? { context: str(body['context'])! } : {}),
    ...(str(body['sessionId']) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(str(body['boxId']) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...filed,
  });
  // A pending consult is an approval waiting on a person (pipelines activity graph, content-free hint).
  void notifyPipelinesWorkGraphChanged(null, 'approval');
  res.status(201).json({ consult });
}));

// Human list FIRST so '/consults' doesn't fall into the ':id' matcher.
labRouter.get('/consults', requireSession('LabConsults'), orgiqOnly, asyncHandler(async (req, res) => {
  const consults = await listConsults({
    ...(str(req.query['status']) !== undefined ? { status: str(req.query['status'])! } : {}),
  });
  res.json({ consults });
}));

// The agent's poll. Sessionless: knowing the id IS the capability, exactly as
// approvals' GET /:id — the id is minted server-side and returned only to the
// caller that opened the consult.
// `sessionOrLabAuth`, not bare `callbackLimit`. This route is sessionless by
// design — a headless run polls it for its answer — but sessionless was
// implemented as *unauthenticated*, which is not the same thing and is not what
// the contract at the top of this file says. It carried the rate limit and not
// the service-auth brake, so with LAB_CALLBACK_SECRET set (the posture that
// makes every sibling here safe) an anonymous caller could still read any
// consult by id: the question, the repo and initiative it came from, and once
// answered, the answer and the name of the human who gave it. Verified live —
// its sibling `GET /consults` 401s while this returned 200 with the full row.
// Session OR service header keeps both real callers working (the fleet polling,
// the portal rendering a detail) and closes the third one.
labRouter.get('/consults/:id', callbackLimit, sessionOrLabAuth, asyncHandler(async (req, res) => {
  const consult = await getConsult(String(req.params['id']));
  if (!consult) { res.status(404).json({ error: 'consult not found' }); return; }
  res.json({ consult });
}));

// Answering directs a running agent — the same authority that dispatches one.
labRouter.post('/consults/:id/answer', orgiqOnly, requireAction('DispatchAgentRun'), asyncHandler(async (req, res) => {
  const answer = str((req.body ?? {})['answer']);
  if (!answer) throw new ValidationError('`answer` is required');
  const who = req.session?.sub ?? 'unknown';
  // An answer steers a running agent: only for someone on its initiative (DE-44 row 29).
  const pending = await getConsult(String(req.params['id']));
  if (pending && !await requireInitiativeScope(req, res, pending.initiativeId ?? null, { action: 'answer consults' })) return;
  const consult = await answerConsult(String(req.params['id']), answer, who);
  if (!consult) { res.status(409).json({ error: 'consult is not pending (answered, expired, or unknown)' }); return; }
  void notifyPipelinesWorkGraphChanged(null, 'approval');
  res.json({ consult });
}));
