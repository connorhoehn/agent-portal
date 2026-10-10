// Who may read which part of the orgiq work graph — decided per request, from
// the reloaded session, with the SAME gates the REST routes serving each entity
// use. Nothing here is a new policy; each line names the route it mirrors.
//
//   graph itself    requireTenant('orgiq')        /api/graph/projects/:id, /api/graph/projects/:id/work
//   bot runs, bots  readForRolesElseAction(['org-leader','hr-admin','program-owner'], 'ManageBots')
//                                                 /api/bots/:id/runs, /api/bots/runs, /api/bots/:id
//   marketplace     readForRolesElseAction(['org-leader','hr-admin'], 'DispatchAgentRun')
//     runs                                        /api/bots/marketplace-runs
//   documents       requireTenant('orgiq')        /api/graph/work-items/:id/documents
//   sprints         requireTenant('orgiq') + requireSession('ViewSprints'); scope=all and the money
//                                                 it carries only at the budgets read tier:
//                   org-leader, hr-admin, program-owner, admin, else ManageBudgets (routes/sprints.ts canReadWide)
//   sprint envelopes  readForRolesElseAction(['org-leader','hr-admin'], 'ManageBudgets')   /api/grants
//   decisions       requireTenant('orgiq')        /api/graph/decisions, /api/graph/projects/:id/decisions
//   flow runs       the requester's own, and the run's conversation read, asked per run in
//                   lib/work-graph/sources.ts (routes/conversation-summarize.ts ownRun)
//   (pipelines tenant — pipelinesWorkGraphViewer below)
//   definitions, runs, steps, decks, own flow runs   requireTenant('pipelines') + ViewPipelines  /api/pipelines/*
//   approvals       ApproveStep                   /api/pipelines/approvals/:id/decide — an author
//                   (ViewPipelines only) is never told an approval exists
//   message/dispatch  DispatchAgentRun            the initiative discussion's write authority
//                                                 (lib/tenant-channels.ts orgiq:initiative)
//
// Default deny: a Cedar evaluation that throws withholds that part and marks
// the source `authorization-unavailable`; it never falls open. The session is
// reloaded through currentLiveSession (epoch, grants, masquerade actor) before
// the reads and again after them, the way routes/work-documents.ts fences.

import { AppError } from '../async-handler.js';
import { isAllowed } from '../authz.js';
import { currentLiveSession, socialActionRole } from '../live-principal.js';
import type { Session } from '../session.js';
import type { ViewerReads } from './projection.js';
import type { PipelinesViewerReads } from './pipelines-projection.js';
import type { AssessmentViewerReads } from './assessment-projection.js';
import type { SocialViewerReads } from './social-projection.js';

const BOT_READ_ROLES = ['org-leader', 'hr-admin', 'program-owner'];
const MARKET_READ_ROLES = ['org-leader', 'hr-admin'];
const SPRINT_WIDE_ROLES = ['org-leader', 'hr-admin', 'program-owner'];
const GRANT_READ_ROLES = ['org-leader', 'hr-admin'];

export interface WorkGraphViewer {
  session: Session;
  reads: ViewerReads;
  /** Gates whose evaluation failed (withheld, reported as authorization-unavailable). */
  unavailable: Array<keyof ViewerReads>;
}

async function decide(session: Session, roles: string[], action: string): Promise<boolean | null> {
  if (session.role === 'admin' || roles.includes(session.role)) return true;
  try {
    return await isAllowed({ sub: session.sub, role: session.role, tenant: session.tenant }, action);
  } catch {
    return null;
  }
}

/** Reload the session and decide each part. Throws 401/403/503 like the routes. */
export async function workGraphViewer(source: Session | undefined): Promise<WorkGraphViewer> {
  if (!source) throw new AppError(401, 'Unauthenticated');
  const session = await currentLiveSession(source);
  if (session.tenant !== 'orgiq' && session.role !== 'admin') throw new AppError(403, 'Choose an OrgIQ workspace to read its activity');
  const [botRuns, marketplaceRuns, dispatch, sprintsWide, grants] = await Promise.all([
    decide(session, BOT_READ_ROLES, 'ManageBots'),
    decide(session, MARKET_READ_ROLES, 'DispatchAgentRun'),
    decide(session, [], 'DispatchAgentRun'),
    decide(session, SPRINT_WIDE_ROLES, 'ManageBudgets'),
    decide(session, GRANT_READ_ROLES, 'ManageBudgets'),
  ]);
  const unavailable: Array<keyof ViewerReads> = [];
  if (botRuns === null) unavailable.push('botRuns');
  if (marketplaceRuns === null) unavailable.push('marketplaceRuns');
  if (dispatch === null) unavailable.push('dispatch');
  if (sprintsWide === null) unavailable.push('sprintsWide');
  if (grants === null) unavailable.push('grants');
  return {
    session,
    reads: {
      botRuns: botRuns === true, marketplaceRuns: marketplaceRuns === true, dispatch: dispatch === true,
      sprintsWide: sprintsWide === true, grants: grants === true,
    },
    unavailable,
  };
}

/** The post-read fence: a grant or epoch change during the reads refuses the answer. */
export async function confirmWorkGraphViewer(viewer: WorkGraphViewer): Promise<void> {
  const session = await currentLiveSession(viewer.session);
  if (session.tenant !== 'orgiq' && session.role !== 'admin') throw new AppError(403, 'Choose an OrgIQ workspace to read its activity');
}

// ── The pipelines tenant ────────────────────────────────────────────────────

export interface PipelinesWorkGraphViewer {
  session: Session;
  reads: PipelinesViewerReads;
  unavailable: Array<keyof PipelinesViewerReads>;
}

