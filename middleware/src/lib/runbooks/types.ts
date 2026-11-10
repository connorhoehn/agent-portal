// The runbook model: the types every
// later lane builds to — the stores (R1), the migration (R2), the API (R3),
// injection (R4) and the portal (R5). Pure declarations; nothing here does I/O.
//
// A runbook is a markdown procedure a person would hand a new colleague, and
// the exact text a box receives. It is stored as a RunbookDoc and rendered to
// ONE canonical markdown (render.ts); that markdown parses back to the same
// doc (parse.ts), exactly.

export type CommandLang = 'bash' | 'sql' | 'http' | 'text';
export const COMMAND_LANGS: readonly CommandLang[] = ['bash', 'sql', 'http', 'text'];

export interface RunbookCommand {
  lang: CommandLang;
  /** Verbatim, may span lines; never ends with a newline. */
  text: string;
}

export interface RunbookStep {
  /** One imperative sentence ("Add the Cognito callback for this tenant's origin to its app client."). */
  do: string;
  command?: RunbookCommand;
  /** What you should see. */
  expect?: string;
  /** Optional, one sentence. */
  why?: string;
}

export interface RunbookTriggers {
  work_item_labels: string[];
  repos: string[];
  tools: string[];
  keywords: string[];
}

/** The stored document — one per version. Every string field except `notes` and command text is a single line. */
export interface RunbookDoc {
  /** Imperative: "Cut one tenant over from SAML to Cognito". */
  title: string;
  /** One sentence, ≤ 200 chars. */
  summary: string;
  /** Situations, in words. */
  use_when: string[];
  /** Near-misses that need a different runbook. */
  not_for: string[];
  /** Machine-matchable selection hints (select.ts). */
  triggers: RunbookTriggers;
  /** Checkable statements, each rendered as a "- [ ]" line. */
  preconditions: string[];
  steps: RunbookStep[];
  verify: Array<{ check: string; command?: RunbookCommand }>;
  failure_modes: Array<{ symptom: string; cause: string; response: string }>;
  rollback: Array<{ do: string; command?: RunbookCommand }>;
  /** Free markdown for context that is not a step. No leading/trailing blank lines. */
  notes?: string;
}

export type RunbookScopeKind = 'org' | 'initiative' | 'repo' | 'tool';
export interface RunbookScope { kind: RunbookScopeKind; ref: string | null }
export type RunbookStatus = 'draft' | 'published' | 'retired';

/** The runbook itself (one row; versions hang off it). */
export interface Runbook {
  /** Stable slug: rb-tenant-cutover. */
  id: string;
  scope: RunbookScope;
  /** Accountable human (p-…). */
  owner_person_id: string;
  status: RunbookStatus;
  current_version: number;
  /**
   * R8: the initiative a cross-project skill came from — a label (shown in the
   * portal, never a delivery gate) that names whose SMEs steward it alongside
   * the org-leader. Set when a captured tool is accepted.
   */
  area?: string | null;
  retired?: { at: string; by: string; reason: string; superseded_by: string | null };
  created_at: string;
  updated_at: string;
}

export interface RunbookProvenance {
  /** agent_jobs / bot runs / devbox sessions. */
  run_refs: string[];
  session_ids: string[];
  /** Raw run notes cited as evidence. */
  lab_experience_ids: string[];
  /** Migration only: the art-0xx it replaced. */
  source_artifact_ids: string[];
}

/**
 * A file a runbook carries (R8): a script it runs or the data its verify step
 * replays. Lives at a bundle-relative path under scripts/ or data/ and ships
 * beside the runbook's SKILL.md in the skill library (skill.ts, library.ts).
 * Text only (UTF-8, no NUL); sha256/size are of the UTF-8 bytes and are always
 * derived (files.ts fileOf), never trusted from a caller.
 */
export interface RunbookFile {
  /** "scripts/cdp-ws-frames.mjs" | "data/sample-frames.jsonl" — validated by files.ts checkFilePath. */
  path: string;
  content: string;
  /** '755' for an executable script, else '644'. */
  mode: '644' | '755';
  sha256: string;
  size: number;
}

export interface RunbookVersion {
  runbook_id: string;
  version: number;
  doc: RunbookDoc;
  /** renderRunbook(doc) — stored so a brief can cite bytes. */
  markdown: string;
  /** sha256 hex of `markdown`. */
  sha256: string;
  /** R8: the scripts and data the runbook carries, sorted by path. Absent/[] for a procedure-only runbook. */
  files?: RunbookFile[];
  /**
   * R8: sha256 over the markdown's sha and every file (files.ts bundleSha) — the
   * version's identity once files are part of it. Equals `sha256` semantics
   * extended: a change to any file is a new bundle sha.
   */
  bundle_sha256?: string;
  author: { kind: 'person' | 'run' | 'migration'; id: string };
  /** The proposal that produced it (null for v1 of a hand-authored one). */
  proposal_id: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  provenance: RunbookProvenance;
}

