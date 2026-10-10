// /api/pipelines — the pipelines tenant's API (docs/social-tenant-design.md §5,
// docs/pipelines-tenant-goal.md).
//
// Mounted in index.ts as `app.use('/api/pipelines', requireTenant('pipelines'), …)`
// — at the mount, since the tenant has no machine callback of its own. Reads
// are gated on `ViewPipelines`, which every pipelines role holds.
//
// `GET /summary` makes the mount real. The run projection's routes (`/runs`,
// `/runs/:id`, `/runs/:id/steps`, `/runs/:id/events`, `/artifacts`) read
// lib/pipeline-runs.ts over providers/pipeline-runs.ts — every tenant's runs,
// filterable by `contextTenant`. The same handlers serve the context-filtered
// façades (`/api/runs` for orgiq in routes/runs.ts, `/api/assessment/pipeline-runs`
// in routes/assessment.ts) through `runReadHandlers`.
//
// P2 — definitions, runbooks, approvals (rule 1 of design §5.2). The catalog
// is DERIVED from what exists (lib/pipeline-definitions.ts over
// providers/pipeline-definitions.ts): every bot, assessment command, runbook
// candidate and agent is one definition. Gates, per the goal doc's Cedar
// table: reads `ViewPipelines`; recording a definition's approvers
// `AuthorDefinition`; a runbook dry-run `RunPipeline` (it rides the existing
// queue behind dispatch-work's money brakes); an approval decision
// `ApproveStep` (routed to the gate's own decision path — no second approval
// store); cancelling a run `CancelRun`; the tenant configuration
// `ManagePipelineConfig`.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { dispatcherEvents } from '../lib/job-dispatcher.js';
import { subscribe as subscribeBox } from '../lib/devbox-fleet.js';
import {
  filterRuns, runEvents, type ContextTenant, type PipelineEvent, type PipelineEventName, type Run,
} from '../lib/pipeline-runs.js';
import { loadProjection } from '../providers/pipeline-runs.js';
import { pipelineDecksRouter } from './pipeline-decks.js';
import { pipelinesWorkGraphRouter } from './pipelines-work-graph.js';
import { notifyPipelinesWorkGraphChanged } from '../lib/work-graph/live.js';
import { requireAction } from '../lib/authz.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { pipelinesSurfaceCounts, pipelinesSurfaces } from '../mock/pipelines.js';
import {
  APPROVER_ROLE_OPTIONS, effectiveApproverRoles, validApproverRoles, candidateIdOf,
  type Definition, type PipelineRunRecord,
} from '../lib/pipeline-definitions.js';
import {
  loadDefinitions, listRunRecords, recordApproverRoles, startDryRun, listApprovals, decideApproval,
  cancelRun, getPipelinesConfig, setDefaultApproverRole, watchPipelineRuns,
} from '../providers/pipeline-definitions.js';
import { decideDryRunGate } from '../providers/promotions.js';

export const pipelinesRouter = Router();

pipelinesRouter.get('/summary', requireAction('ViewPipelines'), asyncHandler(async (_req, res) => {
  const body: TenantSummary = {
    tenant: 'pipelines',
    members: await tenantMembers('pipelines', ROLES_BY_TENANT.pipelines),
    surfaces: pipelinesSurfaceCounts(pipelinesSurfaces.rows()),
  };
  res.json(body);
}));

// ─── Runs (the projection) ──────────────────────────────────────────────────

/**
 * A live `/api/work/events` frame, renamed into event-catalog. The dispatcher
 * emits `claimed | running | awaiting_review | done | failed` per job; each is
 * the step or run transition below. Nothing else is invented.
 */
const LIVE_JOB_EVENT: Record<string, { type: PipelineEventName; stepId?: string }> = {
  claimed: { type: 'pipeline:step:completed', stepId: 'claim' },
  running: { type: 'pipeline:step:started', stepId: 'execute' },
  awaiting_review: { type: 'pipeline.approval.requested', stepId: 'review' },
  done: { type: 'pipeline:run:completed' },
  failed: { type: 'pipeline:run:failed' },
};

