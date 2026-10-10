// `/agent <goal>` on a conversation (docs/agentic-flows-migration.md slice 10).
// Two mounts of one handler set, like /summarize and /diagram:
//
//   Social channels, teams and DMs   /api/chat/commands/agent/...
//   tenant discussions and huddles   /api/conversations/agent/...
//
//   POST /run               {channel, text}  202 {runId, pipelineId, card}   plan the goal
//   GET  /runs/:id          the requester's own run (stage, plan, per-step progress)
//   POST /runs/:id/approve  202: runs the plan's steps in order (once only)
//   POST /runs/:id/discard  the plan is dropped (once only; nothing ran)
//
//   GET  /waiting?channel=  the loops paused at an `approval` step in a conversation the caller may read
//   POST /runs/:id/approval/approve   {requestId?}          resume from the next step as the APPROVER (once only)
//   POST /runs/:id/approval/reject    {requestId?, reason?} end the loop with the reason (once only)
//
// An approval step pauses the loop durably (lib/agent-loop). Who may decide: the requester (with the
// posting right), and another member only where the tenant's second-approver rule names an action they
// hold (SECOND_APPROVER_ACTION, the same split as the deck Save rules: Social decks are owner-only, the
// rest follow their run gate). Everyone else who can read the conversation sees the question read-only
// (role `reader`); anyone else, or another tenant, gets 404. Every decision re-reads the decider's
// authority (`currentLiveSession`) and an Approve is re-proven by the executor before the next step.
//
// The posting right is required from the start: Social chatAccess PostMessage, or the
// conversation's chat `publish` authority (a huddle's PostMessage). Readers get 403
// at /run. Authority is asked fresh on every request. A run is its requester's alone:
// unknown and foreign ids are one 404. Each step then starts an EXISTING flow through
// that flow's own start function as the requester's freshly reloaded session
// (lib/agent-loop `executePhase`), so its tenant guard and 403/404/429 are unchanged.

import { randomUUID } from 'node:crypto';
import { Router, type Request, type RequestHandler } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import {
  AUTH_CODE, MAX_ACTIVE_RUNS_PER_USER, approvalView, agentStage, agentStatus, defineAgentFlow, setStepDispatcher, type AgentFlow, type AgentResult, type StepCreated, type StepStart,
} from '../lib/agent-loop/index.js';
import { parseAgentArgs, type AgentTenant, type PlanStep } from '../lib/agent-loop/plan.js';
import { CONVERSATION_AGENT_KINDS, flowRunStore, pendingFlowRuns, type FlowRunRow } from '../lib/flow-runs/index.js';
import { currentLiveSession } from '../lib/live-principal.js';
import { isAllowed } from '../lib/authz.js';
import { getUser } from '../providers/identity.js';
import type { TranscriptLine } from '../lib/conversation-summarize.js';
import type { Session } from '../lib/session.js';
import { chatAccess, readChatLines } from './chat-pins.js';
import { assertChat, beginConversationSummarize, conversationLines, conversationTenant, sessionOf } from './conversation-summarize.js';
import { beginSocialSummarize } from './social-summarize.js';
import { beginSocialArtifact, beginTenantArtifact } from './conversation-artifact.js';
import { beginSocialDeck } from './social-deck.js';
import { createDocumentStep, createMeetingStep } from './agent-loop-create.js';

export const pendingAgentRuns = pendingFlowRuns;
export const AGENT_PIPELINE_ID = 'conversation-agent';

const SOCIAL_PREFIX = 'sag';
const SOCIAL_FLOW: AgentFlow = defineAgentFlow({ tenant: 'social', kind: 'social.agent', idPrefix: SOCIAL_PREFIX, agentAuth: false });
const TENANT_FLOWS: Readonly<Record<string, AgentFlow>> = Object.fromEntries(Object.entries(CONVERSATION_AGENT_KINDS)
  .map(([idPrefix, { tenant, kind }]) => [idPrefix, defineAgentFlow({ tenant, kind, idPrefix, agentAuth: true })]));
