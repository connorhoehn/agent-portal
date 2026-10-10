// The durable `/agent` run (docs/agentic-flows-migration.md slice 10), one kind
// per tenant (`<tenant>.agent`) on lib/flow-runs. One row, two phases:
//
//   plan     the run reads what the requester may read of ONE conversation, asks
//            the planner (plan.ts), and COMPLETES holding the plan. Nothing else
//            happens: the requester reviews the plan card.
//   execute  Approve re-queues the SAME row (flowRunStore.requeueRevision: a
//            once-only compare-and-set on a completed, undecided run) and the
//            approving node runs the steps in order. Each step starts one flow
//            that already exists (summarize, deck, diagram, doc; `draft` is a
//            private page draft; `note` runs nothing) through the route's own
//            start function, as the requester's FRESH session, so every tenant
//            guard and 403/404/429 is that flow's own. A failed step stops the loop.
//
// Durable: Approve stores the approver's IDENTITY (sub, tenant, role, epoch, iat; never grants or a
// cookie) in the re-queued row's input and raises max_attempts, and every step's status/child ref is
// the row's progress, i.e. the cursor. If the node dies the lease lapses, another node re-claims the
// run, re-proves the requester through `currentLiveSession` (a moved epoch or lost grant fails the run
// closed with `authorization-unavailable`) and continues from the first unfinished step; a step whose
// child run is already recorded is followed, never started again. Discard after Approve is a
// once-only `decision` the executor reads at each step boundary.
//
// `document:create` and `meeting:create` start no child run: the dispatcher makes the document or
// room (or records the huddle lobby) and the step completes holding its `link`. A crash between the
// create and that report fails the step visibly rather than creating twice.
//
// `approval` steps (human-in-the-loop, the parity matrix's remaining item): the planner may place one
// before a consequential step. Reaching it PAUSES the run durably: status `waiting-approval`, the cursor
// on that step (the row's progress), the lease released, so a restart neither re-runs earlier steps nor
// holds a node. A decision (routes/agent-loop.ts) is a once-only compare-and-set that re-queues the same
// row with the verdict and, for Approve, the approver's identity; the executor then re-proves that
// approver through `currentLiveSession` and continues from the next step as them. Reject (or 24 h with no
// decision, expired by the dispatcher) ends the loop with the reason on the card. Reference:
// realtime-examples' pipeline `approval` node (question, approvals ledger, timeout that rejects).
//
// Out of scope here: devbox/cloud-box steps.

import { randomUUID } from 'node:crypto';
import { AppError } from '../async-handler.js';
import { currentLiveSession } from '../live-principal.js';
import type { Session } from '../session.js';
import {
  APPROVAL_TTL_MS, flowRunStore, isWaitingApproval, kickFlowRun, registerFlowExecutor,
  type FlowExecutionContext, type FlowRunRow, type FlowRunStep,
} from '../flow-runs/index.js';
import { MAX_ACTIVE_RUNS_PER_USER, RUN_TTL_MS, type TranscriptLine } from '../conversation-summarize.js';
import { requestPlan, type AgentPlan, type AgentTenant, type PlanStep } from './plan.js';

export { MAX_ACTIVE_RUNS_PER_USER, RUN_TTL_MS };

export interface StepStart { kind: 'summary' | 'deck' | 'diagram' | 'doc'; runId: string }
/** A creation step (`document:create`, `meeting:create`) starts no child run: it made one thing and links it. */
export interface StepCreated { kind: 'created'; link: NonNullable<FlowRunStep['link']>; detail: string }
/** Starts the flow behind one step under `session` (already fresh). Throws the flow's own AppError on refusal. */
export type StepDispatcher = (session: Session, tenant: AgentTenant, channel: string, step: PlanStep) => Promise<StepStart | StepCreated>;

let dispatcher: StepDispatcher | null = null;
export const setStepDispatcher = (fn: StepDispatcher | null): void => { dispatcher = fn; };

export const STEP_TIMEOUT_MS = 180_000;
const POLL_MS = 120;
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export interface AgentResult {
  plan: AgentPlan;
  /** Set once the approved loop has ended. */
  executed?: boolean;
  /** Zero-based index of the step that stopped the loop. */
  stoppedAt?: number;
  error?: string;
  /** Why the loop failed closed (`authorization-unavailable`). */
  errorCode?: string;
  /** Discard after Approve: the loop stopped at a step boundary. */
  cancelled?: boolean;
  /** Set while the run is paused at an `approval` step. */
  waiting?: { stepIndex: number; question: string };
  /** The loop ended at an approval step that was rejected, or that nobody decided in time. */
  rejected?: boolean;
  expired?: boolean;
}

