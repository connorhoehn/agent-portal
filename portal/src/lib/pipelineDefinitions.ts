// The pipelines tenant's definitions, runbooks and approvals as the portal
// reads them — the wire shape of middleware/src/lib/pipeline-definitions.ts
// (served by /api/pipelines/definitions, /runbooks, /approvals) and the labels
// the Definitions, Runbooks, Approvals and Sources pages share.
//
// Pure, no React, so pages/pipelines/__tests__ runs it under plain `node --test`.

import type { DefinitionKind, PipelineRunStatus } from './pipelineRuns.ts';

export interface DefinitionStep { id: string; label: string; detail?: string | null }
export interface DefinitionTrigger { type: 'manual' | 'schedule' | 'webhook' | 'document-event'; detail: string }

export interface RunDigest { id: string; status: PipelineRunStatus; startedAt: string | null }

export interface PipelineDefinition {
  id: string;
  tenant: 'pipelines';
  contextTenant: 'orgiq' | 'assessment';
  kind: DefinitionKind;
  title: string;
  description: string | null;
  owner: string | null;
  /** The owner as a name (a person, or the agent that runs it). */
  ownerName?: string | null;
  version: number;
  source: { table: string; id: string };
  steps: DefinitionStep[];
  triggers: DefinitionTrigger[];
  approverRoles: string[];
  enabled: boolean;
  recorded: boolean;
  orphaned: boolean;
  meta: Record<string, unknown>;
  runCount: number;
  lastRun: RunDigest | null;
  effectiveApproverRoles: string[];
  approversDefaulted: boolean;
}

export interface DryRunRecord {
  id: string;
  definitionId: string;
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

export interface RunbookState {
  candidateId: string;
  proposedKind: string | null;
  candidateStatus: string | null;
  dryRunRunId: string | null;
  lastDryRun: DryRunRecord | null;
  dryRunCount: number;
  promotionToSkill: { ok: true; runId: string } | { ok: false; reason: string };
}

export interface RunbookRow extends PipelineDefinition { runbook: RunbookState }

export interface DefinitionsResponse {
  definitions: PipelineDefinition[];
  total: number;
  unavailable: Array<{ source: string; error: string }>;
  defaultApproverRole: string;
}

export interface ApprovalRequest {
  id: string;
  type: 'pipeline.approval.requested';
  source: 'agent_jobs' | 'agent_change_requests' | 'lab_consults';
  sourceId: string;
  runId: string | null;
  stepId: string;
  definitionId: string | null;
  title: string;
  question: string;
  detail: string | null;
  requestedAt: string | null;
  requiredRoles: string[];
  rolesDefaulted: boolean;
  contextTenant: string;
  decidedThrough: string;
}

/** Which definition kinds each Sources page lists (design §5.3: the three producers). */
export const SOURCE_KINDS = { agents: 'agent', bots: 'bot', commands: 'assessment-command' } as const;
export type SourcePageId = keyof typeof SOURCE_KINDS;

export const DEFINITION_KIND_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any kind' },
  { value: 'runbook', label: 'Runbook' },
  { value: 'bot', label: 'Bot' },
  { value: 'assessment-command', label: 'Assessment command' },
  { value: 'agent', label: 'Agent' },
];

const TRIGGER_LABEL: Record<DefinitionTrigger['type'], string> = {
  manual: 'Manual', schedule: 'Schedule', webhook: 'Webhook', 'document-event': 'Document event',
};

/** "Schedule · Manual" — the trigger types, in the order the definition lists them. */
export function triggerSummary(triggers: readonly DefinitionTrigger[]): string {
  return triggers.length ? triggers.map((t) => TRIGGER_LABEL[t.type] ?? t.type).join(' · ') : 'none';
}

const ROLE_LABEL: Record<string, string> = { operator: 'Operator', 'pipeline-admin': 'Pipeline admin' };
export const roleLabel = (r: string): string => ROLE_LABEL[r] ?? r;

/** "Operator (default)" when the definition names nobody — design §8. */
export function approverSummary(roles: readonly string[], defaulted: boolean): string {
  const names = roles.map(roleLabel).join(' or ') || 'Operator';
  return defaulted ? `${names} (default)` : names;
}

/** The client mirror of the server's canDecide — pipeline-admin and admin decide anything. */
export function canDecide(role: string | null | undefined, requiredRoles: readonly string[]): boolean {
  if (!role) return false;
  if (role === 'admin' || role === 'pipeline-admin') return true;
  return requiredRoles.includes(role);
}

const APPROVAL_SOURCE_LABEL: Record<ApprovalRequest['source'], string> = {
  agent_jobs: 'Job review', agent_change_requests: 'Change gate', lab_consults: 'Agent question',
};
export const approvalSourceLabel = (s: string): string => APPROVAL_SOURCE_LABEL[s as ApprovalRequest['source']] ?? s;

/** The ladder rung, in words: "Runbook proposed as a skill · approved". */
export function rungLabel(state: Pick<RunbookState, 'proposedKind' | 'candidateStatus'>): string {
  const rung = state.proposedKind === 'skill' ? 'Proposed as a skill' : 'Runbook';
  return state.candidateStatus && state.candidateStatus !== 'candidate' ? `${rung} · ${state.candidateStatus}` : rung;
}

/** Rule 1, in words: can this runbook become a skill on its dry-run? */
export function promotionVerdict(state: Pick<RunbookState, 'promotionToSkill' | 'proposedKind' | 'candidateStatus'>): { tone: 'success' | 'warning' | 'neutral'; label: string; detail: string } {
  if (state.candidateStatus === 'promoted') return { tone: 'neutral', label: 'Already a skill', detail: 'Promoted before this ledger recorded dry-runs.' };
  if (state.promotionToSkill.ok) return { tone: 'success', label: 'Dry-run passed', detail: `Completed run ${state.promotionToSkill.runId} backs a promotion to skill.` };
  return { tone: 'warning', label: 'Needs a completed dry-run', detail: state.promotionToSkill.reason };
}

/** A definition's page URL — the record beside the catalog's list rail. */
export function definitionHref(id: string): string {
  return `/pipelines/definitions/${encodeURIComponent(id)}`;
}

/** Whether a Dry-run button belongs on this definition. */
export function canDryRun(def: Pick<PipelineDefinition, 'kind' | 'enabled'>): boolean {
  return def.kind === 'runbook' && def.enabled;
}

/** Say which brakes a dry-run passed, for the toast. */
export function brakesNote(brakes: readonly string[]): string {
  return brakes.length ? `Brakes: ${brakes.join('; ')}.` : '';
}

/** The catalog search: title, id, owner and description, case-insensitive. Empty matches all. */
export function matchesDefinition(def: Pick<PipelineDefinition, 'title' | 'id' | 'owner' | 'description'> & { ownerName?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [def.title, def.id, def.owner ?? '', def.ownerName ?? '', def.description ?? ''].some((v) => v.toLowerCase().includes(q));
}
