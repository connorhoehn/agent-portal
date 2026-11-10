// The definition registry's I/O half, the runs this tenant starts, and its
// approvals (docs/pipelines-tenant-goal.md §P2). lib/pipeline-definitions.ts
// is pure; this reads its sources and writes the tenant's own rows.
//
// SOURCES. Bots through providers/bots.ts, the nine assessment commands
// through providers/assessment.ts's `AGENT_COMMANDS`, runbook candidates
// through providers/promotions.ts (seeded fixtures in every environment),
// agents through the AgentCore provider's runtime listing, and the recorded
// versions from `pipeline_definitions` (the `pipelines.definitions` fixture
// under dev:mock). A source that cannot be read is named in `unavailable` —
// an unreadable catalog never reads as an empty one.
//
// NO NEW EXECUTOR (design §5.4). A runbook dry-run is an `agent_jobs` row of
// kind `runbook:dry-run`, enqueued through `enqueueJob` behind the same money
// brakes `POST /api/bots/dispatch-work` applies, claimed and run by the fleet
// dispatcher (under dev:mock it plays the scripted run every offline job
// plays), and closed by the queue's own completion path: `completeJob` emits
// on `jobEvents`, and the listener below moves the `pipeline_runs` row. Reads
// also reconcile a non-terminal record against its job, so a missed event (a
// restart) cannot strand a record at `running`.
//
// NO SECOND APPROVAL STORE. An approval is read off the existing gates — a
// job at `awaiting_review`, a change at `needs_approval`, a pending lab
// consult — and a decision is routed to the provider call each gate's own
// route makes (`reviewJob`, `decideChange`, `answerConsult`).

import { config } from '../config.js';
import { noteSearchWrite } from '../lib/search-index/writes.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import {
  deriveDefinitions, effectiveApproverRoles, projectApprovals, latestDryRun, runStatusForJob,
  isTerminalRunStatus, dryRunPrompt, consultAnswer, canDecide, candidateIdOf,
  DEFAULT_APPROVER_ROLE, DRY_RUN_KIND,
  type Definition, type DefinitionSources, type PipelineRunRecord, type StoredDefinition,
  type ApprovalRequest,
} from '../lib/pipeline-definitions.js';
import type { ContextTenant, PipelineRunStatus } from '../lib/pipeline-runs.js';
import { clock } from '../mock/core/index.js';
import { pipelineConfigRows, pipelineDefinitionRows, pipelineRunRecords } from '../mock/pipeline-definitions.js';
import { jobEvents, type JobChangeEvent } from './agent-jobs.js';
import { userNameFor } from '../lib/user-names.js';
import { publishPipelineRunMove } from '../lib/gateway-run-feed.js';
import { notifyPipelineRun, PIPELINE_NOTIFY_STATUSES } from '../lib/social-notify.js';

type Unavailable = Array<{ source: string; error: string }>;

async function attempt<T>(source: string, unavailable: Unavailable, read: () => Promise<T[]> | T[]): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    unavailable.push({ source, error: (err as Error).message });
    return [];
  }
}

// ─── SQL helpers ─────────────────────────────────────────────────────────────

const s = (name: string, v: string | null): SqlParameter =>
  v === null ? { name, value: { isNull: true } } : { name, value: { stringValue: v } };
const n = (name: string, v: number | null): SqlParameter =>
  v === null ? { name, value: { isNull: true } } : { name, value: { doubleValue: v } };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOrNull = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const jsonArr = (v: unknown): string[] => {
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
};
/** RDS Data API hands TIMESTAMPTZ back naive; every SELECT formats UTC ISO. */
const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function exec(sql: string, params: SqlParameter[] = []): Promise<Array<Record<string, unknown>>> {
  const aurora = await import('./aurora.js');
  return aurora.exec(sql, params) as Promise<Array<Record<string, unknown>>>;
}

// ─── Recorded definitions (pipeline_definitions) ────────────────────────────

function rowToStored(r: Record<string, unknown>): StoredDefinition {
  return {
    id: String(r['id']),
    contextTenant: (str(r['context_tenant']) ?? 'orgiq') as ContextTenant,
    kind: String(r['kind']) as StoredDefinition['kind'],
    title: String(r['title'] ?? r['id']),
    owner: str(r['owner']),
    version: numOrNull(r['version']) ?? 1,
    approverRoles: jsonArr(r['approver_roles']),
    sourceTable: str(r['source_table']),
    sourceId: str(r['source_id']),
    updatedBy: str(r['updated_by']),
    updatedAt: str(r['updated_at']),
  };
}