export type ApprovalVerb = 'approve' | 'reject' | 'expire';
/** The decision a resumed run carries in its input (written only by the once-only resume CAS). */
export interface ApprovalVerdict { verb: ApprovalVerb; stepIndex?: number; by?: string; reason?: string }
const readVerdict = (input: Record<string, unknown> | null): ApprovalVerdict | null => {
  const a = input?.['approval'] as Partial<ApprovalVerdict> | undefined;
  return a && (a.verb === 'approve' || a.verb === 'reject' || a.verb === 'expire') ? a as ApprovalVerdict : null;
};
export const approvalQuestion = (step: PlanStep): string => clip(step.instruction || step.title, 200);

const PLAN_STEPS: FlowRunStep[] = [
  { id: 'read-history', label: 'Read the conversation', status: 'completed' },
  { id: 'plan', label: 'Plan the steps (Nova)', status: 'pending' },
  { id: 'check', label: 'Check the plan against the available flows', status: 'pending' },
];
const withStatus = (steps: readonly FlowRunStep[], id: string, status: FlowRunStep['status']): FlowRunStep[] =>
  steps.map(s => (s.id === id ? { ...s, status } : s));
const planSteps = (plan: AgentPlan): FlowRunStep[] =>
  plan.steps.map((s, i) => ({ id: `s${i + 1}`, label: s.title, status: 'pending' as const, detail: s.acceptance }));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Who approved, as the durable row holds it: identity only, never grants or a cookie. */
export interface StoredActor { sub: string; tenant: Session['tenant']; role: Session['role']; epoch: number; iat: number; act?: { sub: string; epoch: number } }
export const actorOf = (s: Session): StoredActor => ({
  sub: s.sub, tenant: s.tenant, role: s.role, epoch: s.epoch ?? 0, iat: s.iat,
  ...(s.act ? { act: { sub: s.act.sub, epoch: s.act.epoch ?? 0 } } : {}),
});
/** The session a resumed loop STARTS from; `currentLiveSession` then re-reads grants and refuses a moved epoch. */
const sessionOfActor = (a: StoredActor): Session => ({
  sub: a.sub, tenant: a.tenant, role: a.role, epoch: a.epoch, iat: a.iat, grants: {},
  ...(a.act ? { act: { sub: a.act.sub, epoch: a.act.epoch, role: 'admin', tenant: 'orgiq', grants: {} } } : {}),
}) as Session;
const readActor = (input: Record<string, unknown> | null): StoredActor | null => {
  const a = input?.['actor'] as Partial<StoredActor> | undefined;
  return a && typeof a.sub === 'string' && typeof a.tenant === 'string' && typeof a.role === 'string'
    && typeof a.epoch === 'number' && typeof a.iat === 'number' ? a as StoredActor : null;
};

/** A loop that outlives its node is re-claimed this many times at most (each claim is one attempt). */
export const EXECUTE_MAX_ATTEMPTS = 5;
export const AUTH_CODE = 'authorization-unavailable';

async function waitForChild(runId: string): Promise<FlowRunRow | null> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await flowRunStore.get(runId);
    if (!row) return null;
    if (row.status === 'completed' || row.status === 'failed') return row;
    await sleep(POLL_MS);
  }
  return null;
}