const intParam = (v: unknown, fallback: number, max: number): number => {
  const n = typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
};
const strParam = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * The read handlers, scoped. `contextTenant` set = a façade: only runs whose
 * `context.tenant` matches exist for it (a foreign id is a 404, not a 403 —
 * the façade does not confirm another tenant's ids). Unset = the pipelines
 * tenant's own view, which records every tenant's runs.
 */
export function runReadHandlers(scope: { contextTenant?: ContextTenant } = {}) {
  const visible = (r: Run): boolean => !scope.contextTenant || r.context.tenant === scope.contextTenant;

  async function findRun(req: Request) {
    const id = String(req.params['id'] ?? '');
    const p = await loadProjection();
    const run = p.runs.find((r) => r.id === id && visible(r));
    if (!run) throw new NotFoundError('No run ' + id);
    return { p, run };
  }

  return {
    list: asyncHandler(async (req: Request, res: Response) => {
      const p = await loadProjection();
      const filtered = filterRuns(p.runs.filter(visible), {
        status: strParam(req.query['status']),
        kind: strParam(req.query['kind']),
        contextTenant: scope.contextTenant ?? strParam(req.query['contextTenant']),
        botId: strParam(req.query['botId']),
        definitionId: strParam(req.query['definitionId']),
      });
      const limit = intParam(req.query['limit'], 50, 200) || 50;
      const offset = intParam(req.query['offset'], 0, Number.MAX_SAFE_INTEGER);
      // total is the filtered set before paging — a count, not a page length.
      // `unlinked`: agent traces with no AG-UI run id (P1) — counted, not dropped.
      // A tenant façade counts only its own tenant's unlinked traces (lane E).
      const unlinked = scope.contextTenant ? { invocation_traces: p.unlinkedByTenant?.[scope.contextTenant] ?? 0 } : p.unlinked;
      res.json({ runs: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, unavailable: p.unavailable, unlinked });
    }),
    one: asyncHandler(async (req: Request, res: Response) => {
      const { p, run } = await findRun(req);
      res.json({ run, artifacts: p.artifacts.filter((a) => a.runId === run.id) });
    }),
    steps: asyncHandler(async (req: Request, res: Response) => {
      const { p, run } = await findRun(req);
      res.json({ runId: run.id, steps: p.steps.get(run.id) ?? [] });
    }),
    artifacts: asyncHandler(async (req: Request, res: Response) => {
      const p = await loadProjection();
      const runsById = new Map(p.runs.filter(visible).map((r) => [r.id, r]));
      const kind = strParam(req.query['kind']);
      const rows = p.artifacts
        // An artifact no run owns has no tenant context; only the unscoped view shows it.
        .filter((a) => (a.runId ? runsById.has(a.runId) : !scope.contextTenant))
        .filter((a) => !kind || a.kind === kind)
        .map((a) => ({ ...a, runStatus: a.runId ? runsById.get(a.runId)?.status ?? null : null, contextTenant: a.runId ? runsById.get(a.runId)?.context.tenant ?? null : null }));
      const limit = intParam(req.query['limit'], 100, 500) || 100;
      const offset = intParam(req.query['offset'], 0, Number.MAX_SAFE_INTEGER);
      res.json({ artifacts: rows.slice(offset, offset + limit), total: rows.length, limit, offset, unavailable: p.unavailable });
    }),
    /**
     * text/event-stream. Replays the run's recorded history as event-catalog
     * frames (pipeline:run:*, pipeline:step:*, pipeline.approval.*), then
     * folds in live frames: the dispatcher's /api/work/events feed for this
     * run's job, and the box tail (lib/devbox-fleet.ts) of the computer it
     * ran on, as pipeline:step:heartbeat on the execute step.
     */
    events: asyncHandler(async (req: Request, res: Response) => {
      const { p, run } = await findRun(req);
      initSSE(res);
      let seq = 0;
      const send = (frame: PipelineEvent & Record<string, unknown>) => writeSSE(res, frame, ++seq);
      for (const ev of runEvents(run, p.steps.get(run.id) ?? [])) send({ ...ev, replay: true });

      const jobId = run.context.table === 'agent_jobs' ? run.context.id : null;
      const onJob = (raw: unknown) => {
        const ev = raw as { kind?: string; jobId?: string; ts?: string };
        if (!jobId || ev.jobId !== jobId || !ev.kind) return;
        const mapped = LIVE_JOB_EVENT[ev.kind];
        if (mapped) send({ type: mapped.type, runId: run.id, ...(mapped.stepId ? { stepId: mapped.stepId } : {}), at: ev.ts ?? null, status: ev.kind });
      };
      dispatcherEvents.on('job', onJob);
      const boxId = run.context.boxId;
      const unsubscribeBox = boxId
        ? subscribeBox(boxId, (ev) => send({ type: 'pipeline:step:heartbeat', runId: run.id, stepId: 'execute', at: new Date().toISOString(), detail: String(ev['type'] ?? 'event') }))
        : null;
      req.on('close', () => {
        dispatcherEvents.off('job', onJob);
        unsubscribeBox?.();
        endSSE(res);
      });
    }),
  };
}

const view = requireAction('ViewPipelines');
const runs = runReadHandlers();

pipelinesRouter.get('/runs', view, runs.list);
pipelinesRouter.get('/runs/:id', view, runs.one);
pipelinesRouter.get('/runs/:id/steps', view, runs.steps);
pipelinesRouter.get('/runs/:id/events', view, runs.events);
pipelinesRouter.get('/artifacts', view, runs.artifacts);
// The activity graph (docs/activity-graph-migration.md §8): same assembly and stream as orgiq's.
pipelinesRouter.use('/work-graph', pipelinesWorkGraphRouter);
// Run report decks (slice 3 of docs/agentic-flows-migration.md).
pipelinesRouter.use(pipelineDecksRouter);

// ─── Definitions (P2) ───────────────────────────────────────────────────────

// A dry-run's record moves when its job does (the queue's completion path).
watchPipelineRuns();

interface RunDigest { id: string; status: string; startedAt: string | null }

/** Per-definition run facts, SELECTED from the projection per read — never stored. */
function runFacts(runs: readonly Run[]): Map<string, { runCount: number; lastRun: RunDigest | null }> {
  const out = new Map<string, { runCount: number; lastRun: RunDigest | null }>();
  for (const r of runs) {
    const f = out.get(r.definitionId) ?? { runCount: 0, lastRun: null };
    f.runCount += 1;
    if (!f.lastRun || (r.startedAt ?? '') > (f.lastRun.startedAt ?? '')) f.lastRun = { id: r.id, status: r.status, startedAt: r.startedAt };
    out.set(r.definitionId, f);
  }
  return out;
}

function withFacts(d: Definition, facts: ReturnType<typeof runFacts>, defaultRole: string) {
  const f = facts.get(d.id) ?? { runCount: 0, lastRun: null };
  const approvers = effectiveApproverRoles(d, defaultRole);
  return { ...d, runCount: f.runCount, lastRun: f.lastRun, effectiveApproverRoles: approvers.roles, approversDefaulted: approvers.defaulted };
}

/** A runbook's rung on the ladder and what its dry-run says about promotion. */
function runbookState(d: Definition, records: readonly PipelineRunRecord[]) {
  const mine = records.filter((r) => r.definitionId === d.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const lastDryRun = mine[0] ?? null;
  const completed = mine.find((r) => r.status === 'completed') ?? null;
  const judged = completed ?? lastDryRun;
  const candidateId = candidateIdOf(d.id) ?? d.source.id;
  const gate = decideDryRunGate({ id: candidateId }, judged ? { runId: judged.id, definitionId: judged.definitionId, status: judged.status } : null);
  return {
    candidateId,
    proposedKind: d.meta['proposedKind'] ?? null,
    candidateStatus: d.meta['candidateStatus'] ?? null,
    dryRunRunId: d.meta['dryRunRunId'] ?? null,
    lastDryRun,
    dryRunCount: mine.length,
    // What rule 1 says right now about RUNBOOK → SKILL, human approval aside.
    promotionToSkill: gate.ok ? { ok: true as const, runId: judged!.id } : { ok: false as const, reason: gate.reason },
  };
}

// The definitions the signed-in author owns or last edited are GET /api/me/groups?kind=pipeline (lib/mine.ts), not a ?scope here.
pipelinesRouter.get('/definitions', view, asyncHandler(async (req, res) => {
  const [{ definitions, unavailable }, projection, cfg] = await Promise.all([loadDefinitions(), loadProjection(), getPipelinesConfig()]);
  const kind = strParam(req.query['kind']);
  const facts = runFacts(projection.runs);
  const rows = definitions.filter((d) => !kind || d.kind === kind).map((d) => withFacts(d, facts, cfg.defaultApproverRole));
  res.json({ definitions: rows, total: rows.length, unavailable, defaultApproverRole: cfg.defaultApproverRole });
}));

pipelinesRouter.get('/definitions/:id', view, asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const [{ definitions }, projection, cfg] = await Promise.all([loadDefinitions(), loadProjection(), getPipelinesConfig()]);
  const def = definitions.find((d) => d.id === id);
  if (!def) throw new NotFoundError('No definition ' + id);
  const runs = filterRuns(projection.runs, { definitionId: id })
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  const unavailable: Array<{ source: string; error: string }> = [];
  const records = def.kind === 'runbook' ? await readRecords(unavailable, id) : [];
  res.json({
    unavailable,
    definition: withFacts(def, runFacts(runs), cfg.defaultApproverRole),
    runs: runs.slice(0, 20),
    dryRuns: records,
    ...(def.kind === 'runbook' ? { runbook: runbookState(def, records) } : {}),
    approverRoleOptions: APPROVER_ROLE_OPTIONS,
  });
}));

