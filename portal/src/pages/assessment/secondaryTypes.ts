// Wire shapes for the assessment tenant's SECONDARY pages (Submissions, Feedback,
// Reports, Runs/Activity, Configuration). Mirrors the source app's
// `agentic-assessment-accelerator/ui/src/components/{submissions,feedback,reports,runs,
// configuration}/types.ts`, trimmed to what these five pages actually render — see
// docs/assessment-tenant.md for the full domain model (Team, Assessment, DimensionScore,
// etc.), which lives in `./types.ts` and belongs to the primary Dashboard/Workspace pages.
//
// Deliberately a SEPARATE module from `./types.ts` — that file owns the certification
// domain model (Team/Dimension/TeamCertification) for the primary Dashboard build; this
// one owns the wire shapes the five secondary pages need and nothing else.
//
// The backend (`middleware/src/routes/assessment.ts`) is a stub as of this writing — every
// page here must degrade to EmptyState/LoadingState rather than crash on a missing or
// reshaped field. Nothing below is trusted blindly; see secondaryFormat.ts for the guards.

// ─── Teams (just enough to label rows and populate a team picker) ─────────────

export type SecondaryCohort = 'white_glove' | 'self_service' | 'general';

export interface TeamOption {
  id: string;
  name: string;
  cohort?: SecondaryCohort;
}

// ─── Submissions ────────────────────────────────────────────────────────────

export type RowStatus = 'new' | 'seen' | 'unknown_team';

export interface ParsedRow {
  row_index: number;
  form_id: string;
  status: RowStatus;
  team_id: string | null;
  team_name_raw: string;
  submitter_name: string;
  submitter_email: string;
  submitted_at: string;
  self_certified: boolean;
  dimensions_informed: number;
  links: { url: string; label: string; dimension_id: string | null }[];
}

export interface ParseResponse {
  staging_token: string;
  source_file: string;
  mapping_warnings: string[];
  rows: ParsedRow[];
}

export interface CommitSelection {
  row_index: number;
  team_id: string;
}

export interface CommitResultRow {
  row_index: number;
  team_id: string;
  envelope_id: string;
  links: { url: string; label: string; dimension_id: string | null; status: LinkStatus }[];
  skipped?: boolean;
  reason?: string;
}

export interface CommitResponse {
  results: CommitResultRow[];
  /** Envelope ids committed, in selection order — the same list `results`
   * derives from client-side; kept for parity with the legacy team_id/envelope_ids
   * commit shape, which returns only this field. */
  committed?: string[];
}

export type LinkStatus = 'pending' | 'fetched' | 'skipped';

export interface SubmissionListItem {
  envelope_id: string;
  team_id: string;
  team_name_raw: string;
  submitter_name: string;
  submitted_at: string;
  ingested_at: string;
  links_pending: number;
  links_total: number;
  scored: boolean;
  form_id: string | null;
  // Revision grouping — optional on the wire, mirroring the source app's
  // listing.py `_group_rows`. Absent on an older/simpler backend build, in
  // which case `groupSubmissions` derives the same grouping from the rows.
  group_id?: string;
  revision?: number;
  revision_count?: number;
  is_latest?: boolean;
  superseded_by?: string | null;
}

export interface SubmissionsSummary {
  total: number;
  teams: number;
  distinct_submissions?: number;
  distinct_unprocessed?: number;
  links_pending_total: number;
  last_ingested_at: string | null;
}

export interface SubmissionGroupRef {
  group_id: string;
  team_id: string;
  team_name_raw: string;
  form_id: string | null;
  envelope_ids: string[];
  processed: boolean;
}

/** `GET /api/assessment/submissions` — the wire shape. Envelopes are the
 *  source app's Forms-export envelopes; `groups` fold revisions of one
 *  submission. The page reads neither directly: `envelopesToListItems` in
 *  secondaryFormat.ts is the one place the wire shape meets the list model. */
export interface ApiSubmissionEnvelope {
  envelope_id: string;
  team_id: string;
  team_name_raw: string;
  submitter?: { name?: string; email?: string } | null;
  submitted_at: string;
  ingested_at: string;
  status: string;
  revision?: number | string;
  supersedes?: string | null;
  source?: { form_submission_id?: string | number | null } | null;
  links?: Array<{ status?: string }>;
}
export interface SubmissionsListResponse {
  envelopes: ApiSubmissionEnvelope[];
  groups?: Array<{ base_id: string; team_id: string; revisions: number; latest_envelope_id: string; status: string }>;
}

/** One submission as the list renders it — the current revision plus whatever
 * earlier revisions it superseded. See secondaryFormat.ts `groupSubmissions`. */
