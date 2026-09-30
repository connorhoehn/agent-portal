// The run projection — five run-shaped tables read as one model
// (docs/social-tenant-and-pipelines-research-2026-09-29.md §D.3,
// docs/pipelines-tenant-goal.md §"The projection").
//
// PURE. Rows in, Runs out: no express, no route, no Aurora. The same function
// serves the dev:mock fixtures (providers/pipeline-runs.ts reads them) and the
// real tables (the same provider reads those through the existing providers),
// and the parity entity in mock/core/parity/entities.ts runs the crosswalk
// below over the SQL seed. One projection, two row sources.
//
// THE MODEL, borrowed rather than invented:
//   Run       { id, definitionId, tenant, status: PipelineRunStatus, triggeredBy,
//               triggerType, startedAt, finishedAt, costUsd, context }
//   Step      { runId, stepId, status: PipelineStepStatus, attempts[] }
//   Artifact  { id, runId, stepId, kind, uri, meta }
//   Event     event-catalog names (pipeline:run:*, pipeline:step:*, pipeline.approval.*)
// `PipelineRunStatus` is pipeline-runtime's nine — the same vocabulary the
// installed realtime-modules client carries as `RunItemStatus`
// (dist/client/pipelines/catalog.d.ts), minus its platform-only `interrupted`.
//
// "ONCE" (goal doc, decided there). Every row of the five sources is named in
// exactly one Run's `context.sources[]`. A `bot_runs` row with a `job_id` is
// the TRIGGER RECORD of that job's Run; one with a `run_id` is the trigger of
// that `agent_project_runs` Run; a bot run with neither (or whose job/run is
// not among the rows read) is a Run of its own. The Run is keyed on its
// primary row, and `context.sourceStatus` is the primary row's own status —
// the crosswalk is lossy on purpose (a skipped bot firing is not a
// cancellation in intent, research §D.4's risk), so the original survives.

// ─── Vocabularies ────────────────────────────────────────────────────────────

/** pipeline-runtime's `PipelineRunStatus` (src/types/pipeline-execution.ts:51-60). */
export const PIPELINE_RUN_STATUSES = [
  'pending', 'running', 'awaiting_approval', 'paused_at_breakpoint',
  'completed', 'rejected', 'failed', 'cancelled', 'stuck',
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];

/** Step statuses this projection can honestly produce from the source rows. */
export type PipelineStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped';

/** Definition kinds (research §D.3). `runbook` arrives with definitions in P2. */
export type DefinitionKind = 'runbook' | 'agent' | 'bot' | 'assessment-command' | 'compaction';

/** pipeline-runtime's trigger vocabulary (platform-api `triggerType`). */
export type TriggerType = 'manual' | 'schedule' | 'webhook' | 'document-event';

export type ArtifactKind = 'change' | 'document' | 'scores' | 'trace' | 'transcript' | 'image';

/** The five run-shaped tables the projection reads (research §D.1). */
export type SourceTable = 'agent_jobs' | 'bot_runs' | 'agent_project_runs' | 'assessment_runs' | 'distillation_compactions';
export const SOURCE_TABLES: readonly SourceTable[] = [
  'agent_jobs', 'bot_runs', 'agent_project_runs', 'assessment_runs', 'distillation_compactions',
];

/** The tenant whose data a Run is — the table decides it (research §D.3). */
export type ContextTenant = 'orgiq' | 'assessment';
const TENANT_OF: Record<SourceTable, ContextTenant> = {
  agent_jobs: 'orgiq',
  bot_runs: 'orgiq',
  agent_project_runs: 'orgiq',
  distillation_compactions: 'orgiq',
  assessment_runs: 'assessment',
};

/** Event-catalog names this projection emits (event-catalog `pipeline*.ts`). */
export const PIPELINE_EVENT_NAMES = [
  'pipeline:run:started', 'pipeline:run:completed', 'pipeline:run:failed',
  'pipeline:run:cancelled', 'pipeline:run:stuck',
  'pipeline:step:started', 'pipeline:step:completed', 'pipeline:step:failed',
  'pipeline:step:skipped', 'pipeline:step:heartbeat',
  'pipeline.approval.requested', 'pipeline.approval.resolved',
] as const;
export type PipelineEventName = (typeof PIPELINE_EVENT_NAMES)[number];