async function executePhase(ctx: FlowExecutionContext, spec: AgentFlowSpec): Promise<{ result: AgentResult; progress: FlowRunStep[]; pause?: 'approval' }> {
  const { run } = ctx;
  const plan = (run.result as AgentResult | null)?.plan;
  if (!plan) throw new Error('The plan is missing.');
  // The cursor is the row's own progress: a re-claimed run continues from the first unfinished step.
  const stored = run.progress;
  let steps = stored.length === plan.steps.length && stored.every((s, i) => s.id === `s${i + 1}`) ? [...stored] : planSteps(plan);
  const done = (result: Partial<AgentResult>): { result: AgentResult; progress: FlowRunStep[] } => ({ result: { plan, executed: true, ...result }, progress: steps });
  const stop = (index: number, reason: string, extra: Partial<AgentResult> = {}) => {
    steps = steps.map((s, i) => (i === index ? { ...s, status: 'failed' as const, detail: reason } : s));
    return done({ stoppedAt: index, error: `Step ${index + 1} stopped the loop: ${reason}`, ...extra });
  };
  const denied = (index: number, error: unknown) => {
    const why = error instanceof AppError && error.status === 503 ? 'the identity store is unavailable' : 'your access changed';
    return stop(index, `${AUTH_CODE} (403): ${why}, so the loop stopped before running another step. Start /agent again.`, { errorCode: AUTH_CODE });
  };
  const actor = readActor(run.input);
  const verdict = readVerdict(run.input);
  const first = Math.max(0, steps.findIndex(s => s.status !== 'completed'));
  if (!actor || !dispatcher) return stop(first, `${AUTH_CODE} (403): the approval record is missing. Start /agent again.`, { errorCode: AUTH_CODE });
  const base = sessionOfActor(actor);
  // A re-claimed run proves the requester again BEFORE it waits on or starts anything.
  // An Approve verdict does too: the approver's access may have moved since they pressed the button.
  if (run.attempts > 1 || verdict?.verb === 'approve') {
    try { await currentLiveSession(base); } catch (error) { return denied(first, error); }
  }
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    if (steps[i]!.status === 'completed') continue;
    // Discard after Approve lands here: it takes effect at the next step boundary.
    const current = await flowRunStore.get(run.id);
    if (current?.meta['decision'] === 'discarded') return done({ cancelled: true, stoppedAt: i });
    if (step.kind === 'approval') {
      const question = approvalQuestion(step);
      const decided = verdict && (verdict.verb === 'expire' || verdict.stepIndex === i) ? verdict : null;
      if (!decided) {
        // Reached the gate: pause here. The cursor is this step; nothing earlier can run again.
        steps = steps.map((s, j) => (j === i ? { ...s, status: 'running' as const, detail: question } : s));
        return { result: { plan, waiting: { stepIndex: i, question } } satisfies AgentResult, progress: steps, pause: 'approval' as const };
      }
      const who = decided.by ? ` by ${decided.by}` : '';
      if (decided.verb === 'approve') {
        steps = steps.map((s, j) => (j === i ? { ...s, status: 'completed' as const, detail: clip(`${question} Approved${who}.`, 200) } : s));
        if (!await ctx.report(steps)) return done({ stoppedAt: i, error: 'The run lost its lease.' });
        continue;
      }
      const reason = decided.verb === 'expire'
        ? 'nobody answered within 24 hours, so the loop ended'
        : decided.reason ? `rejected${who}: ${decided.reason}` : `rejected${who}`;
      return stop(i, reason, decided.verb === 'expire' ? { expired: true } : { rejected: true });
    }
    const priorRef = steps[i]!.ref;
    if (steps[i]!.status === 'running' && !priorRef && step.kind !== 'note') {
      return stop(i, 'The server restarted while this step was starting, so it may already have started. Check its card; nothing was started again.');
    }
    steps = steps.map((s, j) => (j === i ? { ...s, status: 'running' as const } : s));
    if (!await ctx.report(steps)) return done({ stoppedAt: i, error: 'The run lost its lease.' });
    if (step.kind === 'note') {
      steps = steps.map((s, j) => (j === i ? { ...s, status: 'completed' as const, detail: step.instruction || step.title } : s));
      await ctx.report(steps);
      continue;
    }
    let childId: string;
    if (priorRef) childId = priorRef.runId; // resumed mid-step: follow the child, never start a second
    else {
      let start: StepStart | StepCreated;
      try {
        // Fresh authority per step: a revoked grant or bumped epoch ends the loop here, and the
        // flow's own start function then asks its tenant guard (Social: grant + membership).
        const fresh = await currentLiveSession(base);
        start = await dispatcher(fresh, spec.tenant, run.scope, step);
      } catch (error) {
        if (error instanceof AppError && error.status === 401) return denied(i, error);
        return stop(i, error instanceof AppError ? `${error.status} ${error.message}` : error instanceof Error ? error.message : 'The step could not start.');
      }
      if (start.kind === 'created') {
        const made = start;
        steps = steps.map((s, j) => (j === i ? { ...s, status: 'completed' as const, detail: clip(made.detail, 200), link: made.link } : s));
        if (!await ctx.report(steps)) return done({ stoppedAt: i, error: 'The run lost its lease.' });
        continue;
      }
      childId = start.runId;
      steps = steps.map((s, j) => (j === i ? { ...s, ref: { kind: start.kind, runId: start.runId } } : s));
      if (!await ctx.report(steps)) return done({ stoppedAt: i, error: 'The run lost its lease.' });
    }
    const child = await waitForChild(childId);
    if (!child) return stop(i, 'The step did not finish in time.');
    if (child.status === 'failed') return stop(i, child.error ?? 'The step failed.');
    const summary = (child.result as { summary?: unknown } | null)?.summary;
    steps = steps.map((s, j) => (j === i ? { ...s, status: 'completed' as const, ...(typeof summary === 'string' && summary ? { detail: clip(summary, 200) } : {}) } : s));
    if (!await ctx.report(steps)) return done({ stoppedAt: i, error: 'The run lost its lease.' });
  }
  return done({});
}