export async function listStoredDefinitions(): Promise<StoredDefinition[]> {
  if (config.mock.aurora) return pipelineDefinitionRows.rows().map((r) => ({ ...r, approverRoles: [...r.approverRoles] }));
  const rows = await exec(
    `SELECT id, context_tenant, kind, title, owner, version, approver_roles::text AS approver_roles,
            source_table, source_id, updated_by, ${ISO('updated_at')} AS updated_at
       FROM pipeline_definitions ORDER BY id`,
  );
  return rows.map(rowToStored);
}

/** Record an author's version: the approver roles, one version up. */
export async function recordApproverRoles(def: Definition, roles: string[], by: string | null): Promise<StoredDefinition> {
  const stored = await recordApproverRolesRow(def, roles, by);
  // Search (docs/user-search-goal.md): the definition's page record is unchanged in words, but re-read it so the projection stays the registry's mirror.
  await noteSearchWrite({ tenant: 'pipelines', type: def.kind === 'runbook' ? 'runbook' : 'definition', id: def.id });
  return stored;
}

async function recordApproverRolesRow(def: Definition, roles: string[], by: string | null): Promise<StoredDefinition> {
  // The derived definition is version 1; each recorded change is one more.
  const nextVersion = def.version + 1;
  if (config.mock.aurora) {
    const rows = pipelineDefinitionRows.rows();
    const existing = rows.find((r) => r.id === def.id);
    const at = clock.nowIso();
    if (existing) {
      existing.version += 1; existing.approverRoles = [...roles]; existing.updatedBy = by; existing.updatedAt = at;
      return { ...existing };
    }
    const row: StoredDefinition = {
      id: def.id, contextTenant: def.contextTenant, kind: def.kind, title: def.title, owner: def.owner,
      version: nextVersion, approverRoles: [...roles], sourceTable: def.source.table, sourceId: def.source.id,
      updatedBy: by, updatedAt: at,
    };
    rows.push(row);
    return { ...row };
  }
  const rows = await exec(
    `INSERT INTO pipeline_definitions (id, context_tenant, kind, title, owner, version, approver_roles, source_table, source_id, updated_by)
     VALUES (:id, :ctx, :kind, :title, :owner, :version, :roles::jsonb, :stable, :sid, :by)
     ON CONFLICT (id) DO UPDATE SET version = pipeline_definitions.version + 1,
            approver_roles = EXCLUDED.approver_roles, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, context_tenant, kind, title, owner, version, approver_roles::text AS approver_roles,
               source_table, source_id, updated_by, ${ISO('updated_at')} AS updated_at`,
    [
      s('id', def.id), s('ctx', def.contextTenant), s('kind', def.kind), s('title', def.title), s('owner', def.owner),
      { name: 'version', value: { longValue: nextVersion } }, s('roles', JSON.stringify(roles)),
      s('stable', def.source.table), s('sid', def.source.id), s('by', by),
    ],
  );
  return rowToStored(rows[0] ?? {});
}

// ─── Configuration (pipeline_config) ────────────────────────────────────────

export interface PipelinesConfig { defaultApproverRole: string; updatedBy: string | null }

export async function getPipelinesConfig(): Promise<PipelinesConfig> {
  if (config.mock.aurora) {
    const row = pipelineConfigRows.rows().find((r) => r.key === 'default_approver_role');
    return { defaultApproverRole: typeof row?.value === 'string' ? row.value : DEFAULT_APPROVER_ROLE, updatedBy: row?.updatedBy ?? null };
  }
  try {
    const rows = await exec(`SELECT value::text AS value, updated_by FROM pipeline_config WHERE key = 'default_approver_role'`);
    const v = rows[0] ? JSON.parse(String(rows[0]['value'])) : null;
    return { defaultApproverRole: typeof v === 'string' ? v : DEFAULT_APPROVER_ROLE, updatedBy: str(rows[0]?.['updated_by']) };
  } catch {
    // A cluster without pipeline_schema.sql: design §8's default still holds.
    return { defaultApproverRole: DEFAULT_APPROVER_ROLE, updatedBy: null };
  }
}

export async function setDefaultApproverRole(role: string, by: string | null): Promise<PipelinesConfig> {
  // Not a search write: the default approver role is configuration, no indexed doc carries it (check-search-writers EXEMPT).
  return setDefaultApproverRoleRow(role, by);
}

