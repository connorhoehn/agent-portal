// Wire shapes of /api/runbooks and the brief reads (middleware/src/lib/runbooks/types.ts,
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
  /** Set when a retired runbook was brought back by an accepted restore proposal. */
  restored?: { at: string; by: string; reason: string };
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
  /** Set on a version a simulated run produced (the mock's hand-written runbook); pages say "Demo data". */
  demo_data?: boolean;
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
  kind: 'new' | 'edit' | 'retire' | 'restore';
  runbook_id: string | null;
  base_version: number | null;
  proposed: RunbookDoc | null;
  /** A manifest (no content) in lists; the detail response carries the files. */
  proposed_files?: RunbookFileManifestEntry[];
  proposed_id?: string;
  rationale: string;
  /** `system` is the library's own upkeep (a retire proposal filed when a report was saved). `dispatched_by` is a run proposal's accountable person. */
  source: { kind: 'run' | 'person' | 'system'; run_ref?: string; session_id?: string; work_item_id?: string; person_id?: string; dispatched_by?: string; lab_experience_ids: string[] };
  /** A run's new runbook is scoped to the run's repository or initiative, never the organisation. */
  proposed_scope?: RunbookScope;
  /** A run proposal nobody decided in fourteen days reads as expired until the next report withdraws it. */
  expired?: boolean;
  /** Set when the debrief behind it was simulated (the mock). */
  debrief?: { simulated?: boolean; converted_from_new?: boolean };
  /** A retire proposal's evidence: the rule, the runs that made it due and the model they ran on. */
  retire_evidence?: { rule: 'unfollowed' | 'disuse-unfollowed' | 'disuse-ungiven'; run_refs: string[]; model: string | null };
  /** Why a withdrawn proposal closed: nobody decided it in time, or the change it carried was rejected. */
  closed_reason?: 'expired' | 'change-rejected' | null;
  /** Set when the run's own dispatcher decided it because nobody else could (decision 11). */
  decided_as?: 'sole-reviewer-dispatcher' | null;
  lint: LintFinding[];
  similar: Array<{ runbook_id: string; score: number; reason: string }>;
  status: 'open' | 'accepted' | 'rejected' | 'merged' | 'withdrawn';
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
  /** The task the brief's "Your task" line names; null when it has none (absent from an older server). */
  task_title?: string | null;
}
export interface SkillLibrary { sha256: string; dir: string | null; skills: Array<{ name: string; version: number }> }
/** Assembler v3: one runbook a run was given as text, with the reason it was chosen (middleware lib/runbooks/types.ts BriefOfferedRunbook). */
export interface BriefOfferedRunbook {
  id: string; version: number; title: string; reason: string; pinned: boolean;
  health: 'proven' | 'drifting' | 'unproven'; warning: string | null;
}
/** What a run was offered; `runbooks` empty is a result, and `none_reason` says why. */
export interface BriefOffer { runbooks: BriefOfferedRunbook[]; none_reason: string | null }
export interface BriefAttemptRef { run_ref: string; outcome: 'done' | 'failed' | 'cancelled' | 'needs-review'; failure_code: string | null; ended_at: string }
/** An earlier attempt in full, as the brief preview returns it (`previous_attempts`). */
export interface BriefPreviousAttempt extends BriefAttemptRef { summary: string; obstacles: string[]; requested_changes: string | null }
export interface Brief extends BriefSummary {
  markdown: string; skill_library?: SkillLibrary;
  /** v3 briefs only. */
  offer?: BriefOffer;
  previous_attempts?: BriefAttemptRef[];
}
/** GET /api/work-items/:id/brief-preview. */
export interface BriefPreviewResponse {
  brief: Brief; stored: false; skills?: BriefSkillDetail[];
  offer: BriefOffer; pins: string[]; previous_attempts: BriefPreviousAttempt[];
  /** In-scope runbooks the selector or the brief's limits passed over, each with a reason in words. */
  passed_over?: PassedOverRunbook[];
}
export interface PassedOverRunbook { id: string; name: string; kind: 'no_match' | 'limit' | 'budget' | 'drifting_excluded'; reason: string }
/** R8: one skill a brief's run received, at the version it received (GET /api/runs/:ref/brief `skills`). */
export interface BriefSkillDetail { name: string; version: number; title: string | null; description: string | null; current_version: number | null }

/** GET /api/runbooks/evidence (middleware lib/runbooks/evidence.ts LoopEvidence): the loop over 30 days, counted from run reports. */
export interface LoopEvidence {
  windowDays: number;
  since: string;
  runs: number;
  runsGiven: number;
  runsSaidFollowed: number;
  runsSaidFollowedDone: number;
  proposalsFromRuns: { total: number; open: number; accepted: number; rejected: number; merged: number; withdrawn: number };
  runbooks: Array<{ runbookId: string; given: number; saidFollowed: number; followedDone: number }>;
}

export type Followed = 'yes' | 'partly' | 'no' | 'unsaid';
export type RunOutcome = 'done' | 'failed' | 'cancelled' | 'needs-review';
export interface SideFigures { runs: number; medianDurationS: number | null; meanCostUsd: number | null; costRuns: number }
export type EvidenceComparison =
  | { available: true; withRunbook: SideFigures; withoutRunbook: SideFigures; sharedLabels: string[] }
  | { available: false; reason: string; withRunbookRuns: number; withoutRunbookRuns: number };
/** GET /api/runbooks/:id/evidence: one runbook over 30 days. */
export interface RunbookEvidence {
  runbookId: string;
  windowDays: number;
  since: string;
  given: number;
  followed: Record<Followed, number>;
  loaded: number;
  outcomes: Record<RunOutcome, number>;
  followedDone: number;
  runs: Array<{ runRef: string; workItemId: string | null; endedAt: string; outcome: RunOutcome; version: number | null; followed: Followed; loaded: boolean }>;
  comparison: EvidenceComparison;
}
/** GET /api/runs/:ref/report, the part a proposal's review shows beside the runbook. */
export interface RunReportLite {
  runRef: string;
  summary: string;
  obstacles: string[];
  learned: string;
  outcome: RunOutcome;
  debrief?: { simulated?: boolean } | null;
}
