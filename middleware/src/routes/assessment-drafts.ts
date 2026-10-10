// Assessment evidence summary and follow-up drafts (docs/agentic-flows-migration.md
// slice 8) — mounted inside assessmentRouter (behind requireTenant('assessment'))
// at /api/assessment. Drafts are durable flow runs shared by every assessor the
// read gate admits (readers see them read-only); nothing reaches the team until
// an editor accepts a follow-up draft. Any editor may revise, accept or discard.
//
//   POST /teams/:id/dimensions/:dim/drafts/evidence-summary  RunAssessmentAgent  202 { runId }
//   POST /teams/:id/dimensions/:dim/drafts/followups         RunAssessmentAgent  202 { runId }
//   GET  /teams/:id/dimensions/:dim/drafts                   ViewAssessment      the dimension's recent drafts (shared)
//   GET  /drafts/:runId                                      ViewAssessment      one draft
//   POST /drafts/:runId/revise {instruction,baseRevision,requestId}  RunAssessmentAgent  202; 409 when someone revised first
//   POST /drafts/:runId/accept     {indices?}                ScoreAssessment     creates the follow-up rows
//   POST /drafts/:runId/discard                              RunAssessmentAgent  marks the draft discarded
//
// No new Cedar action. Accepting writes through provider.addFollowUps, the
// same OPEN row shape and de-duplication as an agent's scored questions, and
// takes the text from the STORED draft: the request only picks among its rows.

import { Router } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import {
  FOLLOWUPS_KIND, MAX_ACTIVE_DRAFTS_PER_USER, SUMMARY_KIND, activeDraftCount, buildSource, claimDecision, draftView,
  getDraft, listDrafts, recordCreated, releaseDecision, reviseDraft, startDraft, type DraftKind, type FollowupsDraft,
} from '../lib/assessment-drafts.js';
import { pendingFlowRuns } from '../lib/flow-runs/index.js';
import { DIMENSION_IDS } from '../mock/assessment.js';
import { addFollowUps, isValidTeamId } from '../providers/assessment.js';

export const assessmentDraftsRouter: Router = Router();

/** Settles when every started draft has finished (tests await it; routes never do). */
export const pendingDrafts = pendingFlowRuns;

const viewGate = requireAction('ViewAssessment');
const scoreGate = requireAction('ScoreAssessment');
const runGate = requireAction('RunAssessmentAgent');

function target(req: { params: Record<string, unknown> }): { teamId: string; dimensionId: string } {
  const teamId = String(req.params['id'] ?? '');
  const dimensionId = String(req.params['dim'] ?? '');
  if (!isValidTeamId(teamId)) throw new ValidationError('team id must match ^TEAM-[A-Za-z0-9-]+$');
  if (!DIMENSION_IDS.includes(dimensionId)) throw new NotFoundError(`dimension ${dimensionId} not found`);
  return { teamId, dimensionId };
}

const userOf = (req: { session?: { sub?: string } }): string => {
  const sub = req.session?.sub;
  if (!sub) throw new AppError(401, 'Sign in to draft');
  return sub;
};

function runId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^adr-[0-9a-f-]{36}$/.test(raw)) throw new NotFoundError('draft not found');
  return raw;
}

function start(kind: DraftKind) {
  return asyncHandler(async (req, res) => {
    const { teamId, dimensionId } = target(req);
    const userId = userOf(req);
    if (await activeDraftCount(userId) >= MAX_ACTIVE_DRAFTS_PER_USER) throw new AppError(429, 'Wait for your running drafts to finish');
    const source = await buildSource(teamId, dimensionId);
    if (!source) throw new NotFoundError(`team ${teamId} not found`);
    const run = await startDraft({ kind, userId, teamId, dimensionId, source });
    res.status(202).json({ runId: run.id });
  });
}

assessmentDraftsRouter.post('/teams/:id/dimensions/:dim/drafts/evidence-summary', runGate, start(SUMMARY_KIND));
assessmentDraftsRouter.post('/teams/:id/dimensions/:dim/drafts/followups', runGate, start(FOLLOWUPS_KIND));

assessmentDraftsRouter.get('/teams/:id/dimensions/:dim/drafts', viewGate, asyncHandler(async (req, res) => {
  const { teamId, dimensionId } = target(req);
  userOf(req);
  const runs = await listDrafts(teamId, dimensionId);
  res.json({ drafts: runs.map(draftView) });
}));

