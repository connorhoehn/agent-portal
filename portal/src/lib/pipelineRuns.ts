// The pipeline run model as the portal reads it — the wire shape of
// middleware/src/lib/pipeline-runs.ts (the run projection) and the labels and
// tones every run surface shares: the pipelines tenant's Runs / run detail /
// Artifacts pages and the orgiq bot detail page, which reads the same Runs
// through the /api/runs façade.
//
// Pure, no React and no imports, so pages/pipelines/__tests__ runs it under
// plain `node --test`.

/** pipeline-runtime's nine (middleware `PIPELINE_RUN_STATUSES`). */
export const PIPELINE_RUN_STATUSES = [
  'pending', 'running', 'awaiting_approval', 'paused_at_breakpoint',
  'completed', 'rejected', 'failed', 'cancelled', 'stuck',
] as const;
export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];
export type PipelineStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped';
export type DefinitionKind = 'runbook' | 'agent' | 'bot' | 'assessment-command';
export type ArtifactKind = 'change' | 'document' | 'scores' | 'trace' | 'transcript' | 'image';

export interface RunSourceRef { table: string; id: string; status: string; role: 'primary' | 'trigger' | 'child' }

export interface PipelineRun {
  id: string;
  definitionId: string;
  tenant: string;
  status: PipelineRunStatus;
  triggeredBy: string | null;
  /** The person behind `triggeredBy`, when it is a known account. */
  triggeredByName?: string;
  /** Who owns the definition the run executes. */
  ownerName?: string | null;
  triggerType: string;
  startedAt: string | null;
  finishedAt: string | null;
  costUsd: number | null;
  context: {
    tenant: string;
    kind: DefinitionKind;
    table: string;
    id: string;
    sourceStatus: string;
    sources: RunSourceRef[];
    title: string;
    botId?: string | null;
    projectId?: string | null;
    workItemId?: string | null;
    boxId?: string | null;
    trigger?: string | null;
    error?: string | null;
    /** Agent runs (P1): the AG-UI run id, its thread (session), the agent. */
    aguiRunId?: string | null;
    threadId?: string | null;
    agentId?: string | null;
    /** The initiative the run acts for, when a name is known. */
    initiativeName?: string | null;
  };
}

/** One attempt on a step. On an agent run it is a tool call (TOOL_CALL_START…RESULT). */
export interface PipelineStepAttempt {
  attempt: number;
  status: PipelineStepStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  label?: string;
  toolCallId?: string;
}

export interface PipelineStep {
  runId: string;
  stepId: string;
  label: string;
  status: PipelineStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: PipelineStepAttempt[];
  detail?: string | null;
}

export interface PipelineArtifact {
  id: string;
  runId: string | null;
  stepId: string | null;
  kind: ArtifactKind;
  uri: string;
  title: string;
  createdAt: string | null;
  meta: Record<string, unknown>;
  runTitle?: string | null;
  runStatus?: PipelineRunStatus | null;
  contextTenant?: string | null;
}

export interface RunListResponse {
  runs: PipelineRun[];
  total: number;
  limit: number;
  offset: number;
  unavailable: Array<{ table: string; error: string }>;
  /** Rows recorded but in no run — agent traces with no AG-UI run id. Counted, not dropped. */
  unlinked?: { invocation_traces: number };
}

/** The honest line for traces no run claims, or null when there are none. */
export function unlinkedNote(unlinked: RunListResponse['unlinked']): string | null {
  const n = unlinked?.invocation_traces ?? 0;
  if (n <= 0) return null;
  return `${n} agent trace${n === 1 ? ' carries' : 's carry'} no run id (sub-agent or scheduled calls) — recorded, not shown as runs`;
}

/**
 * What a step's attempts were. An agent run's attempts are named tool calls,
 * so they read as the tools; any other run's are numbered retries, so the
 * count is what matters.
 */
export function attemptItems(step: Pick<PipelineStep, 'attempts'>): Array<{ key: string; label: string; status: PipelineStepStatus }> {
  if (!step.attempts.some((a) => a.label)) {
    const last = step.attempts[step.attempts.length - 1];
    return last ? [{ key: `n${last.attempt}`, label: `attempt ${last.attempt}`, status: last.status }] : [];
  }
  return step.attempts.map((a) => ({ key: a.toolCallId ?? `n${a.attempt}`, label: a.label ?? `attempt ${a.attempt}`, status: a.status }));
}

/** The Chip tones this model uses — a subset of the library's ChipTone. */
export type RunTone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger';

const RUN_CHIP: Record<PipelineRunStatus, { tone: RunTone; label: string }> = {
  pending: { tone: 'neutral', label: 'pending' },
  running: { tone: 'accent', label: 'running' },
  awaiting_approval: { tone: 'warning', label: 'awaiting approval' },
  paused_at_breakpoint: { tone: 'warning', label: 'paused' },
  completed: { tone: 'success', label: 'completed' },
  rejected: { tone: 'danger', label: 'rejected' },
  failed: { tone: 'danger', label: 'failed' },
  cancelled: { tone: 'neutral', label: 'cancelled' },
  stuck: { tone: 'warning', label: 'stuck' },
};