// ─── Wire status ────────────────────────────────────────────────────────────

export type AgentStage = 'planning' | 'awaiting-approval' | 'waiting-approval' | 'running' | 'done' | 'stopped' | 'discarded' | 'failed';
const PHASE: Record<FlowRunRow['status'], 'received' | 'running' | 'completed' | 'failed'> = { queued: 'received', running: 'running', 'waiting-approval': 'running', completed: 'completed', failed: 'failed' };

export function agentStage(run: FlowRunRow): AgentStage {
  const result = run.result as AgentResult | null;
  if (run.status === 'failed') return 'failed';
  // Paused at an approval step (the plan itself was approved earlier): a different decision than 'awaiting-approval'.
  if (isWaitingApproval(run)) return 'waiting-approval';
  if (run.meta['decision'] === 'discarded' && !(result?.executed && !result.cancelled)) return 'discarded';
  if (run.meta['approvedAt'] != null || run.meta['rev'] != null) {
    if (run.status !== 'completed') return 'running';
    return result?.stoppedAt != null ? 'stopped' : 'done';
  }
  return run.status === 'completed' ? 'awaiting-approval' : 'planning';
}

/** What a paused run asks and when the pause lapses (the card shows both; the dispatcher enforces the latter). */
export function approvalView(run: FlowRunRow, waiting: NonNullable<AgentResult['waiting']>): { stepId: string; question: string; since: string; expiresAt: string } {
  const since = typeof run.meta['waitingSince'] === 'string' ? run.meta['waitingSince'] : run.updatedAt;
  return { stepId: `s${waiting.stepIndex + 1}`, question: waiting.question, since, expiresAt: new Date(Date.parse(since) + APPROVAL_TTL_MS).toISOString() };
}

/** The wire status both `/agent` routers answer. */
export function agentStatus(run: FlowRunRow): Record<string, unknown> {
  const result = run.result as AgentResult | null;
  const stage = agentStage(run);
  return {
    runId: run.id, channel: run.scope, stage,
    // The run card's phase: a stopped loop reads as failed with its reason.
    phase: stage === 'stopped' ? 'failed' : stage === 'waiting-approval' ? 'running' : PHASE[run.status],
    steps: run.progress, plan: result?.plan ?? null,
    error: run.error ?? (stage === 'stopped' ? result?.error ?? null : null),
    errorCode: result?.errorCode ?? null, updatedAt: run.updatedAt,
    approval: stage === 'waiting-approval' && result?.waiting ? approvalView(run, result.waiting) : null,
  };
}

// ─── The flow ───────────────────────────────────────────────────────────────

export interface AgentFlowSpec {
  tenant: AgentTenant;
  kind: string;
  /** The run id prefix; lib/flow-runs/channel.ts maps it to the tenant's private push channel. */
  idPrefix: string;
  agentAuth: boolean;
}

export interface AgentFlow {
  spec: AgentFlowSpec;
  getRunFor(userId: string, id: string): Promise<FlowRunRow | null>;
  findRun(id: string): Promise<FlowRunRow | null>;
  activeRunCount(userId: string): Promise<number>;
  startRun(input: { userId: string; channel: string; goal: string; lines: readonly TranscriptLine[] }): Promise<FlowRunRow>;
  /** Once-only: re-queues a completed, undecided plan for execution. `repeat` for the same requestId; false when already decided or not ready. */
  approve(run: FlowRunRow, session: Session, requestId?: string): Promise<'started' | 'repeat' | false>;
  /**
   * Once-only decision on a loop paused at an approval step. `started`: this call decided it; `repeat`: the same
   * requestId already did; false: someone else decided first, or it is not waiting. Approve stores the approver's
   * identity (the loop continues as them); Reject carries the reason onto the card.
   */
  decideApproval(run: FlowRunRow, session: Session, input: { verb: 'approve' | 'reject'; requestId: string; reason?: string }): Promise<'started' | 'repeat' | false>;
  /** Once-only: a ready plan, or a running loop (at its next step boundary), is discarded. False when already decided or over. */
  discard(run: FlowRunRow): Promise<boolean>;
}