// Record who approves this definition's steps — an author's version, one up.
pipelinesRouter.put('/definitions/:id/approvers', requireAction('AuthorDefinition'), asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const roles = validApproverRoles((req.body ?? {})['roles']);
  if (!roles) throw new ValidationError(`roles must be a list of ${APPROVER_ROLE_OPTIONS.join(' | ')} (empty = the tenant default)`);
  const def = (await loadDefinitions()).definitions.find((d) => d.id === id);
  if (!def) throw new NotFoundError('No definition ' + id);
  const stored = await recordApproverRoles(def, roles, req.session?.sub ?? null);
  res.json({ definition: { ...def, version: stored.version, approverRoles: stored.approverRoles, recorded: true } });
}));

// A runbook dry-run: a governed run through the EXISTING queue, behind
// dispatch-work's brakes (each 409 names its gate and its confirm flag).
pipelinesRouter.post('/definitions/:id/dry-run', requireAction('RunPipeline'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    model?: unknown; budgetPerRunUsd?: unknown;
    confirmOverRunBudget?: unknown; confirmOverAllocation?: unknown; confirmOverEnvelope?: unknown;
  };
  if (body.model !== undefined && typeof body.model !== 'string') throw new ValidationError('model must be a string');
  let budgetPerRunUsd: number | null = null;
  if (body.budgetPerRunUsd !== undefined && body.budgetPerRunUsd !== null) {
    if (typeof body.budgetPerRunUsd !== 'number' || !Number.isFinite(body.budgetPerRunUsd) || body.budgetPerRunUsd < 0) {
      throw new ValidationError('budgetPerRunUsd must be a non-negative number');
    }
    budgetPerRunUsd = body.budgetPerRunUsd;
  }
  const out = await startDryRun({
    definitionId: String(req.params['id'] ?? ''),
    sub: req.session?.sub,
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    budgetPerRunUsd,
    confirm: {
      runBudget: body.confirmOverRunBudget === true,
      allocation: body.confirmOverAllocation === true,
      envelope: body.confirmOverEnvelope === true,
    },
  });
  if (!out.ok) { res.status(out.status).json(out.body); return; }
  res.status(202).json({ run: out.run, jobId: out.jobId, estimate: out.estimate, brakes: out.brakes });
}));