const tenantFlow = (tenant: Exclude<AgentTenant, 'social'>): AgentFlow => Object.values(TENANT_FLOWS).find(f => f.spec.tenant === tenant)!;

// ─── Steps: the existing flows, started as the requester ────────────────────

/** A request carrying only the freshly reloaded session: what the flows' start functions read from `req`. */
const stepRequest = (session: Session): Request =>
  ({ method: 'POST', session, headers: {}, get: () => undefined }) as unknown as Request;

/** A topic the existing commands accept: no `#` page tokens and no `--` flags. */
const topicOf = (step: PlanStep): string => (step.instruction || step.title).replace(/#|--/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 190);

setStepDispatcher(async (session, tenant, channel, step): Promise<StepStart | StepCreated> => {
  const req = stepRequest(session);
  const social = tenant === 'social';
  switch (step.kind) {
    case 'summarize':
      return { kind: 'summary', runId: (social ? await beginSocialSummarize(req, channel, '') : await beginConversationSummarize(session, channel, '')).id };
    case 'diagram':
      return { kind: 'diagram', runId: (await (social ? beginSocialArtifact : beginTenantArtifact)(req, 'diagram', channel, topicOf(step))).id };
    case 'doc':
    case 'draft':
      return { kind: 'doc', runId: (await (social ? beginSocialArtifact : beginTenantArtifact)(req, 'doc', channel, step.kind === 'draft' ? `Draft: ${topicOf(step)}`.slice(0, 200) : topicOf(step))).id };
    case 'deck':
      // Only Social has /deck. A preview stores nothing: the card offers Save.
      if (!social) throw new AppError(400, 'Decks are not available in this conversation');
      return { kind: 'deck', runId: (await beginSocialDeck(req, channel, `${topicOf(step)} --preview`)).id };
    case 'document:create':
      return createDocumentStep(req, session, tenant, channel, step);
    case 'meeting:create':
      return createMeetingStep(req, session, tenant, channel, step);
    default:
      throw new AppError(400, `Unknown step kind ${String(step.kind)}`);
  }
});

// ─── Authority ──────────────────────────────────────────────────────────────

/** Who may decide a paused loop besides its requester: an action they must hold. Social: nobody (owner-only, like its decks). */
export const SECOND_APPROVER_ACTION: Readonly<Record<string, string | null>> = {
  social: null, orgiq: 'DispatchAgentRun', assessment: 'RunAssessmentAgent', pipelines: 'RunPipeline',
};

export type ApprovalRole = 'requester' | 'approver' | 'reader';

interface Authority {
  /** The paused loops of a conversation the caller may read, each with what the caller may do about it. */
  waiting(req: Request, channel: string): Promise<Array<{ run: FlowRunRow; role: ApprovalRole }>>;
  /** One run for an approval decision or read: requester, eligible second approver or reader; anyone else 404. */
  approvalAccess(req: Request): Promise<{ run: FlowRunRow; flow: AgentFlow; role: ApprovalRole }>;
  /** The caller's identity as the decision records it. */
  session(req: Request): Session;
  begin(req: Request, channel: string): Promise<{ userId: string; flow: AgentFlow; read(): Promise<TranscriptLine[]>; recheck(): Promise<void> }>;
  own(req: Request, kind: 'subscribe' | 'publish'): Promise<{ run: FlowRunRow; flow: AgentFlow }>;
}

const idOf = (req: Request): string => {
  const id = req.params['id'];
  if (typeof id !== 'string') throw new NotFoundError('run not found');
  return id;
};

const asNotFound = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 403 || error.status === 404)) throw new NotFoundError('run not found');
    throw error;
  }
};

