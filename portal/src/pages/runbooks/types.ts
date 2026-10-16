// Wire shapes of /api/runbooks and /api/briefs (middleware/src/lib/runbooks/types.ts,
// routes/runbooks.ts, routes/session-briefs.ts). Declarations only.

export type ScopeKind = 'org' | 'initiative' | 'repo' | 'tool';
export interface RunbookScope { kind: ScopeKind; ref: string | null }
export type RunbookStatus = 'draft' | 'published' | 'retired';
export type HealthStatus = 'proven' | 'drifting' | 'unproven';
export interface RunbookHealth { status: HealthStatus; reason: string; warning: string | null }

export type RunbookFileMode = '644' | '755';
/** One file of a runbook's skill bundle. Content is untrusted: render as text only. */
export interface RunbookFile { path: string; content: string; mode: RunbookFileMode; sha256: string; size: number }
export interface RunbookFileManifestEntry { path: string; mode?: RunbookFileMode; sha256?: string | null; size?: number }
export type FilesDiffStatus = 'added' | 'deleted' | 'modified' | 'unchanged';
export interface FilesDiff {
  text: string; added: number; removed: number;
  files: Array<{ path: string; status: FilesDiffStatus; size: number; sha256: string | null }>;
}

export interface RunbookRow {
  id: string;
  scope: RunbookScope;
  owner_person_id: string;
  status: RunbookStatus;
  /** The initiative a cross-project skill came from; a label. */
  area?: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
  retired?: { at: string; by: string; reason: string; superseded_by: string | null };
  title: string;
  summary: string;
  sha256: string | null;
  health: RunbookHealth;
  open_proposals: number;
}

export type CommandLang = 'bash' | 'sql' | 'http' | 'text';
export interface RunbookCommand { lang: CommandLang; text: string }
export interface RunbookStep { do: string; command?: RunbookCommand; expect?: string; why?: string }
/** The stored document of one version (middleware/src/lib/runbooks/types.ts RunbookDoc). */
export interface RunbookDoc {
  title: string;
  summary: string;
  use_when: string[];
  not_for: string[];
  triggers: { work_item_labels: string[]; repos: string[]; tools: string[]; keywords: string[] };
  preconditions: string[];
  steps: RunbookStep[];
  verify: Array<{ check: string; command?: RunbookCommand }>;
  failure_modes: Array<{ symptom: string; cause: string; response: string }>;
  rollback: Array<{ do: string; command?: RunbookCommand }>;
  notes?: string;
}

export interface RunbookProvenance { run_refs: string[]; session_ids: string[]; lab_experience_ids: string[]; source_artifact_ids: string[] }

export interface RunbookVersion {
  runbook_id: string;
  version: number;
  markdown: string;
  sha256: string;
  author: { kind: 'person' | 'run' | 'migration'; id: string };
  proposal_id: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  provenance: RunbookProvenance;
  doc?: RunbookDoc;
  files?: RunbookFile[];
  bundle_sha256?: string;
}

export type ApplicationOutcome = 'followed' | 'followed_with_deviation' | 'failed' | 'not_used';
export interface RunbookApplication {
  id: string;
  runbook_id: string;
  version: number;
  run_ref: string;
  brief_id: string;
  outcome: ApplicationOutcome;
  failed_at_step: number | null;
  note: string | null;
  at: string;
}

export interface LintFinding { rule: string; severity: 'error' | 'warning'; path: string; message: string }

export interface Proposal {
  id: string;
  kind: 'new' | 'edit' | 'retire';
  runbook_id: string | null;
  base_version: number | null;
  proposed: RunbookDoc | null;
  /** A manifest (no content) in lists; the detail response carries the files. */
  proposed_files?: RunbookFileManifestEntry[];
  proposed_id?: string;
  rationale: string;
  source: { kind: 'run' | 'person'; run_ref?: string; session_id?: string; work_item_id?: string; person_id?: string; lab_experience_ids: string[] };
  lint: LintFinding[];
  similar: Array<{ runbook_id: string; score: number; reason: string }>;
  status: 'open' | 'accepted' | 'rejected' | 'merged';
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  merged_into: string | null;
  created_at: string;
}

export interface BriefSection { kind: string; ref: string | null; version?: number; tokens: number; reason: string }
export interface BriefOmission { runbook_id: string; reason: string }
export interface BriefSummary {
  id: string;
  run_ref: string;
  work_item_id: string | null;
  initiative_id: string | null;
  repo: string | null;
  assembled_at: string;
  assembler_version: string;
  budget_tokens: number;
  used_tokens: number;
  sections: BriefSection[];
  omitted: BriefOmission[];
  sha256: string;
}
export interface SkillLibrary { sha256: string; dir: string | null; skills: Array<{ name: string; version: number }> }
export interface Brief extends BriefSummary { markdown: string; skill_library?: SkillLibrary }
/** R8: one skill a brief's run received, at the version it received (GET /api/runs/:ref/brief `skills`). */
export interface BriefSkillDetail { name: string; version: number; title: string | null; description: string | null; current_version: number | null }