/** The dry-run records, or none with the reason named — never an unreadable ledger read as "no dry-run". */
async function readRecords(unavailable: Array<{ source: string; error: string }>, definitionId?: string): Promise<PipelineRunRecord[]> {
  try {
    return await listRunRecords(definitionId ? { definitionId } : {});
  } catch (err) {
    unavailable.push({ source: 'pipeline_runs', error: (err as Error).message });
    return [];
  }
}

pipelinesRouter.get('/runbooks', view, asyncHandler(async (_req, res) => {
  const [{ definitions, unavailable }, projection, cfg] = await Promise.all([
    loadDefinitions(), loadProjection(), getPipelinesConfig(),
  ]);
  const records = await readRecords(unavailable);
  const facts = runFacts(projection.runs);
  const runbooks = definitions.filter((d) => d.kind === 'runbook')
    .map((d) => ({ ...withFacts(d, facts, cfg.defaultApproverRole), runbook: runbookState(d, records) }));
  res.json({ runbooks, total: runbooks.length, unavailable });
}));

// ─── Approvals (P2) ─────────────────────────────────────────────────────────

pipelinesRouter.get('/approvals', view, asyncHandler(async (_req, res) => {
  const { approvals, unavailable } = await listApprovals();
  res.json({ approvals, total: approvals.length, unavailable });
}));