/**
 * The status crosswalk — mechanical, research §D.3 verbatim:
 * queued→pending, claimed|running→running, awaiting_review→awaiting_approval,
 * done|succeeded|completed→completed, skipped→cancelled, blocked→rejected,
 * failed→failed, cancelled→cancelled.
 *
 * A status no source table can produce today reads `stuck` ("nobody can say
 * what it is doing") rather than being guessed into a healthier bucket; the
 * original is kept on `context.sourceStatus` either way.
 */
export function crosswalkStatus(sourceStatus: string): PipelineRunStatus {
  switch (sourceStatus) {
    case 'queued': return 'pending';
    case 'claimed':
    case 'running': return 'running';
    case 'awaiting_review': return 'awaiting_approval';
    case 'done':
    case 'succeeded':
    case 'completed': return 'completed';
    case 'skipped': return 'cancelled';
    case 'blocked': return 'rejected';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'stuck';
  }
}

export function isPipelineRunStatus(v: unknown): v is PipelineRunStatus {
  return typeof v === 'string' && (PIPELINE_RUN_STATUSES as readonly string[]).includes(v);
}

// ─── Source rows (structural — fixture rows and provider rows both fit) ─────

export interface JobSource {
  id: string; kind: string; title: string; status: string;
  payload?: Record<string, unknown> | null;
  attempts?: number; boxId: string | null;
  result: Record<string, unknown> | null; error: string | null;
  createdBy: string | null; createdAt: string;
  claimedAt: string | null; startedAt: string | null; finishedAt: string | null;
  botId: string | null; botName?: string | null; botTrigger?: string | null;
}

export interface BotRunSource {
  id: string; botId: string | null; trigger: string;
  runId: string | null; jobId: string | null; workItemId: string | null;
  status: string; costUsd: number | null;
  startedAt: string; finishedAt: string | null;
  outcome?: Record<string, unknown> | null;
  dispatchedBy: string | null;
}

export interface ProjectRunSource {
  id: string; projectId: string; prompt: string; model: string | null;
  status: string; startedAt: string; finishedAt: string | null;
  filesChanged: number | null; error: string | null; costUsd: number | null;
  workItemId?: string | null;
}

/** `assessment_runs` — snake_case, as the assessment fixture and provider carry it. */
export interface AssessmentRunSource {
  id: string; command: string; team_id: string | null; status: string;
  source?: string | null; launched_by?: string | null;
  started_at: string; finished_at: string | null;
  summary?: string | null; error: string | null; files_written?: string[] | null;
}

export interface CompactionSource {
  id: string; level: string; status: string;
  startedAt: string; finishedAt: string | null;
  error?: string; requestedBy?: string | null; repo?: string | null;
  phase?: string | null; stepLabel?: string | null; costUsd?: number | null;
  produced?: { cluster_ids: string[]; artifact_ids: string[] };
}

/** `agent_change_requests` — the `change` artifact (commit-per-capture). */
export interface ChangeSource {
  id: string; runId: string | null; title: string; status: string;
  commitSha: string | null; createdAt: string; decidedAt?: string | null;
  prUrl?: string | null; filesChanged?: number;
}

export interface RunSources {
  agentJobs: readonly JobSource[];
  botRuns: readonly BotRunSource[];
  agentProjectRuns: readonly ProjectRunSource[];
  assessmentRuns: readonly AssessmentRunSource[];
  compactions: readonly CompactionSource[];
  /** Optional: artifacts only. A change is not a run. */
  changes?: readonly ChangeSource[];
}

// ─── The model ───────────────────────────────────────────────────────────────

export interface SourceRef {
  table: SourceTable;
  id: string;
  /** The row's own status, verbatim. */
  status: string;
  /** `primary` keys the Run; `trigger` is a bot firing folded into it. */
  role: 'primary' | 'trigger';
}