const socialAuthority: Authority = {
  session: sessionOf,
  async waiting(req, channel) {
    const userId = await chatAccess(req, channel, 'ViewSocial');
    const runs = await flowRunStore.listWaiting('social', SOCIAL_FLOW.spec.kind, channel);
    const mayPost = await chatAccess(req, channel, 'PostMessage').then(() => true, () => false);
    return runs.map(run => ({ run, role: run.requestedBy === userId ? (mayPost ? 'requester' : 'reader') : 'reader' }));
  },
  async approvalAccess(req) {
    const id = idOf(req);
    if (!new RegExp(`^${SOCIAL_PREFIX}-[0-9a-f-]{36}$`).test(id)) throw new NotFoundError('run not found');
    const run = await SOCIAL_FLOW.findRun(id);
    if (!run) throw new NotFoundError('run not found');
    const userId = await asNotFound(() => chatAccess(req, run.scope, 'ViewSocial'));
    const mayPost = await chatAccess(req, run.scope, 'PostMessage').then(() => true, () => false);
    return { run, flow: SOCIAL_FLOW, role: run.requestedBy === userId && mayPost ? 'requester' : 'reader' };
  },
  async begin(req, channel) {
    const userId = await chatAccess(req, channel, 'PostMessage');
    return { userId, flow: SOCIAL_FLOW, read: () => readChatLines(channel, userId, null), recheck: async () => { await chatAccess(req, channel, 'PostMessage'); } };
  },
  async own(req, kind) {
    const id = idOf(req);
    if (!new RegExp(`^${SOCIAL_PREFIX}-[0-9a-f-]{36}$`).test(id)) throw new NotFoundError('run not found');
    const any = await SOCIAL_FLOW.findRun(id);
    if (!any) throw new NotFoundError('run not found');
    const userId = await chatAccess(req, any.scope, kind === 'publish' ? 'PostMessage' : 'ViewSocial');
    const run = await SOCIAL_FLOW.getRunFor(userId, id);
    if (!run) throw new NotFoundError('run not found');
    return { run, flow: SOCIAL_FLOW };
  },
};

/** requester (with the posting right) > approver (the tenant's second-approver action AND the posting right) > reader. */
async function tenantRole(session: Session, run: FlowRunRow, mayPost: boolean): Promise<ApprovalRole> {
  if (!mayPost) return 'reader';
  if (run.requestedBy === session.sub) return 'requester';
  const action = SECOND_APPROVER_ACTION[run.tenant];
  return action && session.tenant === run.tenant && await isAllowed(session, action) ? 'approver' : 'reader';
}

const RUN_ID = /^([a-z]{3})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const tenantAuthority: Authority = {
  session: sessionOf,
  async waiting(req, channel) {
    const session = sessionOf(req);
    const flow = tenantFlow(conversationTenant(channel) as Exclude<AgentTenant, 'social'>);
    await assertChat(session, channel, 'subscribe');
    const runs = await flowRunStore.listWaiting(flow.spec.tenant, flow.spec.kind, channel);
    const mayPost = await assertChat(session, channel, 'publish').then(() => true, () => false);
    return Promise.all(runs.map(async run => ({ run, role: await tenantRole(session, run, mayPost) })));
  },
  async approvalAccess(req) {
    const id = idOf(req);
    const flow = TENANT_FLOWS[id.match(RUN_ID)?.[1] ?? ''];
    if (!flow) throw new NotFoundError('run not found');
    const session = sessionOf(req);
    const run = await flow.findRun(id);
    // Another tenant's session never reaches the run, and a person who cannot read the conversation cannot tell it exists.
    if (!run || session.tenant !== run.tenant) throw new NotFoundError('run not found');
    await asNotFound(() => assertChat(session, run.scope, 'subscribe'));
    const mayPost = await assertChat(session, run.scope, 'publish').then(() => true, () => false);
    return { run, flow, role: await tenantRole(session, run, mayPost) };
  },
  async begin(req, channel) {
    const session = sessionOf(req);
    const flow = tenantFlow(conversationTenant(channel) as Exclude<AgentTenant, 'social'>);
    await assertChat(session, channel, 'subscribe');
    await assertChat(session, channel, 'publish');
    return {
      userId: session.sub, flow, read: () => conversationLines(session, channel, null),
      recheck: async () => { await assertChat(session, channel, 'subscribe'); await assertChat(session, channel, 'publish'); },
    };
  },
  async own(req, kind) {
    const id = idOf(req);
    const flow = TENANT_FLOWS[id.match(RUN_ID)?.[1] ?? ''];
    if (!flow) throw new NotFoundError('run not found');
    const session = sessionOf(req);
    const run = await flow.getRunFor(session.sub, id);
    if (!run || run.kind !== flow.spec.kind) throw new NotFoundError('run not found');
    await assertChat(session, run.scope, kind);
    return { run, flow };
  },
};