assessmentDraftsRouter.get('/drafts/:runId', viewGate, asyncHandler(async (req, res) => {
  userOf(req);
  const run = await getDraft(runId(req.params['runId']));
  if (!run) throw new NotFoundError('draft not found');
  res.json(draftView(run));
}));

assessmentDraftsRouter.post('/drafts/:runId/accept', scoreGate, asyncHandler(async (req, res) => {
  userOf(req);
  const run = await getDraft(runId(req.params['runId']));
  if (!run) throw new NotFoundError('draft not found');
  const view = draftView(run);
  if (req.body?.baseRevision !== undefined && req.body.baseRevision !== view.revision) throw new AppError(409, 'Someone revised this draft. Review the newer version.');
  if (view.kind !== FOLLOWUPS_KIND) throw new AppError(409, 'Only follow-up drafts can be accepted');
  if (view.phase !== 'completed' || !view.result) throw new AppError(409, 'The draft is not finished');
  if (view.decision) throw new AppError(409, `This draft was already ${view.decision}`);
  const questions = (view.result as FollowupsDraft).questions;
  const raw = req.body?.indices;
  let picked = questions.map((_, i) => i);
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.some(i => !Number.isInteger(i) || i < 0 || i >= questions.length)) throw new ValidationError('indices must pick drafted questions');
    picked = [...new Set(raw as number[])].sort((a, b) => a - b);
  }
  if (picked.length === 0) throw new ValidationError('Pick at least one question');
  // Claim first so the store's CAS decides Accept vs Discard: exactly one wins and the loser
  // creates nothing. The write is de-duplicated by text; if it fails, the claim is released.
  if (!await claimDecision(run, 'accepted')) throw new AppError(409, 'Someone decided this draft first. Review the newer version.');
  let out: Awaited<ReturnType<typeof addFollowUps>>;
  try { out = await addFollowUps(view.teamId, view.dimensionId, picked.map(i => questions[i]!.text)); } catch (err) {
    await releaseDecision(run, 'accepted'); throw err;
  }
  if (!out) { await releaseDecision(run, 'accepted'); throw new NotFoundError('team or dimension not found'); }
  await recordCreated(run, out.created.map(q => q.question_id));
  res.json({ created: out.created, skipped: out.skipped });
}));

assessmentDraftsRouter.post('/drafts/:runId/discard', runGate, asyncHandler(async (req, res) => {
  userOf(req);
  const run = await getDraft(runId(req.params['runId']));
  if (!run) throw new NotFoundError('draft not found');
  const view = draftView(run);
  if (view.phase === 'received' || view.phase === 'running') throw new AppError(409, 'The draft is still running');
  if (!await claimDecision(run, 'discarded')) throw new AppError(409, view.decision ? `This draft was already ${view.decision}` : 'Someone decided this draft first. Review the newer version.');
  res.json({ ok: true });
}));

assessmentDraftsRouter.post('/drafts/:runId/revise', runGate, asyncHandler(async (req, res) => {
  const userId = userOf(req);
  const run = await getDraft(runId(req.params['runId']));
  if (!run) throw new NotFoundError('draft not found');
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim() : '';
  if (!instruction || instruction.length > 500) throw new ValidationError('instruction must be 1-500 characters');
  const base = req.body?.baseRevision;
  if (!Number.isInteger(base) || base < 1) throw new ValidationError('baseRevision must name the revision you are revising');
  const requestId = req.body?.requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(requestId)) throw new ValidationError('requestId must be 8-64 letters, digits or dashes');
  const view = draftView(run);
  if (view.phase === 'received' || view.phase === 'running') {
    // A response-lost retry of our own queued revision is not a conflict.
    const again = run.meta['reviseId'] === `${userId}|${requestId}` && view.revision === base + 1;
    if (again) { res.status(202).json({ runId: run.id, revision: view.revision }); return; }
  }
  const source = await buildSource(view.teamId, view.dimensionId);
  if (!source) throw new NotFoundError(`team ${view.teamId} not found`);
  const out = await reviseDraft(run, { userId, requestId, baseRevision: base as number, instruction, source });
  if (!out.ok) {
    throw new AppError(409, out.reason === 'stale' ? 'Someone revised this draft first. Review the newer version.' : 'This draft cannot be revised right now.');
  }
  res.status(202).json({ runId: run.id, revision: out.revision });
}));
