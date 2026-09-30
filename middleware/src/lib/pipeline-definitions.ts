// The definition registry — what can run, derived from what already exists
// (docs/social-tenant-design.md §5.2, research §D.3, docs/pipelines-tenant-goal.md
// §P2).
//
// PURE. Source rows in, Definitions out: no express, no Aurora, no fixture
// import. providers/pipeline-definitions.ts reads the sources (the registered
// fixtures under dev:mock, the owning providers against Aurora) and hands them
// here, exactly as providers/pipeline-runs.ts does for lib/pipeline-runs.ts.
//
// FOUR PRODUCERS, ONE DEFINITION EACH:
//   every bot (agent_bots)                       → kind 'bot', id `bot:<uuid>`,
//       its cron / pr_watch trigger plus the manual fire every bot has;
//   every assessment command (AGENT_COMMANDS —   → kind 'assessment-command',
//       the accelerator's nine .claude/commands     id `assessment:<name>`;
//       mirrored as prompt documents)
//   every RUNBOOK candidate on the ladder         → kind 'runbook',
//       (providers/promotions.ts; a 'skill'          id `runbook:<candidate>`,
//       candidate is a runbook proposed for          its ordered steps read off
//       promotion, so it is one too)                 its observations;
//   every agent in the fleet registry             → kind 'agent', id `agent:<id>`.
// The ids are the ones the run projection already stamps on its Runs
// (`definitionId`), so a definition's runs are a filter, not a join table.
//
// RECORDED VERSIONS. `pipeline_definitions` holds what an author recorded over
// a derived definition — its version, owner and approver roles — and nothing a
// source already says. Merged by id: the source decides the steps and triggers,
// the recorded row decides the version and who approves. A recorded row whose
// source is gone is still listed (`orphaned`), never silently dropped.
//
// APPROVERS. Design §8: a definition that names no approver role is approved
// by an `operator` (the tenant default, which a pipeline-admin can change).
// `pipeline-admin` and the cross-tenant `admin` hold every operator authority.

import type { ContextTenant, DefinitionKind, PipelineRunStatus, TriggerType } from './pipeline-runs.js';
import { crosswalkStatus } from './pipeline-runs.js';

// ─── Source rows (structural — fixture rows and provider rows both fit) ─────

export interface BotDefinitionSource {
  id: string; name: string; prompt: string; model: string;
  trigger: string; cronExpr: string | null; enabled: boolean; requiresReview: boolean;
  orgProjectId: string | null; orgProjectName?: string | null; agentProjectRepo?: string | null;
  createdBy: string | null; pausedReason?: string | null; budgetPerRunUsd?: number | null;
}

export interface CommandDefinitionSource { name: string; summary: string; allowed_tools: string[] }

export interface RunbookObservationSource {
  id: string; kind: string; title: string; createdAt: string;
  initiativeId: string | null; repo: string | null; sessionId?: string;
}

export interface RunbookCandidateSource {
  id: string; title: string; rationale: string;
  proposedKind: string; status: string;
  observations: RunbookObservationSource[];
  driftedFrom?: string;
  dryRunRunId?: string | null;
}

export interface AgentDefinitionSource {
  id: string; name: string; model: string; tools: string[]; protocol?: string; status?: string;
}