// ─── Handlers (registered with literal paths below, like the artifact routes) ─

const runHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const channel = typeof req.body?.channel === 'string' ? req.body.channel.trim() : '';
  if (!channel || channel.length > 300) throw new ValidationError('channel is required');
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const args = parseAgentArgs(text);
  if (!args.ok) throw new ValidationError(args.error);
  const access = await authority.begin(req, channel);
  if (await access.flow.activeRunCount(access.userId) >= MAX_ACTIVE_RUNS_PER_USER) throw new AppError(429, 'Wait for your running requests to finish');
  const lines = await access.read();
  await access.recheck();
  const run = await access.flow.startRun({ userId: access.userId, channel, goal: args.goal, lines });
  res.status(202).json({
    runId: run.id, pipelineId: AGENT_PIPELINE_ID,
    card: { kind: 'agent-run', command: '/agent', instruction: `/agent ${args.goal}`, agentName: 'Nova' },
  });
});

const statusHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run } = await authority.own(req, 'subscribe');
  res.set('Cache-Control', 'no-store').json(agentStatus(run));
});

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const approveHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run, flow } = await authority.own(req, 'publish');
  const rid = req.body?.requestId;
  if (rid !== undefined && (typeof rid !== 'string' || !REQUEST_ID.test(rid))) throw new ValidationError('requestId is invalid');
  // Idempotent: the same requestId answers the same 202 and never starts a second loop.
  if (rid && run.meta['rev'] != null && run.meta['reviseId'] === rid) { res.status(202).json({ runId: run.id, stage: agentStage(run) }); return; }
  if (agentStage(run) !== 'awaiting-approval') throw new AppError(409, 'This plan is not waiting for approval');
  const out = await flow.approve(run, sessionOf(req), rid);
  if (!out) {
    const again = await flow.findRun(run.id);
    if (rid && again?.meta['reviseId'] === rid) { res.status(202).json({ runId: run.id, stage: 'running' }); return; }
    throw new AppError(409, 'This plan was already decided');
  }
  res.status(202).json({ runId: run.id, stage: 'running' });
});

const discardHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const { run, flow } = await authority.own(req, 'subscribe');
  const stage = agentStage(run);
  if (stage !== 'awaiting-approval' && stage !== 'running') throw new AppError(409, 'This plan is not waiting for approval');
  if (!await flow.discard(run)) throw new AppError(409, 'This plan was already decided');
  res.json({ runId: run.id, stage: 'discarded' });
});

// ─── Approval steps ─────────────────────────────────────────────────────────

const clipReason = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '');

/** The wire view of a paused loop. Readers and approvers get the question and the step titles, never the goal's source text. */
async function waitingView(run: FlowRunRow, role: ApprovalRole): Promise<Record<string, unknown>> {
  const result = run.result as AgentResult | null;
  const asked = result?.waiting;
  const who = await getUser(run.requestedBy).then(u => u?.displayName ?? run.requestedBy, () => run.requestedBy);
  return {
    runId: run.id, channel: run.scope, role, mine: role === 'requester', requestedBy: who,
    summary: result?.plan.summary ?? '', steps: run.progress.map(({ id, label, status }) => ({ id, label, status })),
    approval: asked ? approvalView(run, asked) : null,
  };
}