export interface RunContext {
  /** Whose data this is — the table decides (assessment_runs → assessment). */
  tenant: ContextTenant;
  kind: DefinitionKind;
  /** The primary row's table and id. */
  table: SourceTable;
  id: string;
  /** The primary row's status before the crosswalk. */
  sourceStatus: string;
  /** Every source row folded into this Run — each row appears in exactly one Run. */
  sources: SourceRef[];
  /** A human title for the row: the bot's name, the command, the prompt. */
  title: string;
  botId?: string | null;
  projectId?: string | null;
  workItemId?: string | null;
  boxId?: string | null;
  /** The trigger as the source spelled it (cron, pr_watch, marketplace, …). */
  trigger?: string | null;
  error?: string | null;
}

export interface Run {
  id: string;
  definitionId: string;
  /** Same as `context.tenant` — the tenant the run is recorded against. */
  tenant: ContextTenant;
  status: PipelineRunStatus;
  triggeredBy: string | null;
  triggerType: TriggerType;
  startedAt: string | null;
  finishedAt: string | null;
  /** What the source recorded; null is "not recorded", never zero. */
  costUsd: number | null;
  context: RunContext;
}

export interface StepAttempt { attempt: number; status: PipelineStepStatus; startedAt: string | null; finishedAt: string | null }

export interface Step {
  runId: string;
  stepId: string;
  label: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: StepAttempt[];
  detail?: string | null;
}

export interface Artifact {
  id: string;
  /** Null for an artifact no projected run owns (a change captured outside a run). */
  runId: string | null;
  stepId: string | null;
  kind: ArtifactKind;
  uri: string;
  title: string;
  createdAt: string | null;
  meta: Record<string, unknown>;
}

export interface PipelineEvent {
  /** The event-catalog name. */
  type: PipelineEventName;
  runId: string;
  stepId?: string;
  at: string | null;
  status?: string;
  detail?: string;
}