/** The pipelines routes' gates: requireTenant('pipelines') (admin crosses), ViewPipelines, ApproveStep. */
export async function pipelinesWorkGraphViewer(source: Session | undefined): Promise<PipelinesWorkGraphViewer> {
  if (!source) throw new AppError(401, 'Unauthenticated');
  const session = await currentLiveSession(source);
  if (session.tenant !== 'pipelines' && session.role !== 'admin') throw new AppError(403, 'Choose a Pipelines workspace to read its activity');
  const [view, approvals] = await Promise.all([decide(session, [], 'ViewPipelines'), decide(session, [], 'ApproveStep')]);
  const unavailable: Array<keyof PipelinesViewerReads> = [];
  if (view === null) unavailable.push('view');
  if (approvals === null) unavailable.push('approvals');
  return { session, reads: { view: view === true, approvals: approvals === true }, unavailable };
}

export async function confirmPipelinesWorkGraphViewer(viewer: PipelinesWorkGraphViewer): Promise<void> {
  const session = await currentLiveSession(viewer.session);
  if (session.tenant !== 'pipelines' && session.role !== 'admin') throw new AppError(403, 'Choose a Pipelines workspace to read its activity');
}

// ── The assessment tenant ───────────────────────────────────────────────────
//
//   teams, dimensions, evidence, drafts, decks, agent runs   requireTenant('assessment') + ViewAssessment
//                   GET /api/assessment/teams*, /decks, /drafts, /runs — every row an assessor reads
//   score           ScoreAssessment   POST /scores/apply, /drafts/:id/accept: marks a node the viewer may act on
//   run             RunAssessmentAgent  POST /runs, /decks, /drafts/*/revise: the viewer's own flow runs, dispatch
// Default deny, as above: a Cedar evaluation that throws withholds that part and marks the source
// `authorization-unavailable`.

export interface AssessmentWorkGraphViewer {
  session: Session;
  reads: AssessmentViewerReads;
  unavailable: Array<keyof AssessmentViewerReads>;
}

export async function assessmentWorkGraphViewer(source: Session | undefined): Promise<AssessmentWorkGraphViewer> {
  if (!source) throw new AppError(401, 'Unauthenticated');
  const session = await currentLiveSession(source);
  if (session.tenant !== 'assessment' && session.role !== 'admin') throw new AppError(403, 'Choose an Assessment workspace to read its activity');
  const [view, score, run] = await Promise.all([
    decide(session, [], 'ViewAssessment'), decide(session, [], 'ScoreAssessment'), decide(session, [], 'RunAssessmentAgent'),
  ]);
  const unavailable: Array<keyof AssessmentViewerReads> = [];
  if (view === null) unavailable.push('view');
  if (score === null) unavailable.push('score');
  if (run === null) unavailable.push('run');
  return { session, reads: { view: view === true, score: score === true, run: run === true }, unavailable };
}

export async function confirmAssessmentWorkGraphViewer(viewer: AssessmentWorkGraphViewer): Promise<void> {
  const session = await currentLiveSession(viewer.session);
  if (session.tenant !== 'assessment' && session.role !== 'admin') throw new AppError(403, 'Choose an Assessment workspace to read its activity');
}

// ── The social tenant ───────────────────────────────────────────────────────
//
//   conversations, threads, calls, recordings, decks, own flow runs   requireTenant('social') + ViewSocial
//                   GET /api/social/{channels,dms,rooms,teams,calls,recordings}, /api/chat/decks, /api/chat/commands/*/runs/:id
//                   — and, for a conversation, the SAME membership authority the chat uses (lib/work-graph/social-sources.ts
//                   conversationReadable: lobbyGuard + the chat service's explicit rows, decided per request)
//   post            PostMessage     marks a conversation/thread the viewer may write in. Never widens what is drawn.
//   call            StartCall       marks a live call the viewer may join. Never widens what is drawn.
// Social actions are decided as the gateway decides them: against the roles the viewer holds in the social tenant
// (live-principal socialActionRole), not the signed session role. Default deny: an evaluation that throws withholds that
// part and marks the source `authorization-unavailable`.

export interface SocialWorkGraphViewer {
  session: Session;
  reads: SocialViewerReads;
  unavailable: Array<keyof SocialViewerReads>;
}

async function decideSocial(session: Session, action: string): Promise<boolean | null> {
  try { return (await socialActionRole(session, action)) !== null; } catch { return null; }
}

export async function socialWorkGraphViewer(source: Session | undefined): Promise<SocialWorkGraphViewer> {
  if (!source) throw new AppError(401, 'Unauthenticated');
  const session = await currentLiveSession(source);
  if (session.tenant !== 'social' && session.role !== 'admin') throw new AppError(403, 'Choose a Social workspace to read its activity');
  const [view, post, call] = await Promise.all([decideSocial(session, 'ViewSocial'), decideSocial(session, 'PostMessage'), decideSocial(session, 'StartCall')]);
  const unavailable: Array<keyof SocialViewerReads> = [];
  if (view === null) unavailable.push('view');
  if (post === null) unavailable.push('post');
  if (call === null) unavailable.push('call');
  return { session, reads: { view: view === true, post: post === true, call: call === true }, unavailable };
}

export async function confirmSocialWorkGraphViewer(viewer: SocialWorkGraphViewer): Promise<void> {
  const session = await currentLiveSession(viewer.session);
  if (session.tenant !== 'social' && session.role !== 'admin') throw new AppError(403, 'Choose a Social workspace to read its activity');
  // A Social grant revoked while the rows were read refuses the answer: it was built on ViewSocial.
  if (viewer.reads.view && await decideSocial(session, 'ViewSocial') === false) throw new AppError(403, 'Your Social grants do not allow this action');
}