async function setDefaultApproverRoleRow(role: string, by: string | null): Promise<PipelinesConfig> {
  if (config.mock.aurora) {
    const rows = pipelineConfigRows.rows();
    const row = rows.find((r) => r.key === 'default_approver_role');
    if (row) { row.value = role; row.updatedBy = by; } else rows.push({ key: 'default_approver_role', value: role, updatedBy: by });
    return { defaultApproverRole: role, updatedBy: by };
  }
  await exec(
    `INSERT INTO pipeline_config (key, value, updated_by) VALUES ('default_approver_role', :v::jsonb, :by)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [s('v', JSON.stringify(role)), s('by', by)],
  );
  return { defaultApproverRole: role, updatedBy: by };
}

// ─── The registry ────────────────────────────────────────────────────────────

export interface LoadedDefinitions { definitions: Definition[]; unavailable: Unavailable }

export async function loadDefinitionSources(): Promise<{ sources: DefinitionSources; unavailable: Unavailable }> {
  const unavailable: Unavailable = [];
  const sources: DefinitionSources = {
    bots: await attempt('agent_bots', unavailable, async () => {
      const r = await (await import('./bots.js')).listBotsResult();
      if (r.degraded) throw new Error(r.error ?? 'agent_bots unreadable');
      return r.items;
    }),
    commands: await attempt('assessment_commands', unavailable, async () => (await import('./assessment.js')).listCommands()),
    runbooks: await attempt('promotion_candidates', unavailable, async () => (await import('./promotions.js')).listCandidates()),
    agents: await attempt('agent_runtimes', unavailable, async () => {
      const { agentcore } = await import('./index.js');
      const r = await agentcore.listRuntimesResult();
      if (r.degraded) throw new Error(r.error ?? 'agent runtimes unreadable');
      return r.items;
    }),
    stored: await attempt('pipeline_definitions', unavailable, () => listStoredDefinitions()),
  };
  return { sources, unavailable };
}

export async function loadDefinitions(): Promise<LoadedDefinitions> {
  const { sources, unavailable } = await loadDefinitionSources();
  const agentNames = new Map(sources.agents.map((a) => [a.id, a.name]));
  // The owner as a name: a person's display name, or the agent that runs the definition.
  const definitions = deriveDefinitions(sources).map((d) => ({ ...d, ownerName: d.owner ? userNameFor(d.owner) ?? agentNames.get(d.owner) ?? null : null }));
  return { definitions, unavailable };
}

export async function getDefinition(id: string): Promise<Definition | null> {
  return (await loadDefinitions()).definitions.find((d) => d.id === id) ?? null;
}

// ─── Runs that originate here (pipeline_runs) ───────────────────────────────

function rowToRecord(r: Record<string, unknown>): PipelineRunRecord {
  return {
    id: String(r['id']),
    definitionId: String(r['definition_id']),
    contextTenant: (str(r['context_tenant']) ?? 'orgiq') as ContextTenant,
    runKind: str(r['run_kind']) ?? DRY_RUN_KIND,
    status: (str(r['status']) ?? 'pending') as PipelineRunStatus,
    jobId: str(r['job_id']),
    triggeredBy: str(r['triggered_by']),
    model: str(r['model']),
    estimateUsd: numOrNull(r['estimate_usd']),
    costUsd: numOrNull(r['cost_usd']),
    error: str(r['error']),
    startedAt: str(r['started_at']) ?? '',
    finishedAt: str(r['finished_at']),
  };
}

const RECORD_COLUMNS = `id, definition_id, context_tenant, run_kind, status, job_id, triggered_by, model,
  estimate_usd::float8 AS estimate_usd, cost_usd::float8 AS cost_usd, error,
  ${ISO('started_at')} AS started_at, ${ISO('finished_at')} AS finished_at`;

async function readRecords(opts: { definitionId?: string } = {}): Promise<PipelineRunRecord[]> {
  if (config.mock.aurora) {
    return pipelineRunRecords.rows()
      .filter((r) => !opts.definitionId || r.definitionId === opts.definitionId)
      .map((r) => ({ ...r }));
  }
  const rows = opts.definitionId
    ? await exec(`SELECT ${RECORD_COLUMNS} FROM pipeline_runs WHERE definition_id = :d ORDER BY started_at DESC LIMIT 200`, [s('d', opts.definitionId)])
    : await exec(`SELECT ${RECORD_COLUMNS} FROM pipeline_runs ORDER BY started_at DESC LIMIT 500`);
  return rows.map(rowToRecord);
}

async function writeRecord(rec: PipelineRunRecord): Promise<void> {
  if (config.mock.aurora) {
    pipelineRunRecords.rows().push({ ...rec });
    return;
  }
  await exec(
    `INSERT INTO pipeline_runs (id, definition_id, context_tenant, run_kind, status, job_id, triggered_by, model, estimate_usd)
     VALUES (:id, :d, :ctx, :k, :st, :job, :by, :model, :est)`,
    [s('id', rec.id), s('d', rec.definitionId), s('ctx', rec.contextTenant), s('k', rec.runKind), s('st', rec.status),
      s('job', rec.jobId), s('by', rec.triggeredBy), s('model', rec.model), n('est', rec.estimateUsd)],
  );
}

/** Move a record to its job's status — the one writer after creation. Terminal records stay put. */
async function updateRecord(id: string, patch: { status: PipelineRunStatus; costUsd?: number | null; error?: string | null; actorId?: string | null }): Promise<void> {
  const terminal = isTerminalRunStatus(patch.status);
  if (config.mock.aurora) {
    const row = pipelineRunRecords.rows().find((r) => r.id === id);
    // Unchanged status: nothing moved, so nothing to announce (a replayed job event).
    if (!row || isTerminalRunStatus(row.status) || row.status === patch.status) return;
    row.status = patch.status;
    if (patch.costUsd !== undefined) row.costUsd = patch.costUsd;
    if (patch.error !== undefined) row.error = patch.error;
    if (terminal) row.finishedAt = clock.nowIso();
    void announceRun({ id: row.id, definitionId: row.definitionId, triggeredBy: row.triggeredBy, status: row.status, error: row.error, actorId: patch.actorId });
    void publishPipelineRunMove({ id: row.id, status: row.status, error: row.error, definitionId: row.definitionId });
    return;
  }
  const moved = await exec(
    `UPDATE pipeline_runs SET status = :st,
            cost_usd = COALESCE(:cost, cost_usd), error = COALESCE(:err, error),
            finished_at = CASE WHEN :terminal THEN now() ELSE finished_at END
      WHERE id = :id AND status <> :st AND status NOT IN ('completed', 'rejected', 'failed', 'cancelled')
      RETURNING id, definition_id, triggered_by, error`,
    [s('st', patch.status), n('cost', patch.costUsd ?? null), s('err', patch.error ?? null),
      { name: 'terminal', value: { booleanValue: terminal } }, s('id', id)],
  );
  const row = moved[0];
  if (row) {
    void announceRun({ id: String(row['id']), definitionId: str(row['definition_id']), triggeredBy: str(row['triggered_by']), status: patch.status, error: str(row['error']), actorId: patch.actorId });
    void publishPipelineRunMove({ id: String(row['id']), status: patch.status, error: str(row['error']), definitionId: str(row['definition_id']) });
  }
}

/**
 * Design §3.4 row 9: a record that just ENTERED awaiting_approval, completed
 * or failed notifies its trigger and its approver-role holders (lib/social-notify.ts
 * `notifyPipelineRun`, which applies the tenant rule). Fire-and-forget: a
 * notification never slows or fails the job event that moved the record.
 */
async function announceRun(rec: { id: string; definitionId: string | null; triggeredBy: string | null; status: PipelineRunStatus; error: string | null; actorId?: string | null }): Promise<void> {
  try {
    if (!(PIPELINE_NOTIFY_STATUSES as readonly string[]).includes(rec.status)) return;
    const [def, cfg] = await Promise.all([rec.definitionId ? getDefinition(rec.definitionId) : Promise.resolve(null), getPipelinesConfig()]);
    await notifyPipelineRun({
      runId: rec.id, status: rec.status, definitionId: rec.definitionId, definitionTitle: def?.title ?? null,
      triggeredBy: rec.triggeredBy, approverRoles: effectiveApproverRoles(def, cfg.defaultApproverRole).roles, error: rec.error, actorId: rec.actorId,
    });
  } catch (err) {
    console.warn(`[pipelines] could not announce run ${rec.id}: ${(err as Error).message}`);
  }
}

/** A finished record's cost, read off its job once the job reports one — the only write to a terminal record. */
async function fillCost(id: string, costUsd: number): Promise<void> {
  if (config.mock.aurora) {
    const row = pipelineRunRecords.rows().find((r) => r.id === id);
    if (row && row.costUsd == null) row.costUsd = costUsd;
    return;
  }
  await exec(`UPDATE pipeline_runs SET cost_usd = :cost WHERE id = :id AND cost_usd IS NULL`, [n('cost', costUsd), s('id', id)]);
}

/** Bring every record level with its job: a missed event (a restart) or a cost not yet read. */
async function reconcile(records: PipelineRunRecord[]): Promise<PipelineRunRecord[]> {
  const open = records.filter((r) => r.jobId && (!isTerminalRunStatus(r.status) || r.costUsd == null));
  if (open.length === 0) return records;
  const { getJob } = await import('./agent-jobs.js');
  for (const r of open) {
    const job = await getJob(r.jobId!);
    if (!job) continue;
    const status = runStatusForJob(job.status);
    if (isTerminalRunStatus(r.status)) {
      const cost = numOrNull(job.result?.['costUsd']);
      if (cost !== null) { await fillCost(r.id, cost); r.costUsd = cost; }
      continue;
    }
    if (status === r.status) continue;
    const cost = numOrNull(job.result?.['costUsd']);
    await updateRecord(r.id, { status, costUsd: cost, error: job.error });
    r.status = status; r.costUsd = cost ?? r.costUsd; r.error = job.error ?? r.error;
    if (isTerminalRunStatus(status)) r.finishedAt = job.finishedAt ?? clock.nowIso();
  }
  return records;
}

export async function listRunRecords(opts: { definitionId?: string } = {}): Promise<PipelineRunRecord[]> {
  return reconcile(await readRecords(opts));
}

export async function getRunRecord(id: string): Promise<PipelineRunRecord | null> {
  const all = await listRunRecords();
  return all.find((r) => r.id === id) ?? null;
}

/** The newest completed dry-run of `definitionId` (else its newest), reconciled. */
export async function latestDryRunOf(definitionId: string): Promise<PipelineRunRecord | null> {
  return latestDryRun(await listRunRecords({ definitionId }), definitionId);
}

/**
 * Who is cancelling a run, held while `cancelJob` emits. The job event that
 * moves the record carries no actor, so without this the event path would
 * announce the cancel to the person who pressed it.
 */
const cancellingActors = new Map<string, string>();

let watching = false;
/**
 * The existing completion path, heard: `completeJob` / `cancelJob` /
 * `claimNextJob` emit on `jobEvents`, and a job carrying `pipelineRunId` moves
 * its record. Idempotent — the router calls it once at load.
 */
export function watchPipelineRuns(): void {
  if (watching) return;
  watching = true;
  jobEvents.on('change', (ev: JobChangeEvent) => {
    const runId = typeof ev.payload?.['pipelineRunId'] === 'string' ? String(ev.payload['pipelineRunId']) : null;
    if (!runId) return;
    void updateRecord(runId, { status: runStatusForJob(ev.status), actorId: cancellingActors.get(runId) ?? null })
      .catch((err: unknown) => console.warn(`[pipelines] could not move run ${runId}:`, (err as Error).message));
  });
}

// ─── The dry-run ─────────────────────────────────────────────────────────────

/** The cheapest allowlisted devbox model — a dry-run reads, it does not build. */
export const DRY_RUN_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export type DryRunResult =
  | { ok: true; run: PipelineRunRecord; jobId: string; estimate: Record<string, unknown>; brakes: string[] }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Start a dry-run of a runbook definition. The brakes are dispatch-work's,
 * in its order, each with its own confirm flag:
 *   concurrency  the shared ceiling on running work (a hard 429);
 *   run budget   the caller's own cap, when they send one;
 *   allocation   the runbook's initiative's monthly allocation, when its
 *                observations name an initiative and it has one;
 *   envelope     the caller's sprint envelope on that initiative, when held.
 * A runbook whose observations name no initiative is unbudgeted, which is not
 * zero-budget — the allocation and envelope brakes have nothing to judge, and
 * the response says so rather than pretending they ran.
 */
export async function startDryRun(input: {
  definitionId: string;
  sub: string | undefined;
  model?: string;
  budgetPerRunUsd?: number | null;
  confirm: { runBudget: boolean; allocation: boolean; envelope: boolean };
}): Promise<DryRunResult> {
  const out = await startDryRunRow(input);
  // A dry run changes whether the runbook "needs a dry run", and adds a run.
  if (out.ok) await noteSearchWrite({ tenant: 'pipelines', type: 'runbook', id: input.definitionId }, { tenant: 'pipelines', type: 'run', id: out.run.id });
  return out;
}

async function startDryRunRow(input: {
  definitionId: string;
  sub: string | undefined;
  model?: string;
  budgetPerRunUsd?: number | null;
  confirm: { runBudget: boolean; allocation: boolean; envelope: boolean };
}): Promise<DryRunResult> {
  const def = await getDefinition(input.definitionId);
  if (!def) return { ok: false, status: 404, body: { error: `No definition ${input.definitionId}` } };
  if (def.kind !== 'runbook') {
    return { ok: false, status: 409, body: { error: `A dry-run belongs to a runbook; ${def.id} is a ${def.kind} definition and runs through its own surface.` } };
  }
  if (!def.enabled) return { ok: false, status: 409, body: { error: `${def.title} is dismissed, so it cannot be dry-run.` } };
  const inFlight = (await listRunRecords({ definitionId: def.id })).find((r) => !isTerminalRunStatus(r.status));
  if (inFlight) return { ok: false, status: 409, body: { error: `A dry-run of this runbook is already ${inFlight.status} (${inFlight.id}).`, runId: inFlight.id } };

  const bots = await import('../lib/bot-runner.js');
  const concurrency = await bots.checkConcurrency();
  if (concurrency.kind === 'refuse') return { ok: false, status: 429, body: { error: concurrency.reason, gate: 'concurrency' } };

  const model = input.model?.trim() || DRY_RUN_MODEL;
  const { runCostSamples } = await import('./bots.js');
  const { selectDispatchForecast } = await import('../lib/marketplace-estimate.js');
  const forecast = selectDispatchForecast(model, null, {
    perPointRepo: null, perPointModel: null, runRepo: null, runModel: await runCostSamples(model, null),
  });
  const estimate = { ...forecast.estimate, points: forecast.points, scaled: forecast.scaled, confidence: forecast.confidence };
  const f = { costUsdP75: forecast.estimate.costUsdP75, costUsdP25: forecast.estimate.costUsdP25, confidence: forecast.confidence };
  const brakes: string[] = [];

  if (input.budgetPerRunUsd != null) {
    const gate = bots.decideRunBudget(input.budgetPerRunUsd, f.costUsdP75, input.confirm.runBudget);
    if (gate.kind === 'confirm') return { ok: false, status: 409, body: { error: gate.reason, gate: 'run-budget', confirmFlag: 'confirmOverRunBudget', estimate } };
    brakes.push('run budget: within');
  } else brakes.push('run budget: none requested');

  const initiativeId = typeof def.meta['initiativeId'] === 'string' ? String(def.meta['initiativeId']) : null;
  if (initiativeId) {
    const { getBudget } = await import('./budgets.js');
    const { budgetedAllocation } = await import('../lib/budget-periods.js');
    const budget = await getBudget(initiativeId);
    // DE-38: the effective allocation (allocation + carry in; null between sprints).
    const allocatedUsd = budget ? budgetedAllocation(budget) : null;
    if (budget && allocatedUsd != null) {
      const gate = bots.decideAllocation({ allocatedUsd, spentUsd: budget.spentThisPeriodUsd }, f, input.confirm.allocation);
      if (gate.kind === 'confirm') {
        return { ok: false, status: 409, body: {
          error: gate.reason, gate: 'allocation', confirmFlag: 'confirmOverAllocation', estimate,
          allocation: { orgProjectId: initiativeId, allocatedUsd, spentUsd: budget.spentThisPeriodUsd },
        } };
      }
      brakes.push(`allocation: within ${initiativeId}`);
    } else brakes.push(`allocation: ${initiativeId} has none set (unbudgeted)`);
    const envelope = await bots.loadEnvelope(initiativeId, input.sub);
    if (envelope) {
      const gate = bots.decideEnvelope(envelope, f, input.confirm.envelope);
      if (gate.kind === 'confirm') {
        return { ok: false, status: 409, body: {
          error: gate.reason, gate: 'envelope', confirmFlag: 'confirmOverEnvelope', estimate,
          envelope: { orgProjectId: initiativeId, grantId: envelope.grantId, allocatedUsd: envelope.allocatedUsd, attributedSpentUsd: envelope.attributedSpentUsd },
        } };
      }
      brakes.push('envelope: within');
    } else brakes.push('envelope: none held');
  } else brakes.push('allocation and envelope: the runbook names no initiative');

  const { enqueueJob } = await import('./agent-jobs.js');
  const job = await enqueueJob({
    kind: DRY_RUN_KIND,
    title: `Dry-run: ${def.title}`,
    // requiresReview false: a dry-run changes nothing, so there is no artifact
    // for a person to accept — the run completes or fails on its own.
    payload: {
      prompt: dryRunPrompt(def), requiresReview: false, model,
      definitionId: def.id, definitionKind: 'runbook', definitionVersion: def.version, dryRun: true,
    },
    ...(input.sub ? { createdBy: input.sub } : {}),
    maxAttempts: 1,
  });
  if (!job) return { ok: false, status: 503, body: { error: 'could not enqueue the dry-run' } };

  const run: PipelineRunRecord = {
    id: `job:${job.id}`, definitionId: def.id, contextTenant: def.contextTenant, runKind: DRY_RUN_KIND,
    status: runStatusForJob(job.status), jobId: job.id, triggeredBy: input.sub ?? null, model,
    estimateUsd: f.costUsdP75, costUsd: null, error: null, startedAt: job.createdAt, finishedAt: null,
  };
  try {
    await writeRecord(run);
  } catch (err) {
    // A job nothing records is a run nobody can find — take it back out.
    const { cancelJob } = await import('./agent-jobs.js');
    await cancelJob(job.id);
    return { ok: false, status: 503, body: { error: `could not record the dry-run: ${(err as Error).message}` } };
  }
  // The completion listener keys on the payload's run id — stamped after the
  // record exists so no event can arrive for a run that is not there yet.
  job.payload['pipelineRunId'] = run.id;
  if (!config.mock.aurora) {
    await exec(`UPDATE agent_jobs SET payload = payload || jsonb_build_object('pipelineRunId', :rid::text) WHERE id = :id::uuid`,
      [s('rid', run.id), s('id', job.id)]).catch(() => undefined);
  } else {
    const { mockJobs } = await import('../mock/agent-jobs.js');
    const row = mockJobs.find((j) => j.id === job.id);
    if (row) row.payload['pipelineRunId'] = run.id;
  }
  return { ok: true, run, jobId: job.id, estimate, brakes };
}

// ─── Approvals ───────────────────────────────────────────────────────────────

export async function listApprovals(): Promise<{ approvals: ApprovalRequest[]; unavailable: Unavailable }> {
  const unavailable: Unavailable = [];
  const [{ loadProjection }, jobsP, sdlcP, labP] = await Promise.all([
    import('./pipeline-runs.js'), import('./agent-jobs.js'), import('./sdlc.js'), import('./lab.js'),
  ]);
  const projection = await loadProjection();
  for (const u of projection.unavailable) unavailable.push({ source: u.table, error: u.error });
  const jobs = await attempt('agent_jobs', unavailable, () => jobsP.listJobs({ status: 'awaiting_review', limit: 200 }));
  const changes = await attempt('agent_change_requests', unavailable, () => sdlcP.listChangeRequests({ open: true }));
  const consults = await attempt('lab_consults', unavailable, () => labP.listConsults({ status: 'pending' }));
  const { definitions, unavailable: defUnavailable } = await loadDefinitions();
  unavailable.push(...defUnavailable);
  const cfg = await getPipelinesConfig();
  return {
    approvals: projectApprovals({
      jobs, changes, consults, runs: projection.runs, definitions, defaultRole: cfg.defaultApproverRole,
    }),
    unavailable,
  };
}

export type DecideResult =
  | { ok: true; approval: ApprovalRequest; decision: 'approve' | 'reject'; outcome: string }
  | { ok: false; status: number; error: string };

/** Route a decision to the gate's own provider call. */
export async function decideApproval(id: string, decision: 'approve' | 'reject', opts: {
  role: string | undefined; sub: string | undefined; note?: string | null;
}): Promise<DecideResult> {
  const out = await decideApprovalRow(id, decision, opts);
  // The decision moves the approval out of the inbox and its source's run/change with it.
  if (out.ok) await noteSearchWrite({ tenant: 'pipelines', type: 'approval', id });
  return out;
}

async function decideApprovalRow(id: string, decision: 'approve' | 'reject', opts: {
  role: string | undefined; sub: string | undefined; note?: string | null;
}): Promise<DecideResult> {
  const { approvals } = await listApprovals();
  const approval = approvals.find((a) => a.id === id);
  if (!approval) return { ok: false, status: 404, error: `No approval ${id} is waiting — it may already be decided.` };
  if (!canDecide(opts.role, approval.requiredRoles)) {
    return { ok: false, status: 403, error: `This step is approved by ${approval.requiredRoles.join(' or ')}; ${opts.role ?? 'this session'} cannot decide it.` };
  }
  const note = opts.note?.trim() || null;
  if (approval.source === 'agent_jobs') {
    const { reviewJob } = await import('./agent-jobs.js');
    const job = await reviewJob(approval.sourceId, decision === 'approve' ? 'accept' : 'reject', note ?? undefined);
    if (!job) return { ok: false, status: 409, error: 'the job is no longer awaiting review' };
    // Same follow-through as POST /api/work/jobs/:id/review: a rejected fix
    // puts its finding back on the board.
    if (decision === 'reject') await (await import('./org-sweeps.js')).reopenFindingForJob(job.id);
    return { ok: true, approval, decision, outcome: job.status };
  }
  if (approval.source === 'agent_change_requests') {
    const { decideChange } = await import('./sdlc.js');
    // The same separation-of-duties checks as /api/sdlc decide (DE-43): the
    // change's author is refused, whichever inbox they decide it from.
    if (!opts.sub) return { ok: false, status: 401, error: 'a decision needs a signed-in decider' };
    const out = await decideChange(approval.sourceId, decision, { by: opts.sub, role: opts.role ?? null, note });
    if (!out.ok) return { ok: false, status: 409, error: out.error ?? 'could not decide the change' };
    return { ok: true, approval, decision, outcome: out.status ?? decision };
  }
  const { answerConsult, CONSULT_ANSWER_MAX } = await import('./lab.js');
  const answer = consultAnswer(decision, note);
  // The consult's own cap (sweep 12, U1), the same one POST /api/lab/consults/:id/answer applies.
  if (answer.length > CONSULT_ANSWER_MAX) return { ok: false, status: 400, error: `an answer is at most ${CONSULT_ANSWER_MAX} characters` };
  const consult = await answerConsult(approval.sourceId, answer, opts.sub ?? 'unknown');
  if (!consult) return { ok: false, status: 409, error: 'the consult is no longer pending' };
  return { ok: true, approval, decision, outcome: consult.status };
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Cancel a run through the source's own verb: a queued or claimed job
 * (`cancelJob`), a running assessment command (`stopRun`). Anything else is
 * cancelled where it runs — the tenant records runs, it does not own their
 * executors.
 */
export async function cancelRun(runId: string, actorId?: string | null): Promise<{ ok: true; status: string } | { ok: false; status: number; error: string }> {
  const out = await cancelRunRow(runId, actorId);
  if (out.ok) await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: runId });
  return out;
}

async function cancelRunRow(runId: string, actorId?: string | null): Promise<{ ok: true; status: string } | { ok: false; status: number; error: string }> {
  const { loadProjection } = await import('./pipeline-runs.js');
  const run = (await loadProjection()).runs.find((r) => r.id === runId);
  if (!run) return { ok: false, status: 404, error: `No run ${runId}` };
  if (run.context.table === 'agent_jobs') {
    const { cancelJob } = await import('./agent-jobs.js');
    if (actorId) cancellingActors.set(runId, actorId);
    let cancelled: boolean;
    try { cancelled = await cancelJob(run.context.id); } finally { if (actorId) setTimeout(() => cancellingActors.delete(runId), 5000).unref(); }
    if (!cancelled) {
      return { ok: false, status: 409, error: `Only a queued or claimed job can be cancelled; this one is ${run.context.sourceStatus}.` };
    }
    await updateRecord(runId, { status: 'cancelled', actorId }).catch(() => undefined);
    return { ok: true, status: 'cancelled' };
  }
  if (run.context.table === 'assessment_runs') {
    const { stopRun } = await import('./assessment.js');
    const out = await stopRun(run.context.id);
    if (!out.ok) return { ok: false, status: out.status, error: out.reason };
    return { ok: true, status: 'failed' };
  }
  return { ok: false, status: 409, error: `A ${run.context.table} run is stopped where it runs, not from the ledger.` };
}

export { candidateIdOf, effectiveApproverRoles };