export interface Projection {
  runs: Run[];
  steps: Map<string, Step[]>;
  artifacts: Artifact[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Run ids are namespaced by table: ids are minted independently per table. */
export function runIdFor(table: SourceTable, id: string): string {
  const prefix: Record<SourceTable, string> = {
    agent_jobs: 'job', bot_runs: 'bot-run', agent_project_runs: 'project-run',
    assessment_runs: 'assessment-run', distillation_compactions: 'compaction',
  };
  return `${prefix[table]}:${id}`;
}

function triggerTypeFor(trigger: string | null | undefined, createdBy?: string | null): TriggerType {
  switch (trigger) {
    case 'cron': return 'schedule';
    case 'pr_watch': return 'webhook';
    case 'manual':
    case 'marketplace': return 'manual';
    default: return createdBy === 'scheduler' ? 'schedule' : 'manual';
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function step(runId: string, stepId: string, label: string, status: PipelineStepStatus,
  startedAt: string | null, finishedAt: string | null, detail?: string | null, attempt = 1): Step {
  const attempts: StepAttempt[] = status === 'pending' ? [] : [{ attempt, status, startedAt, finishedAt }];
  return { runId, stepId, label, status, startedAt, finishedAt, attempts, ...(detail ? { detail } : {}) };
}

/** The `execute` step's status from a crosswalked run status. */
function executeStatus(s: PipelineRunStatus): PipelineStepStatus {
  switch (s) {
    case 'pending': return 'pending';
    case 'running': case 'stuck': case 'paused_at_breakpoint': return 'running';
    case 'failed': return 'failed';
    case 'cancelled': case 'rejected': return 'skipped';
    default: return 'completed';
  }
}

function triggerStep(runId: string, trigger: BotRunSource | undefined): Step[] {
  if (!trigger) return [];
  return [step(runId, 'trigger', `${trigger.trigger} firing`, 'completed', trigger.startedAt, trigger.startedAt,
    typeof trigger.outcome?.['reason'] === 'string' ? String(trigger.outcome['reason']) : null)];
}

// ─── The projection ─────────────────────────────────────────────────────────

export function projectRuns(src: RunSources): Projection {
  const runs: Run[] = [];
  const steps = new Map<string, Step[]>();
  const artifacts: Artifact[] = [];

  const jobIds = new Set(src.agentJobs.map((j) => j.id));
  const projectRunIds = new Set(src.agentProjectRuns.map((r) => r.id));
  // A bot run folds into the job/run it names — only when that row was read.
  const triggerOfJob = new Map<string, BotRunSource>();
  const triggerOfProjectRun = new Map<string, BotRunSource>();
  const standaloneBotRuns: BotRunSource[] = [];
  for (const br of src.botRuns) {
    if (br.jobId && jobIds.has(br.jobId) && !triggerOfJob.has(br.jobId)) triggerOfJob.set(br.jobId, br);
    else if (br.runId && projectRunIds.has(br.runId) && !triggerOfProjectRun.has(br.runId)) triggerOfProjectRun.set(br.runId, br);
    else standaloneBotRuns.push(br);
  }
  const changesByRun = new Map<string, ChangeSource[]>();
  for (const c of src.changes ?? []) {
    if (c.runId && projectRunIds.has(c.runId)) {
      changesByRun.set(c.runId, [...(changesByRun.get(c.runId) ?? []), c]);
    } else {
      artifacts.push(changeArtifact(c, null));
    }
  }

  const refs = (primary: SourceRef, trigger?: BotRunSource): SourceRef[] => (
    trigger ? [primary, { table: 'bot_runs', id: trigger.id, status: trigger.status, role: 'trigger' }] : [primary]
  );

  // agent_jobs — the queue loop's run (research §D.4 slice).
  for (const j of src.agentJobs) {
    const id = runIdFor('agent_jobs', j.id);
    const trig = triggerOfJob.get(j.id);
    const status = crosswalkStatus(j.status);
    const kind: DefinitionKind = j.botId ? 'bot' : 'agent';
    runs.push({
      id,
      definitionId: j.botId ? `bot:${j.botId}` : `job-kind:${j.kind}`,
      tenant: TENANT_OF.agent_jobs,
      status,
      triggeredBy: trig?.dispatchedBy ?? j.createdBy ?? null,
      triggerType: triggerTypeFor(trig?.trigger ?? j.botTrigger, j.createdBy),
      startedAt: j.createdAt,
      finishedAt: j.finishedAt,
      costUsd: trig?.costUsd ?? num(j.result?.['costUsd']),
      context: {
        tenant: TENANT_OF.agent_jobs, kind, table: 'agent_jobs', id: j.id,
        sourceStatus: j.status,
        sources: refs({ table: 'agent_jobs', id: j.id, status: j.status, role: 'primary' }, trig),
        title: j.botName ?? j.title, botId: j.botId, boxId: j.boxId,
        workItemId: trig?.workItemId ?? null, trigger: trig?.trigger ?? j.botTrigger ?? null,
        error: j.error,
      },
    });
    const claimSt: PipelineStepStatus = j.claimedAt ? 'completed' : (status === 'cancelled' ? 'skipped' : 'pending');
    const reviewWanted = j.status === 'awaiting_review' || j.payload?.['requiresReview'] === true;
    const s: Step[] = [
      ...triggerStep(id, trig),
      step(id, 'enqueue', 'Enqueued', 'completed', j.createdAt, j.createdAt, j.createdBy ? `by ${j.createdBy}` : null),
      step(id, 'claim', 'Claimed by a box', claimSt, j.claimedAt, j.claimedAt, j.boxId ? `box ${j.boxId}` : null),
      step(id, 'execute', 'Executed', j.claimedAt || status !== 'pending' ? executeStatus(status) : 'pending',
        j.startedAt, j.finishedAt, j.error, Math.max(j.attempts ?? 1, 1)),
    ];
    if (reviewWanted) {
      const rs: PipelineStepStatus = j.status === 'awaiting_review' ? 'awaiting_approval'
        : j.status === 'done' ? 'completed' : status === 'failed' || status === 'cancelled' ? 'skipped' : 'pending';
      s.push(step(id, 'review', 'Human review', rs, j.status === 'awaiting_review' ? j.finishedAt : null,
        j.status === 'done' ? j.finishedAt : null));
    }
    steps.set(id, s);
    if (j.result) {
      artifacts.push({
        id: `transcript:${j.id}`, runId: id, stepId: 'execute', kind: 'transcript',
        uri: `agent_jobs/${j.id}#result`, title: String(j.result['summary'] ?? j.title),
        createdAt: j.finishedAt,
        meta: {
          ...(num(j.result['turns']) !== null ? { turns: j.result['turns'] } : {}),
          ...(num(j.result['toolCalls']) !== null ? { toolCalls: j.result['toolCalls'] } : {}),
        },
      });
    }
  }

  // agent_project_runs — a governed run; its changes are the `change` artifacts.
  for (const r of src.agentProjectRuns) {
    const id = runIdFor('agent_project_runs', r.id);
    const trig = triggerOfProjectRun.get(r.id);
    const status = crosswalkStatus(r.status);
    runs.push({
      id,
      definitionId: `project:${r.projectId}`,
      tenant: TENANT_OF.agent_project_runs,
      status,
      triggeredBy: trig?.dispatchedBy ?? null,
      triggerType: triggerTypeFor(trig?.trigger),
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      costUsd: r.costUsd ?? trig?.costUsd ?? null,
      context: {
        tenant: TENANT_OF.agent_project_runs, kind: trig?.botId ? 'bot' : 'agent',
        table: 'agent_project_runs', id: r.id, sourceStatus: r.status,
        sources: refs({ table: 'agent_project_runs', id: r.id, status: r.status, role: 'primary' }, trig),
        title: r.prompt, botId: trig?.botId ?? null, projectId: r.projectId,
        workItemId: r.workItemId ?? trig?.workItemId ?? null, trigger: trig?.trigger ?? null, error: r.error,
      },
    });
    const s: Step[] = [
      ...triggerStep(id, trig),
      step(id, 'execute', 'Executed', executeStatus(status), r.startedAt, r.finishedAt, r.error),
    ];
    const changes = changesByRun.get(r.id) ?? [];
    if (changes.length === 0) {
      s.push(step(id, 'capture', 'Captured a change',
        status === 'completed' ? (r.filesChanged ? 'completed' : 'skipped') : status === 'running' ? 'pending' : 'skipped',
        null, null, r.filesChanged === 0 ? 'no files changed' : null));
    }
    for (const c of changes) {
      s.push(...changeSteps(id, c));
      artifacts.push(changeArtifact(c, id));
    }
    steps.set(id, s);
  }

  // bot_runs with no job/run read — a firing is a run of its own.
  for (const b of standaloneBotRuns) {
    const id = runIdFor('bot_runs', b.id);
    const status = crosswalkStatus(b.status);
    runs.push({
      id,
      definitionId: b.botId ? `bot:${b.botId}` : 'marketplace',
      tenant: TENANT_OF.bot_runs,
      status,
      triggeredBy: b.dispatchedBy,
      triggerType: triggerTypeFor(b.trigger),
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      costUsd: b.costUsd,
      context: {
        tenant: TENANT_OF.bot_runs, kind: b.botId ? 'bot' : 'agent', table: 'bot_runs', id: b.id,
        sourceStatus: b.status,
        sources: [{ table: 'bot_runs', id: b.id, status: b.status, role: 'primary' }],
        title: b.botId ? `bot ${b.botId}` : `marketplace work ${b.workItemId ?? ''}`.trim(),
        botId: b.botId, workItemId: b.workItemId, trigger: b.trigger,
        error: typeof b.outcome?.['error'] === 'string' ? String(b.outcome['error']) : null,
      },
    });
    steps.set(id, [
      step(id, 'trigger', `${b.trigger} firing`, 'completed', b.startedAt, b.startedAt),
      step(id, 'dispatch', 'Dispatched', status === 'cancelled' ? 'skipped' : 'completed', b.startedAt, b.startedAt,
        b.status === 'skipped' && typeof b.outcome?.['reason'] === 'string' ? String(b.outcome['reason']) : null),
      step(id, 'execute', 'Executed', executeStatus(status), b.startedAt, b.finishedAt),
    ]);
  }

  // assessment_runs — the command is the definition; scoring logs are `scores`.
  for (const a of src.assessmentRuns) {
    const id = runIdFor('assessment_runs', a.id);
    const status = crosswalkStatus(a.status);
    const files = a.files_written ?? [];
    runs.push({
      id,
      definitionId: `assessment:${a.command}`,
      tenant: TENANT_OF.assessment_runs,
      status,
      triggeredBy: a.launched_by ?? null,
      triggerType: 'manual',
      startedAt: a.started_at,
      finishedAt: a.finished_at,
      costUsd: null,
      context: {
        tenant: TENANT_OF.assessment_runs, kind: 'assessment-command', table: 'assessment_runs', id: a.id,
        sourceStatus: a.status,
        sources: [{ table: 'assessment_runs', id: a.id, status: a.status, role: 'primary' }],
        title: a.team_id ? `${a.command} · ${a.team_id}` : a.command,
        error: a.error,
      },
    });
    steps.set(id, [
      step(id, 'launch', 'Launched', 'completed', a.started_at, a.started_at, a.source ? `source ${a.source}` : null),
      step(id, 'execute', 'Executed', executeStatus(status), a.started_at, a.finished_at, a.error ?? a.summary ?? null),
      step(id, 'write', 'Wrote outputs',
        files.length > 0 ? 'completed' : status === 'running' ? 'pending' : 'skipped',
        null, files.length > 0 ? a.finished_at : null, files.length > 0 ? `${files.length} file(s)` : null),
    ]);
    for (const f of files) {
      artifacts.push({
        id: `${/scoring_log_/.test(f) ? 'scores' : 'document'}:${a.id}:${f}`,
        runId: id, stepId: 'write', kind: /scoring_log_/.test(f) ? 'scores' : 'document',
        uri: f, title: f.split('/').pop() ?? f, createdAt: a.finished_at, meta: { command: a.command, teamId: a.team_id },
      });
    }
  }

  // distillation_compactions — the one table with step-level progress (`phase`).
  const PHASES = ['claim', 'read', 'merge', 'write'] as const;
  for (const c of src.compactions) {
    const id = runIdFor('distillation_compactions', c.id);
    const status = crosswalkStatus(c.status);
    runs.push({
      id,
      definitionId: `compaction:${c.level}`,
      tenant: TENANT_OF.distillation_compactions,
      status,
      triggeredBy: c.requestedBy ?? null,
      triggerType: c.requestedBy ? 'manual' : 'schedule',
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
      costUsd: num(c.costUsd),
      context: {
        tenant: TENANT_OF.distillation_compactions, kind: 'compaction', table: 'distillation_compactions', id: c.id,
        sourceStatus: c.status,
        sources: [{ table: 'distillation_compactions', id: c.id, status: c.status, role: 'primary' }],
        title: `${c.level} compaction${c.repo ? ` · ${c.repo}` : ''}`, error: c.error ?? null,
      },
    });
    const at = c.phase === 'done' ? PHASES.length : PHASES.indexOf(c.phase as (typeof PHASES)[number]);
    steps.set(id, PHASES.map((p, i) => {
      let st: PipelineStepStatus;
      if (status === 'completed') st = 'completed';
      else if (status === 'pending') st = 'pending';
      else if (at < 0) st = i === 0 && status !== 'failed' ? 'running' : i === 0 ? 'completed' : status === 'failed' ? 'skipped' : 'pending';
      else if (i < at) st = 'completed';
      else if (i === at) st = status === 'failed' ? 'failed' : 'running';
      else st = status === 'failed' ? 'skipped' : 'pending';
      return step(id, p, p[0]!.toUpperCase() + p.slice(1), st,
        i === 0 ? c.startedAt : null, st === 'completed' && i === PHASES.length - 1 ? c.finishedAt : null,
        i === at && c.stepLabel ? c.stepLabel : null);
    }));
    for (const aid of c.produced?.artifact_ids ?? []) {
      artifacts.push({ id: `document:${c.id}:${aid}`, runId: id, stepId: 'write', kind: 'document',
        uri: `distillation/artifacts/${aid}`, title: aid, createdAt: c.finishedAt, meta: { level: c.level } });
    }
  }

  runs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return { runs, steps, artifacts };
}

function changeArtifact(c: ChangeSource, runId: string | null): Artifact {
  return {
    id: `change:${c.id}`, runId, stepId: runId ? 'capture' : null, kind: 'change',
    uri: c.commitSha ?? `agent_change_requests/${c.id}`, title: c.title, createdAt: c.createdAt,
    meta: { changeId: c.id, status: c.status, ...(c.prUrl ? { prUrl: c.prUrl } : {}),
      ...(typeof c.filesChanged === 'number' ? { filesChanged: c.filesChanged } : {}) },
  };
}

/** capture → review → gate → deliver, read off the change's status (agent_sdlc_schema.sql:53). */
function changeSteps(runId: string, c: ChangeSource): Step[] {
  const order = ['captured', 'in_review', 'changes_requested', 'blocked', 'approved', 'delivering', 'delivered'];
  const i = order.indexOf(c.status);
  const failed = c.status === 'failed';
  const review: PipelineStepStatus = c.status === 'captured' ? 'pending' : c.status === 'in_review' ? 'running' : failed ? 'skipped' : 'completed';
  const gate: PipelineStepStatus = c.status === 'blocked' ? 'failed' : c.status === 'changes_requested' ? 'failed'
    : i >= order.indexOf('approved') ? 'completed' : c.status === 'in_review' || c.status === 'captured' ? 'pending'
      : 'awaiting_approval';
  const deliver: PipelineStepStatus = c.status === 'delivered' ? 'completed' : c.status === 'delivering' ? 'running'
    : failed ? 'failed' : c.status === 'blocked' || c.status === 'changes_requested' ? 'skipped' : 'pending';
  return [
    step(runId, 'capture', 'Captured a change', 'completed', c.createdAt, c.createdAt, c.commitSha ? `commit ${c.commitSha.slice(0, 8)}` : null),
    step(runId, 'review', 'Reviewed', review, null, null),
    step(runId, 'gate', 'Policy gates', gate, null, c.decidedAt ?? null),
    step(runId, 'deliver', 'Delivered', deliver, null, null),
  ];
}

// ─── Events — the recorded history, as event-catalog frames ────────────────

const STEP_EVENT: Partial<Record<PipelineStepStatus, PipelineEventName>> = {
  completed: 'pipeline:step:completed', failed: 'pipeline:step:failed', skipped: 'pipeline:step:skipped',
};
const RUN_EVENT: Partial<Record<PipelineRunStatus, PipelineEventName>> = {
  completed: 'pipeline:run:completed', failed: 'pipeline:run:failed', rejected: 'pipeline:run:failed',
  cancelled: 'pipeline:run:cancelled', stuck: 'pipeline:run:stuck',
};

/**
 * The Run's history as it would have streamed: run started, each step's
 * start and end, an approval request where a step waits on a person, the
 * run's terminal event. Replayed first on `GET …/events`, then live frames.
 */
export function runEvents(run: Run, runSteps: readonly Step[]): PipelineEvent[] {
  const out: PipelineEvent[] = [{ type: 'pipeline:run:started', runId: run.id, at: run.startedAt, status: run.status }];
  for (const s of runSteps) {
    if (s.status === 'pending') continue;
    out.push({ type: 'pipeline:step:started', runId: run.id, stepId: s.stepId, at: s.startedAt, detail: s.label });
    if (s.status === 'awaiting_approval') {
      out.push({ type: 'pipeline.approval.requested', runId: run.id, stepId: s.stepId, at: s.startedAt, detail: s.label });
      continue;
    }
    const end = STEP_EVENT[s.status];
    if (end) out.push({ type: end, runId: run.id, stepId: s.stepId, at: s.finishedAt ?? s.startedAt, status: s.status, ...(s.detail ? { detail: s.detail } : {}) });
  }
  const terminal = RUN_EVENT[run.status];
  if (terminal) out.push({ type: terminal, runId: run.id, at: run.finishedAt, status: run.status, ...(run.context.sourceStatus !== run.status ? { detail: `source status ${run.context.sourceStatus}` } : {}) });
  return out;
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface RunFilter { status?: string; kind?: string; contextTenant?: string; definitionId?: string; botId?: string }

export function filterRuns(runs: readonly Run[], f: RunFilter): Run[] {
  return runs.filter((r) => (!f.status || r.status === f.status)
    && (!f.kind || r.context.kind === f.kind)
    && (!f.contextTenant || r.context.tenant === f.contextTenant)
    && (!f.definitionId || r.definitionId === f.definitionId)
    && (!f.botId || r.context.botId === f.botId));
}