/** A `pipeline_definitions` row — an author's recorded version of a definition. */
export interface StoredDefinition {
  id: string;
  contextTenant: ContextTenant;
  kind: DefinitionKind;
  title: string;
  owner: string | null;
  version: number;
  approverRoles: string[];
  sourceTable: string | null;
  sourceId: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface DefinitionSources {
  bots: readonly BotDefinitionSource[];
  commands: readonly CommandDefinitionSource[];
  runbooks: readonly RunbookCandidateSource[];
  agents: readonly AgentDefinitionSource[];
  stored: readonly StoredDefinition[];
}

// ─── The model ───────────────────────────────────────────────────────────────

export interface DefinitionStep { id: string; label: string; detail?: string | null }
export interface DefinitionTrigger { type: TriggerType; detail: string }

export type DefinitionSourceTable = 'agent_bots' | 'assessment_commands' | 'promotion_candidates' | 'agent_runtimes' | 'pipeline_definitions';

export interface Definition {
  id: string;
  /** The tenant that OWNS the definition — always this one. */
  tenant: 'pipelines';
  /** Whose data its runs act for (a bot's runs are orgiq's, a command's assessment's). */
  contextTenant: ContextTenant;
  kind: DefinitionKind;
  title: string;
  description: string | null;
  owner: string | null;
  version: number;
  source: { table: DefinitionSourceTable; id: string };
  steps: DefinitionStep[];
  triggers: DefinitionTrigger[];
  /** As recorded. Empty = the tenant default approver (see effectiveApproverRoles). */
  approverRoles: string[];
  /** A bot that is paused, a dismissed candidate: listed, but it will not run. */
  enabled: boolean;
  /** A `pipeline_definitions` row recorded a version of it. */
  recorded: boolean;
  /** Recorded, but the source it described is gone. */
  orphaned: boolean;
  /** Kind-specific facts the pages show: model, cron, initiative, promotion rung. */
  meta: Record<string, unknown>;
}

/** Design §8 — who approves when a definition names nobody. */
export const DEFAULT_APPROVER_ROLE = 'operator';
/** The roles an approver list may name: the pipelines roles that hold ApproveStep. */
export const APPROVER_ROLE_OPTIONS = ['operator', 'pipeline-admin'] as const;

export const definitionIdFor = {
  bot: (id: string) => `bot:${id}`,
  command: (name: string) => `assessment:${name}`,
  runbook: (candidateId: string) => `runbook:${candidateId}`,
  agent: (id: string) => `agent:${id}`,
};

/** The candidate a runbook definition id names, or null. */
export function candidateIdOf(definitionId: string): string | null {
  return definitionId.startsWith('runbook:') ? definitionId.slice('runbook:'.length) || null : null;
}

/** Candidates on the RUNBOOK rung: a runbook, or a runbook proposed for SKILL. */
export function isRunbookCandidate(c: Pick<RunbookCandidateSource, 'proposedKind'>): boolean {
  return c.proposedKind === 'runbook' || c.proposedKind === 'skill';
}

/** Which assessment agent runs a command — scoring tools mean the scorer. */
export function commandOwner(c: CommandDefinitionSource): string {
  return c.allowed_tools.some((t) => t === 'score_dimension' || t === 'classify_evidence')
    ? 'orgiq-assessment-scorer' : 'orgiq-assessment-drafter';
}

// ─── Per-producer derivation ─────────────────────────────────────────────────

function botTriggers(b: BotDefinitionSource): DefinitionTrigger[] {
  const out: DefinitionTrigger[] = [];
  if (b.trigger === 'cron') out.push({ type: 'schedule', detail: b.cronExpr ? `cron ${b.cronExpr}` : 'cron (no expression)' });
  if (b.trigger === 'pr_watch') out.push({ type: 'webhook', detail: `pull requests on ${b.agentProjectRepo ?? 'its repository'}` });
  // Every bot can be fired by hand (POST /api/bots/:id/run), whatever its standing trigger.
  out.push({ type: 'manual', detail: b.trigger === 'manual' ? 'fired by hand' : 'fired by hand, besides its schedule' });
  return out;
}

/** The queue loop a bot firing rides — the same step ids the projection writes. */
function botSteps(b: BotDefinitionSource): DefinitionStep[] {
  return [
    { id: 'trigger', label: 'Trigger fires', detail: b.trigger },
    { id: 'enqueue', label: 'Enqueued', detail: 'agent_jobs, behind the money brakes in lib/bot-runner.ts' },
    { id: 'claim', label: 'Claimed by a box' },
    { id: 'execute', label: 'Executed', detail: b.model },
    ...(b.requiresReview ? [{ id: 'review', label: 'Human review', detail: 'the job stops at awaiting_review' }] : []),
  ];
}

export function botDefinition(b: BotDefinitionSource): Definition {
  return {
    id: definitionIdFor.bot(b.id), tenant: 'pipelines', contextTenant: 'orgiq', kind: 'bot',
    title: b.name, description: b.prompt.split('\n')[0]?.slice(0, 240) || null,
    owner: b.createdBy, version: 1,
    source: { table: 'agent_bots', id: b.id },
    steps: botSteps(b), triggers: botTriggers(b),
    approverRoles: [], enabled: b.enabled, recorded: false, orphaned: false,
    meta: {
      model: b.model, trigger: b.trigger, cronExpr: b.cronExpr, requiresReview: b.requiresReview,
      initiativeId: b.orgProjectId, initiativeName: b.orgProjectName ?? null,
      repo: b.agentProjectRepo ?? null, pausedReason: b.pausedReason ?? null,
      budgetPerRunUsd: b.budgetPerRunUsd ?? null,
    },
  };
}

export function commandDefinition(c: CommandDefinitionSource): Definition {
  const owner = commandOwner(c);
  return {
    id: definitionIdFor.command(c.name), tenant: 'pipelines', contextTenant: 'assessment', kind: 'assessment-command',
    title: c.name, description: c.summary, owner, version: 1,
    source: { table: 'assessment_commands', id: c.name },
    // The steps the projection records for an assessment run.
    steps: [
      { id: 'launch', label: 'Launched', detail: 'POST /api/assessment/runs' },
      { id: 'execute', label: 'Executed', detail: `${owner} with ${c.allowed_tools.join(', ')}` },
      { id: 'write', label: 'Wrote outputs', detail: 'the run ledger; scores are applied by the BFF, never the agent' },
    ],
    triggers: [{ type: 'manual', detail: 'launched from the assessment workspace' }],
    approverRoles: [], enabled: true, recorded: false, orphaned: false,
    meta: { allowedTools: c.allowed_tools, promptDoc: `prompt:${c.name}.md` },
  };
}

const OBSERVATION_ROLE: Record<string, string> = {
  failed: 'Recognise', gotcha: 'Recognise', decision: 'Decide', worked: 'Apply', convention: 'Apply',
};

/** The runbook's ordered steps: its observations, oldest first, as the procedure was learned. */
export function runbookSteps(c: Pick<RunbookCandidateSource, 'observations'>): DefinitionStep[] {
  return [...c.observations]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((o) => ({ id: o.id, label: o.title, detail: OBSERVATION_ROLE[o.kind] ?? o.kind }));
}

/** The initiative most of a runbook's observations came from, or null — what the money brakes judge against. */
export function runbookInitiative(c: Pick<RunbookCandidateSource, 'observations'>): string | null {
  const counts = new Map<string, number>();
  for (const o of c.observations) if (o.initiativeId) counts.set(o.initiativeId, (counts.get(o.initiativeId) ?? 0) + 1);
  let best: string | null = null; let n = 0;
  for (const [id, k] of counts) if (k > n || (k === n && best !== null && id < best)) { best = id; n = k; }
  return best;
}

export function runbookDefinition(c: RunbookCandidateSource): Definition {
  return {
    id: definitionIdFor.runbook(c.id), tenant: 'pipelines', contextTenant: 'orgiq', kind: 'runbook',
    title: c.title, description: c.rationale, owner: null, version: 1,
    source: { table: 'promotion_candidates', id: c.id },
    steps: runbookSteps(c),
    triggers: [{ type: 'manual', detail: 'a dry-run started from Runbooks' }],
    approverRoles: [], enabled: c.status !== 'dismissed', recorded: false, orphaned: false,
    meta: {
      candidateId: c.id, proposedKind: c.proposedKind, candidateStatus: c.status,
      initiativeId: runbookInitiative(c), driftedFrom: c.driftedFrom ?? null,
      dryRunRunId: c.dryRunRunId ?? null, observationCount: c.observations.length,
    },
  };
}

export function agentDefinition(a: AgentDefinitionSource): Definition {
  const tenant: ContextTenant = /(^|-)assessment-/.test(a.id) ? 'assessment' : 'orgiq';
  return {
    id: definitionIdFor.agent(a.id), tenant: 'pipelines', contextTenant: tenant, kind: 'agent',
    title: a.name, description: null, owner: a.id, version: 1,
    source: { table: 'agent_runtimes', id: a.id },
    // A fleet invocation's steps are the STEP_* it emits (P1); what the
    // definition can say up front is the run and the tools it may call.
    steps: [
      { id: 'run', label: 'Invoked', detail: a.protocol ?? null },
      ...a.tools.map((t) => ({ id: `tool:${t}`, label: t, detail: 'tool the agent may call' })),
    ],
    triggers: [{ type: 'manual', detail: 'invoked from the portal, the supervisor or the gateway' }],
    approverRoles: [], enabled: a.status !== 'offline', recorded: false, orphaned: false,
    meta: { model: a.model, protocol: a.protocol ?? null, status: a.status ?? null, tools: a.tools },
  };
}

function orphanDefinition(s: StoredDefinition): Definition {
  return {
    id: s.id, tenant: 'pipelines', contextTenant: s.contextTenant, kind: s.kind,
    title: s.title, description: null, owner: s.owner, version: s.version,
    source: { table: 'pipeline_definitions', id: s.id },
    steps: [], triggers: [], approverRoles: s.approverRoles,
    enabled: false, recorded: true, orphaned: true,
    meta: { sourceTable: s.sourceTable, sourceId: s.sourceId },
  };
}

// ─── The registry ────────────────────────────────────────────────────────────

/**
 * Every source row → exactly one Definition (runbook candidates: those on the
 * RUNBOOK rung), each recorded version merged over its derived definition by
 * id, and each recorded row with no source listed as orphaned. Sorted by kind,
 * then title, so the catalog reads the same on every call.
 */
export function deriveDefinitions(src: DefinitionSources): Definition[] {
  const derived: Definition[] = [
    ...src.bots.map(botDefinition),
    ...src.commands.map(commandDefinition),
    ...src.runbooks.filter(isRunbookCandidate).map(runbookDefinition),
    ...src.agents.map(agentDefinition),
  ];
  const stored = new Map(src.stored.map((s) => [s.id, s]));
  const out: Definition[] = [];
  const seen = new Set<string>();
  for (const d of derived) {
    if (seen.has(d.id)) continue; // two source rows with one id: the first keeps it
    seen.add(d.id);
    const rec = stored.get(d.id);
    out.push(rec ? {
      ...d, version: rec.version, owner: rec.owner ?? d.owner,
      approverRoles: rec.approverRoles, recorded: true,
      meta: { ...d.meta, updatedBy: rec.updatedBy, updatedAt: rec.updatedAt },
    } : d);
  }
  for (const s of src.stored) if (!seen.has(s.id)) { seen.add(s.id); out.push(orphanDefinition(s)); }
  const rank: Record<DefinitionKind, number> = { runbook: 0, bot: 1, 'assessment-command': 2, agent: 3, compaction: 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

// ─── Approvers ───────────────────────────────────────────────────────────────

export function effectiveApproverRoles(
  def: Pick<Definition, 'approverRoles'> | null,
  defaultRole: string = DEFAULT_APPROVER_ROLE,
): { roles: string[]; defaulted: boolean } {
  const roles = def?.approverRoles?.filter(Boolean) ?? [];
  return roles.length > 0 ? { roles, defaulted: false } : { roles: [defaultRole], defaulted: true };
}

/** pipeline-admin holds every operator authority; admin holds every authority. */
export function canDecide(role: string | undefined, requiredRoles: readonly string[]): boolean {
  if (!role) return false;
  if (role === 'admin' || role === 'pipeline-admin') return true;
  return requiredRoles.includes(role);
}

export function validApproverRoles(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const allowed = APPROVER_ROLE_OPTIONS as readonly string[];
  const roles = [...new Set(v.map((r) => String(r)))];
  return roles.every((r) => allowed.includes(r)) ? roles : null;
}

// ─── Runs that originate here ────────────────────────────────────────────────

/** A `pipeline_runs` row. `id` is the projection's run id for its job. */
export interface PipelineRunRecord {
  id: string;
  definitionId: string;
  contextTenant: ContextTenant;
  runKind: string;
  status: PipelineRunStatus;
  jobId: string | null;
  triggeredBy: string | null;
  model: string | null;
  estimateUsd: number | null;
  costUsd: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const DRY_RUN_KIND = 'runbook:dry-run';
const TERMINAL: readonly PipelineRunStatus[] = ['completed', 'rejected', 'failed', 'cancelled'];
export const isTerminalRunStatus = (s: PipelineRunStatus): boolean => TERMINAL.includes(s);

/** A run record's status, read off its job — the crosswalk, not a second vocabulary. */
export function runStatusForJob(jobStatus: string): PipelineRunStatus {
  return crosswalkStatus(jobStatus);
}

/** The newest completed dry-run of a definition, else its newest dry-run, else null. */
export function latestDryRun(records: readonly PipelineRunRecord[], definitionId: string): PipelineRunRecord | null {
  const mine = records.filter((r) => r.definitionId === definitionId && r.runKind === DRY_RUN_KIND)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return mine.find((r) => r.status === 'completed') ?? mine[0] ?? null;
}

/** The dry-run prompt: walk the steps, change nothing, say PASS or FAIL. */
export function dryRunPrompt(def: Pick<Definition, 'id' | 'title' | 'version' | 'steps'>): string {
  const steps = def.steps.map((s, i) => `${i + 1}. ${s.detail ? `${s.detail}: ` : ''}${s.label}`).join('\n');
  return [
    `DRY RUN of runbook "${def.title}" (definition ${def.id}, v${def.version}).`,
    'Do not change files, open pull requests, or call anything that writes.',
    'For each step below, check whether it would apply in this workspace and say what you would do.',
    'End with PASS if every step could run as written, or FAIL and the step that could not.',
    '',
    steps || '(this runbook records no steps)',
  ].join('\n');
}

// ─── Approvals — pipeline.approval.requested, read off the existing gates ───

export interface ApprovalJobSource { id: string; title: string; status: string; finishedAt: string | null; boxId: string | null; createdBy: string | null }
export interface ApprovalChangeSource { id: string; runId: string | null; title: string; status: string; createdAt: string; repoFullName?: string | null; filesChanged?: number }
export interface ApprovalConsultSource { id: string; question: string; context: string | null; status: string; createdAt: string; boxId: string | null; repo: string | null; initiativeId: string | null }
export interface ApprovalRunRef { id: string; definitionId: string; status: string; context: { table: string; id: string; boxId?: string | null; title: string } }

export type ApprovalSource = 'agent_jobs' | 'agent_change_requests' | 'lab_consults';

export interface ApprovalRequest {
  /** `job:<id>` | `change:<id>` | `consult:<id>` — the id the decide route takes. */
  id: string;
  type: 'pipeline.approval.requested';
  source: ApprovalSource;
  sourceId: string;
  /** The projected run whose step asked, when one is known. */
  runId: string | null;
  stepId: string;
  definitionId: string | null;
  title: string;
  /** What is being asked — a consult's question, a review's summary. */
  question: string;
  detail: string | null;
  requestedAt: string | null;
  requiredRoles: string[];
  rolesDefaulted: boolean;
  contextTenant: ContextTenant;
  /** The existing path the decision is routed to — the tenant keeps no approval store. */
  decidedThrough: string;
}

export interface ApprovalSources {
  jobs: readonly ApprovalJobSource[];
  changes: readonly ApprovalChangeSource[];
  consults: readonly ApprovalConsultSource[];
  runs: readonly ApprovalRunRef[];
  definitions: readonly Pick<Definition, 'id' | 'approverRoles'>[];
  defaultRole?: string;
}

/**
 * Every step waiting on a person, as event-catalog `pipeline.approval.requested`:
 * a job stopped at `awaiting_review` (its `review` step), a change the policy
 * gates sent to `needs_approval` (its `gate` step) and a pending lab consult
 * (the running step that asked). Newest first.
 */
export function projectApprovals(src: ApprovalSources): ApprovalRequest[] {
  const defs = new Map(src.definitions.map((d) => [d.id, d]));
  const runById = new Map(src.runs.map((r) => [r.id, r]));
  const roles = (definitionId: string | null) => effectiveApproverRoles(definitionId ? defs.get(definitionId) ?? null : null, src.defaultRole);
  const out: ApprovalRequest[] = [];

  for (const j of src.jobs) {
    if (j.status !== 'awaiting_review') continue;
    const runId = `job:${j.id}`;
    const run = runById.get(runId);
    const definitionId = run?.definitionId ?? null;
    const r = roles(definitionId);
    out.push({
      id: `job:${j.id}`, type: 'pipeline.approval.requested', source: 'agent_jobs', sourceId: j.id,
      runId: run ? runId : null, stepId: 'review', definitionId,
      title: run?.context.title ?? j.title, question: 'Accept the work this job produced?',
      detail: j.boxId ? `ran on ${j.boxId}` : null, requestedAt: j.finishedAt,
      requiredRoles: r.roles, rolesDefaulted: r.defaulted, contextTenant: 'orgiq',
      decidedThrough: 'job review (POST /api/work/jobs/:id/review)',
    });
  }

  for (const c of src.changes) {
    if (c.status !== 'needs_approval') continue;
    const runId = c.runId ? `project-run:${c.runId}` : null;
    const run = runId ? runById.get(runId) : undefined;
    const definitionId = run?.definitionId ?? null;
    const r = roles(definitionId);
    out.push({
      id: `change:${c.id}`, type: 'pipeline.approval.requested', source: 'agent_change_requests', sourceId: c.id,
      runId: run ? runId : null, stepId: 'gate', definitionId,
      title: c.title, question: 'The policy gates require a person to approve this change before it is delivered.',
      detail: [c.repoFullName, typeof c.filesChanged === 'number' ? `${c.filesChanged} file(s)` : null].filter(Boolean).join(' · ') || null,
      requestedAt: c.createdAt, requiredRoles: r.roles, rolesDefaulted: r.defaulted, contextTenant: 'orgiq',
      decidedThrough: 'change decision (POST /api/sdlc/changes/:id/decide)',
    });
  }

  for (const k of src.consults) {
    if (k.status !== 'pending') continue;
    // The step that asked: the live job run on the box the consult came from.
    const run = k.boxId
      ? src.runs.find((x) => x.context.boxId === k.boxId && (x.status === 'running' || x.status === 'pending'))
      : undefined;
    const definitionId = run?.definitionId ?? null;
    const r = roles(definitionId);
    out.push({
      id: `consult:${k.id}`, type: 'pipeline.approval.requested', source: 'lab_consults', sourceId: k.id,
      runId: run?.id ?? null, stepId: 'execute', definitionId,
      title: k.question.length > 120 ? `${k.question.slice(0, 117)}…` : k.question,
      question: k.question, detail: k.context, requestedAt: k.createdAt,
      requiredRoles: r.roles, rolesDefaulted: r.defaulted, contextTenant: 'orgiq',
      decidedThrough: 'lab consult answer (POST /api/lab/consults/:id/answer)',
    });
  }

  return out.sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));
}

/** A consult is a question; an approval answers it with the decision and the note. */
export function consultAnswer(decision: 'approve' | 'reject', note: string | null | undefined): string {
  const head = decision === 'approve' ? 'Approved' : 'Rejected';
  const n = (note ?? '').trim();
  return n ? `${head} — ${n}` : head;
}
