// The lab loop — how a computer-lab agent reaches outside its session.
//
//   POST /api/lab/signals          agent: file an issue → agent_findings
//   POST /api/lab/experiences      agent: record a learning
//   GET  /api/lab/experiences      agent OR human: recall learnings
//   POST /api/lab/consults         agent: ask a human, get an id to poll
//   GET  /api/lab/consults/:id     agent: poll for the answer (sessionless)
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
import { createHash, timingSafeEqual } from 'node:crypto';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireSession } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { fileLabSignal } from '../providers/org-sweeps.js';
import {
  recordExperience, listExperiences, EXPERIENCE_KINDS, type ExperienceKind,
  openConsult, getConsult, listConsults, answerConsult,
} from '../providers/lab.js';

export const labRouter = Router();

const callbackLimit = rateLimit('lab-callback', 120, 60_000);

function requireLabAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env['LAB_CALLBACK_SECRET'];
  if (!secret) { next(); return; }
  const got = req.headers['x-lab-auth'];
  const presented = typeof got === 'string' ? got : '';
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  if (a.length === b.length && timingSafeEqual(a, b)) { next(); return; }
  res.status(401).json({ error: 'service authentication required' });
}

/** Session OR service header — for reads both the portal and the fleet make. */
function sessionOrLabAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session) { next(); return; }
  requireLabAuth(req, res, next);
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
  const finding = await fileLabSignal({
    severity: severity as 'critical' | 'warning' | 'info',
    title,
    fingerprint,
    ...(opt(str(body['detail'])) !== undefined ? { detail: str(body['detail'])! } : {}),
    ...(opt(str(body['sessionId'])) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(opt(str(body['boxId'])) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...(opt(str(body['repo'])) !== undefined ? { repo: str(body['repo'])! } : {}),
    ...(opt(str(body['initiativeId'])) !== undefined ? { initiativeId: str(body['initiativeId'])! } : {}),
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
  const experience = await recordExperience({
    kind: kind as ExperienceKind,
    title,
    tags,
    ...(str(body['body']) !== undefined ? { body: str(body['body'])! } : {}),
    ...(str(body['sessionId']) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(str(body['boxId']) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...(str(body['repo']) !== undefined ? { repo: str(body['repo'])! } : {}),
    ...(str(body['initiativeId']) !== undefined ? { initiativeId: str(body['initiativeId'])! } : {}),
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
  const consult = await openConsult({
    question,
    ...(str(body['context']) !== undefined ? { context: str(body['context'])! } : {}),
    ...(str(body['sessionId']) !== undefined ? { sessionId: str(body['sessionId'])! } : {}),
    ...(str(body['boxId']) !== undefined ? { boxId: str(body['boxId'])! } : {}),
    ...(str(body['repo']) !== undefined ? { repo: str(body['repo'])! } : {}),
    ...(str(body['initiativeId']) !== undefined ? { initiativeId: str(body['initiativeId'])! } : {}),
  });
  res.status(201).json({ consult });
}));

// Human list FIRST so '/consults' doesn't fall into the ':id' matcher.
labRouter.get('/consults', requireSession('LabConsults'), asyncHandler(async (req, res) => {
  const consults = await listConsults({
    ...(str(req.query['status']) !== undefined ? { status: str(req.query['status'])! } : {}),
  });
  res.json({ consults });
}));

// The agent's poll. Sessionless: knowing the id IS the capability, exactly as
// approvals' GET /:id — the id is minted server-side and returned only to the
// caller that opened the consult.
labRouter.get('/consults/:id', callbackLimit, asyncHandler(async (req, res) => {
  const consult = await getConsult(String(req.params['id']));
  if (!consult) { res.status(404).json({ error: 'consult not found' }); return; }
  res.json({ consult });
}));

// Answering directs a running agent — the same authority that dispatches one.
labRouter.post('/consults/:id/answer', requireAction('DispatchAgentRun'), asyncHandler(async (req, res) => {
  const answer = str((req.body ?? {})['answer']);
  if (!answer) throw new ValidationError('`answer` is required');
  const who = req.session?.sub ?? 'unknown';
  const consult = await answerConsult(String(req.params['id']), answer, who);
  if (!consult) { res.status(409).json({ error: 'consult is not pending (answered, expired, or unknown)' }); return; }
  res.json({ consult });
}));