export interface SubmissionRevisionGroup {
  key: string;
  teamId: string;
  /** The matched team's real name when `teamId` resolves against the roster;
   *  falls back to the submitter's own text (`team_name_raw`) when it doesn't
   *  (still unmatched, or matched to a team that no longer exists). See
   *  `resolveTeamName` in secondaryFormat.ts. */
  teamName: string;
  /** The submitter's own team-name text, kept ONLY when it differs from a
   *  genuine `teamName` match — null when there's nothing extra to say
   *  (no match yet, or the submitted text already matches). Render as
   *  secondary text ("submitted as …"), never in place of `teamName`. */
  submittedTeamName: string | null;
  formId: string | null;
  current: SubmissionListItem;
  superseded: SubmissionListItem[];
  revisionCount: number;
  processed: boolean;
}

// ─── Feedback (HITL follow-up queue) ────────────────────────────────────────

export type HitlStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED';

// The wire shape is the middleware mock's FeedbackTask: the key is `task_id`,
// and title/source/resolved_by are not sent. The page once read `task.id`,
// so every Resolve/Dismiss POSTed to /feedback/undefined/… and 404'd.
export interface FeedbackTask {
  task_id: string;
  created_at: string;
  source?: string | null;
  team_id: string | null;
  team_name?: string | null;
  dimension_id: string | null;
  dimension_title?: string | null;
  kind: string;
  title?: string | null;
  question: string;
  status: HitlStatus;
  response: string | null;
  resolved_at: string | null;
  resolved_by?: string | null;
}

export interface FeedbackListResponse {
  tasks: FeedbackTask[];
}

// ─── Reports / recommendations ──────────────────────────────────────────────

/** The three, and only three, recommendation kinds — never re-derived, never a grade. */
export type SecondaryRecommendationKind = 'close_claim' | 'advance' | 'answer';

export const RECOMMENDATION_KIND_LABEL: Record<SecondaryRecommendationKind, string> = {
  close_claim: 'Close the claim',
  advance: 'Advance the practice',
  answer: 'Answer the question',
};

export interface Recommendation {
  kind: SecondaryRecommendationKind;
  dimension_id: string;
  dimension_title: string;
  rank: number;
  headline: string;
  team_id: string;
  team_name: string;
}

/** `GET /api/assessment/recommendations` — one group per team: the kind counts
 *  and the single top-ranked entry, ranked by the server. Never re-order here. */
export interface RecommendationTeamGroup {
  id: string;
  name: string;
  cohort: string;
  counts: Partial<Record<SecondaryRecommendationKind, number>> & Record<string, number>;
  top: {
    dimension_id: string;
    title: string;
    kind: SecondaryRecommendationKind;
    headline?: string;
    summary?: string;
  } | null;
}
export interface RecommendationsResponse {
  generated_at: string;
  teams: RecommendationTeamGroup[];
  skipped: Array<{ id: string; reason: string }>;
}

/** `GET /api/assessment/rollup` — the program-wide numbers, by cohort. Mirrors the
 *  middleware provider's RollupResponse; there are no per-team rows here — the
 *  per-team table on Reports reads the roster (`/teams`) instead. */
export interface RollupCohort {
  teams: number;
  at_or_above_target: number;
  assessed: number;
  applicable: number;
}
export interface RollupResponse {
  target_level: number;
  teams_total: number;
  dimensions_assessed: number;
  dimensions_applicable: number;
  at_or_above_target: number;
  claims_open: number;
  by_cohort: Record<string, RollupCohort>;
  generated_at: string;
}

// ─── Runs / agent commands ───────────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed';

export interface RunProgress {
  phase?: string;
  detail?: string;
}

export interface RunRecord {
  id: string;
  command: string;
  team_id: string | null;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  summary?: string | null;
  error?: string | null;
  progress?: RunProgress | null;
}

export interface RunsListResponse {
  runs: RunRecord[];
}

/** `GET /api/assessment/agent/commands` — one row per launchable command, in the
 *  source registry's own vocabulary (`sdlcd/workflows/agent_runs/registry.py`). */
export interface AgentCommand {
  name: string;
  summary: string;
  /** The tool allowlist this command runs under. This list IS the security
   * boundary (docs/assessment-tenant.md "Agentic support"), so it is always
   * shown, never hidden behind a tooltip or collapsed section. */
  allowed_tools: string[];
}

export interface AgentCommandsResponse {
  commands: AgentCommand[];
}

export interface LaunchRunResponse {
  run_id: string;
  started_at: string;
}

// ─── Configuration ───────────────────────────────────────────────────────────

// The wire's MotionConfig: keyed by `cohort`, never by an invented `key` —
// PUT /configuration validates every motion for `cohort`, so a page that
// sent `key` instead could render (with a missing-key warning) but never save.
export interface SecondaryMotionConfig {
  cohort: 'white_glove' | 'self_service' | 'general';
  title: string;
  tag: string;
  accent: string;
  /** Round-tripped untouched on save; the config page doesn't edit it. */
  description: string;
}

export interface AssessmentConfiguration {
  motions: SecondaryMotionConfig[];
  /** Matches the middleware's key — the page once used `certification_target_level`,
   *  read undefined, and showed Level 1 while the rollup said 3. */
  target_level: number;
}