pipelinesRouter.post('/approvals/:id/decide', requireAction('ApproveStep'), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { decision?: unknown; note?: unknown };
  if (body.decision !== 'approve' && body.decision !== 'reject') throw new ValidationError("decision must be 'approve' or 'reject'");
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') throw new ValidationError('note must be a string');
  const out = await decideApproval(String(req.params['id'] ?? ''), body.decision, {
    role: req.session?.role, sub: req.session?.sub, note: typeof body.note === 'string' ? body.note : null,
  });
  if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
  void notifyPipelinesWorkGraphChanged(out.approval.runId, 'approval');
  res.json({ id: out.approval.id, decision: out.decision, outcome: out.outcome, decidedThrough: out.approval.decidedThrough });
}));

// ─── Cancel (P2) ─────────────────────────────────────────────────────────────

pipelinesRouter.post('/runs/:id/cancel', requireAction('CancelRun'), asyncHandler(async (req, res) => {
  const out = await cancelRun(String(req.params['id'] ?? ''), req.session?.sub ?? null);
  if (!out.ok) { res.status(out.status).json({ error: out.error }); return; }
  void notifyPipelinesWorkGraphChanged(String(req.params['id'] ?? ''), 'run');
  res.json({ id: req.params['id'], status: out.status });
}));

// ─── Configuration (P2) ─────────────────────────────────────────────────────

pipelinesRouter.get('/configuration', view, asyncHandler(async (_req, res) => {
  const cfg = await getPipelinesConfig();
  res.json({ ...cfg, approverRoleOptions: APPROVER_ROLE_OPTIONS });
}));

pipelinesRouter.put('/configuration', requireAction('ManagePipelineConfig'), asyncHandler(async (req, res) => {
  const role = (req.body ?? {})['defaultApproverRole'];
  if (typeof role !== 'string' || !(APPROVER_ROLE_OPTIONS as readonly string[]).includes(role)) {
    throw new ValidationError(`defaultApproverRole must be one of ${APPROVER_ROLE_OPTIONS.join(', ')}`);
  }
  const cfg = await setDefaultApproverRole(role, req.session?.sub ?? null);
  res.json({ ...cfg, approverRoleOptions: APPROVER_ROLE_OPTIONS });
}));