export type ApplicationOutcome = 'followed' | 'followed_with_deviation' | 'failed' | 'not_used';

/** A run that was GIVEN the runbook and reported on it. */
export interface RunbookApplication {
  id: string;
  runbook_id: string;
  version: number;
  run_ref: string;
  /**
   * The frozen brief that handed the runbook to the run. null only for history
   * that predates session briefs (the seeded applications):
   * nothing was frozen for those runs, so there is no brief to name. Every
   * application a run reports now is checked against its brief and names it.
   */
  brief_id: string | null;
  outcome: ApplicationOutcome;
  failed_at_step: number | null;
  note: string | null;
  at: string;
}

export type LintRuleId =
  | 'R-imperative' | 'R-joined' | 'R-generated' | 'R-commandless' | 'R-verify'
  | 'R-rollback' | 'R-single-subject' | 'R-command-real' | 'R-length' | 'R-secrets'
  // R8 — bundles (files) and the skill each runbook becomes.
  | 'R-file-path' | 'R-file-size' | 'R-file-unreferenced' | 'R-file-missing' | 'R-script-header' | 'R-bundle-verify'
  | 'R-skill-description' | 'R-skill-collision';

export interface LintFinding {
  rule: LintRuleId;
  severity: 'error' | 'warning';
  /** JSON-pointer-ish location: "steps[2].do", "summary", "rollback". */
  path: string;
  message: string;
}

export interface RunbookProposal {
  id: string;
  kind: 'new' | 'edit' | 'retire';
  /** null for kind 'new'. */
  runbook_id: string | null;
  /** The version the diff was taken against. */
  base_version: number | null;
  /** null for 'retire'. */
  proposed: RunbookDoc | null;
  /**
   * R8: the files the proposed version carries (the WHOLE set, not a delta:
   * omitted means "no files", so an edit that keeps the base's files repeats
   * them). Absent on proposals that predate R8.
   */
  proposed_files?: RunbookFile[];
  /** R8: a 'new' proposal's skill name from its SKILL.md draft (`.lab/keep/<name>`); the accept uses it as the id unless the reviewer names one. */
  proposed_id?: string;
  rationale: string;
  source: {
    kind: 'run' | 'person';
    run_ref?: string; session_id?: string; work_item_id?: string; person_id?: string;
    /**
     * A `run` proposal's accountable person: who dispatched or claimed the run,
     * read from its frozen brief (never from the body). They may not accept it —
     * the same rule as a person's own proposal.
     */
    dispatched_by?: string;
    lab_experience_ids: string[];
  };
  /** Stored at write time; re-run on read. */
  lint: LintFinding[];
  similar: Array<{ runbook_id: string; score: number; reason: string }>;
  status: 'open' | 'accepted' | 'rejected' | 'merged' | 'withdrawn';
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  merged_into: string | null;
  created_at: string;
}

export type HealthStatus = 'proven' | 'drifting' | 'unproven';

export interface RunbookHealth {
  status: HealthStatus;
  /** Counts in words: "proven on 3 of 4 runs of v2 (last 2026-10-14)". */
  reason: string;
  /** The one-line warning a brief prints above a drifting runbook, else null. */
  warning: string | null;
}

/** 'runbook' only in briefs frozen before R8 (assembler v1); v2 briefs carry 'skill_library' instead. */
export type BriefSectionKind = 'framing' | 'work_item' | 'initiative' | 'decisions' | 'skills' | 'runbook' | 'skill_library' | 'how_to_report';

export interface BriefSection {
  kind: BriefSectionKind;
  ref: string | null;
  version?: number;
  tokens: number;
  reason: string;
}

export interface BriefOmission {
  runbook_id: string;
  reason: 'budget' | 'drifting_excluded' | 'scope';
}

/** What a run was told, frozen at claim/dispatch (design §3.1). */
export interface SessionBrief {
  id: string;
  /** agent_jobs id | devbox session id | local work id. */
  run_ref: string;
  work_item_id: string | null;
  initiative_id: string | null;
  repo: string | null;
  assembled_at: string;
  /** Bump when the rules change. */
  assembler_version: string;
  budget_tokens: number;
  used_tokens: number;
  sections: BriefSection[];
  omitted: BriefOmission[];
  markdown: string;
  /** sha256 hex of `markdown`; the box's bytes and the portal's bytes are compared by it. */
  sha256: string;
  /**
   * Who bound the run to a box (the dispatcher's or job creator's session sub),
   * stamped by the freeze, not part of the markdown. Absent for briefs frozen
   * by no person (a scheduled bot) and for briefs assembled outside a run.
   */
  dispatched_by?: string | null;
  /**
   * R8 (assembler v2): the org-wide skill library at freeze time — its sha, where
   * the box installs it, and every skill's version. Not rendered beyond the
   * one-line pointer; `lab applied` / `lab runbook` are checked against it.
   */
  skill_library?: { sha256: string; dir: string | null; skills: Array<{ name: string; version: number }> };
}