const waitingHandler = (authority: Authority): RequestHandler => asyncHandler(async (req, res) => {
  const channel = typeof req.query['channel'] === 'string' ? req.query['channel'].trim() : '';
  if (!channel || channel.length > 300) throw new ValidationError('channel is required');
  const rows = await authority.waiting(req, channel);
  res.set('Cache-Control', 'no-store').json({ runs: await Promise.all(rows.map(({ run, role }) => waitingView(run, role))) });
});

const approvalHandler = (authority: Authority, verb: 'approve' | 'reject'): RequestHandler => asyncHandler(async (req, res) => {
  const session = authority.session(req);
  const rid = req.body?.requestId ?? `ap-${randomUUID()}`;
  if (typeof rid !== 'string' || !REQUEST_ID.test(rid)) throw new ValidationError('requestId is invalid');
  // The decider's access is read again from the directory BEFORE anything about the run is revealed: a moved
  // epoch or a lost grant fails closed (the same 403 text a stopped loop carries), nothing resumes.
  try { await currentLiveSession(session); } catch (error) {
    if (error instanceof AppError && (error.status === 401 || error.status === 503)) {
      throw new AppError(403, `${AUTH_CODE}: ${error.status === 503 ? 'the identity store is unavailable' : 'your access changed'}, so the loop was not continued. Start /agent again.`);
    }
    throw error;
  }
  const { run, flow, role } = await authority.approvalAccess(req);
  if (role === 'reader') throw new AppError(403, 'Only the person who started this loop, or an approver for this conversation, can decide it');
  if (run.meta['apprReq'] === rid) { res.status(202).json({ runId: run.id, stage: 'running' }); return; }
  if (agentStage(run) !== 'waiting-approval') throw new AppError(409, 'This loop is not waiting for an approval');
  const reason = clipReason(req.body?.reason);
  const out = await flow.decideApproval(run, session, { verb, requestId: rid, ...(reason ? { reason } : {}) });
  if (!out) throw new AppError(409, 'This approval was already decided');
  res.status(202).json({ runId: run.id, stage: 'running' });
});

/** /api/chat/commands: Social conversations. */
export const socialAgentRouter = Router();
socialAgentRouter.post('/agent/run', runHandler(socialAuthority));
socialAgentRouter.get('/agent/runs/:id', statusHandler(socialAuthority));
socialAgentRouter.post('/agent/runs/:id/approve', approveHandler(socialAuthority));
socialAgentRouter.post('/agent/runs/:id/discard', discardHandler(socialAuthority));
socialAgentRouter.get('/agent/waiting', waitingHandler(socialAuthority));
socialAgentRouter.post('/agent/runs/:id/approval/approve', approvalHandler(socialAuthority, 'approve'));
socialAgentRouter.post('/agent/runs/:id/approval/reject', approvalHandler(socialAuthority, 'reject'));

/** /api/conversations: tenant discussions and huddles. */
export const conversationAgentRouter = Router();
conversationAgentRouter.post('/agent/run', runHandler(tenantAuthority));
conversationAgentRouter.get('/agent/runs/:id', statusHandler(tenantAuthority));
conversationAgentRouter.post('/agent/runs/:id/approve', approveHandler(tenantAuthority));
conversationAgentRouter.post('/agent/runs/:id/discard', discardHandler(tenantAuthority));
conversationAgentRouter.get('/agent/waiting', waitingHandler(tenantAuthority));
conversationAgentRouter.post('/agent/runs/:id/approval/approve', approvalHandler(tenantAuthority, 'approve'));
conversationAgentRouter.post('/agent/runs/:id/approval/reject', approvalHandler(tenantAuthority, 'reject'));