export function defineAgentFlow(spec: AgentFlowSpec): AgentFlow {
  registerFlowExecutor(spec.kind, async (ctx) => {
    const { run } = ctx;
    if (run.input?.['phase'] === 'execute') return executePhase(ctx, spec);
    const lines = (Array.isArray(run.input?.['lines']) ? run.input!['lines'] : []) as TranscriptLine[];
    const goal = typeof run.input?.['goal'] === 'string' ? run.input['goal'] as string : '';
    let steps = withStatus(run.progress.length ? run.progress : PLAN_STEPS, 'plan', 'running');
    await ctx.report(steps);
    const plan = await requestPlan({ tenant: spec.tenant, channel: run.scope, sub: run.requestedBy, runId: run.id, goal, lines, agentAuth: spec.agentAuth });
    steps = withStatus(withStatus(steps, 'plan', 'completed'), 'check', 'completed');
    await ctx.report(steps);
    // The plan's own steps replace the planning steps: they are what the card shows and what execution marks.
    return { result: { plan } satisfies AgentResult, progress: planSteps(plan) };
  });
  return {
    spec,
    getRunFor: (userId, id) => flowRunStore.getFor(spec.tenant, userId, id),
    async findRun(id) {
      const run = await flowRunStore.get(id);
      return run && run.tenant === spec.tenant && run.kind === spec.kind ? run : null;
    },
    activeRunCount: userId => flowRunStore.countActive(spec.tenant, spec.kind, userId),
    async startRun(input) {
      await flowRunStore.prune(spec.kind, RUN_TTL_MS);
      const run = await flowRunStore.create({
        tenant: spec.tenant, kind: spec.kind, requestedBy: input.userId, scope: input.channel, idPrefix: spec.idPrefix,
        maxAttempts: 1, progress: PLAN_STEPS, input: { goal: input.goal, lines: input.lines },
      });
      kickFlowRun(run.id, spec.kind);
      return run;
    },
    async approve(run, session, requestId = randomUUID()) {
      if (run.meta['rev'] != null) return run.meta['reviseId'] === requestId ? 'repeat' : false;
      if (run.status !== 'completed' || run.meta['decision'] != null) return false;
      const queued = await flowRunStore.requeueRevision(run.id, 1, requestId, { phase: 'execute', actor: actorOf(session) }, EXECUTE_MAX_ATTEMPTS);
      if (!queued) return false;
      await flowRunStore.setMetaOnce(run.id, run.requestedBy, 'approvedAt', new Date().toISOString());
      kickFlowRun(run.id, spec.kind);
      return 'started';
    },
    async decideApproval(run, session, input) {
      const waiting = (run.result as AgentResult | null)?.waiting;
      if (!isWaitingApproval(run) || !waiting) return run.meta['apprReq'] === input.requestId ? 'repeat' : false;
      const approval: ApprovalVerdict = { verb: input.verb, stepIndex: waiting.stepIndex, by: session.sub, ...(input.reason ? { reason: input.reason } : {}) };
      const queued = await flowRunStore.resumeWaiting(run.id, input.requestId,
        { approval, ...(input.verb === 'approve' ? { actor: actorOf(session) } : {}) }, EXECUTE_MAX_ATTEMPTS);
      if (!queued) {
        const again = await flowRunStore.get(run.id);
        return again?.meta['apprReq'] === input.requestId ? 'repeat' : false;
      }
      kickFlowRun(run.id, spec.kind);
      return 'started';
    },
    async discard(run) {
      const planned = run.status === 'completed' && run.meta['rev'] == null;
      const running = run.meta['rev'] != null && (run.status === 'queued' || run.status === 'running');
      if (!planned && !running) return false;
      return flowRunStore.setMetaOnce(run.id, run.requestedBy, 'decision', 'discarded');
    },
  };
}
