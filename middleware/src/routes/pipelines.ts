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
// in routes/assessment.ts) through `runReadHandlers`. Definitions and
// approvals are P2.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import { dispatcherEvents } from '../lib/job-dispatcher.js';
import { subscribe as subscribeBox } from '../lib/devbox-fleet.js';
import {
  filterRuns, runEvents, type ContextTenant, type PipelineEvent, type PipelineEventName, type Run,
} from '../lib/pipeline-runs.js';
import { loadProjection } from '../providers/pipeline-runs.js';
import { requireAction } from '../lib/authz.js';
import { ROLES_BY_TENANT } from '../lib/session.js';
import { tenantMembers, type TenantSummary } from '../lib/tenant-summary.js';
import { pipelinesSurfaceCounts, pipelinesSurfaces } from '../mock/pipelines.js';

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
      res.json({ runs: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset, unavailable: p.unavailable, unlinked: p.unlinked });
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