/** Tone + label for a run status; an unknown one reads neutral, verbatim. */
export function runStatusChip(status: string): { tone: RunTone; label: string } {
  return RUN_CHIP[status as PipelineRunStatus] ?? { tone: 'neutral', label: status.replace(/_/g, ' ') };
}

const STEP_CHIP: Record<PipelineStepStatus, { tone: RunTone; label: string }> = {
  pending: { tone: 'neutral', label: 'pending' },
  running: { tone: 'accent', label: 'running' },
  awaiting_approval: { tone: 'warning', label: 'awaiting approval' },
  completed: { tone: 'success', label: 'completed' },
  failed: { tone: 'danger', label: 'failed' },
  skipped: { tone: 'neutral', label: 'skipped' },
};

export function stepStatusChip(status: string): { tone: RunTone; label: string } {
  return STEP_CHIP[status as PipelineStepStatus] ?? { tone: 'neutral', label: status.replace(/_/g, ' ') };
}

/** Source statuses the crosswalk renames without changing their meaning. */
const SAME_MEANING = new Set(['queued', 'claimed', 'running', 'done', 'succeeded', 'completed', 'failed', 'cancelled']);

/**
 * The crosswalk is lossy on purpose (research §D.4's risk): a skipped bot
 * firing reads `cancelled`, a blocked change `rejected`, a job awaiting review
 * `awaiting approval`. Where the pipeline word changes what the source MEANT,
 * a surface says what the source recorded; a mere rename (done → completed)
 * says nothing, because a note on every row is a note nobody reads.
 */
export function sourceStatusNote(run: Pick<PipelineRun, 'status' | 'context'>): string | null {
  const src = run.context.sourceStatus;
  if (!src || src === run.status || SAME_MEANING.has(src)) return null;
  return `source status: ${src.replace(/_/g, ' ')}`;
}

const KIND_LABEL: Record<DefinitionKind, string> = {
  runbook: 'Runbook', agent: 'Agent', bot: 'Bot', 'assessment-command': 'Assessment command',
};
export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as DefinitionKind] ?? kind;
}

const TABLE_LABEL: Record<string, string> = {
  agent_jobs: 'queue job', bot_runs: 'bot firing', agent_project_runs: 'governed run',
  assessment_runs: 'assessment run',
  invocation_traces: 'agent trace',
};
export function sourceLabel(table: string): string {
  return TABLE_LABEL[table] ?? table;
}

const ARTIFACT_LABEL: Record<ArtifactKind, string> = {
  change: 'Change', document: 'Document', scores: 'Scores', trace: 'Trace', transcript: 'Transcript', image: 'Image',
};
export function artifactKindLabel(kind: string): string {
  return ARTIFACT_LABEL[kind as ArtifactKind] ?? kind;
}

/**
 * The library WorkflowStepper's shape: a step is `done` once completed or
 * skipped, and the ONE `active` step is the first that is not — the step a
 * reader should look at (it carries `aria-current="step"`). A run whose every
 * step is done has no active step.
 */
export function stepperSteps(steps: readonly PipelineStep[]): Array<{ step: number; label: string; done: boolean; active: boolean }> {
  const activeIdx = steps.findIndex((s) => s.status !== 'completed' && s.status !== 'skipped');
  return steps.map((s, i) => ({
    step: i + 1,
    label: s.label,
    done: s.status === 'completed' || s.status === 'skipped',
    active: i === activeIdx,
  }));
}

/** A run's URL-safe id segment (ids are `<table-prefix>:<source id>`). */
export function runHref(base: string, id: string): string {
  return `${base}/${encodeURIComponent(id)}`;
}

/** Filter options for the Runs table — the nine statuses, in order. */
export const STATUS_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any status' },
  ...PIPELINE_RUN_STATUSES.map((s) => ({ value: s, label: RUN_CHIP[s].label })),
];

export const KIND_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any kind' },
  ...(['bot', 'agent', 'assessment-command'] as DefinitionKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] })),
];

export const TENANT_FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any workspace' },
  { value: 'orgiq', label: 'Work' },
  { value: 'assessment', label: 'Assessment' },
];

/** The query string the Runs page sends; empty filters are omitted. */
export function runsQuery(f: { status?: string; kind?: string; contextTenant?: string; limit?: number; offset?: number }): string {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status);
  if (f.kind) q.set('kind', f.kind);
  if (f.contextTenant) q.set('contextTenant', f.contextTenant);
  if (f.limit) q.set('limit', String(f.limit));
  if (f.offset) q.set('offset', String(f.offset));
  const s = q.toString();
  return s ? `?${s}` : '';
}
