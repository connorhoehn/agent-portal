// The run report (docs/learning-loop-design.md §1): what every run hands back
// when it ends, one per run, the same shape from every executor, stored once
// and never edited. Pure declarations and the size caps; nothing here does I/O.
//
// Two kinds of field, and the difference matters:
//   * what the SERVER knows (the frozen brief, the job row, the change request,
//     the ledger): runRef, work item, initiative, executor, model, times,
//     outcome, changes, runbooksOffered, cost.billedUsd;
//   * what the WORKER says (its final message's `lab-report` block, the skills
//     it loaded, the folders it kept, the cost it reported): summary,
//     verification, obstacles, runbooksUsed, kept, cost.reportedUsd.
// The second kind is untrusted text. It is capped (RUN_REPORT_LIMITS), stored
// as data and shown as text; nothing in this lane puts it into a prompt.

export type RunExecutor = 'fleet' | 'governed' | 'microvm' | 'local' | 'mock';
export const RUN_EXECUTORS: readonly RunExecutor[] = ['fleet', 'governed', 'microvm', 'local', 'mock'];

export type RunOutcome = 'done' | 'failed' | 'cancelled' | 'needs-review';
export const RUN_OUTCOMES: readonly RunOutcome[] = ['done', 'failed', 'cancelled', 'needs-review'];

/** Whether the worker's `lab-report` block was there and readable. A missing or malformed block is not an error. */
export type SelfReportState = 'ok' | 'missing' | 'malformed';

export interface RunReportChangedFile {
  path: string;
  /** null when only the file list is known (no diff to count). */
  added: number | null;
  removed: number | null;
}

export interface RunReportVerification {
  command: string;
  passed: boolean;
}

export interface RunReportRunbookRef {
  /** The runbook id (its skill name), e.g. rb-statsd-decommission. */
  id: string;
  /** The version the run was given (from the frozen brief), or null when the brief did not record one. */
  version: number | null;
}

export interface RunReportUse extends RunReportRunbookRef {
  /**
   * How we know: `observed` (the worker saw the session load the skill in its
   * tool-call stream), `lab-applied` (the run said so with `lab applied`).
   */
  source: 'observed' | 'lab-applied';
}

export interface RunReportCost {
  /** What the ledger was charged for this run, in USD. 0 for local compute; null when unknown. */
  billedUsd: number | null;
  /** What the worker reported (local compute: the operator's own login). Never billed. */
  reportedUsd: number | null;
  /**
   * billed       — billedUsd is money the org spent;
   * reported     — local compute: billedUsd is 0 and reportedUsd is the worker's figure, not billed;
   * simulated    — the mock: a fixture figure, never money;
   * unknown      — nothing reported a figure.
   */
  basis: 'billed' | 'reported' | 'simulated' | 'unknown';
}

export interface RunReportKept {
  /** The `.lab/keep/<name>` folder (rb-…). */
  name: string;
  /** The proposal it became, or null when it was refused (see problems). */
  proposalId: string | null;
  problems: string[];
}

/** What the run said of a runbook it was given (its `lab-report` block's `runbooks` list). */
export type RunbookFollowed = 'yes' | 'partly' | 'no';
export const RUNBOOK_FOLLOWED: readonly RunbookFollowed[] = ['yes', 'partly', 'no'];

export interface RunReportRunbookAccount {
  /** The runbook id the run names. Only an id the run was GIVEN moves anything (record.ts). */
  id: string;
  followed: RunbookFollowed;
  /** The step the runbook had wrong (1-based), or null. */
  wrongStep: number | null;
  note: string | null;
}

/**
 * Why a run was not debriefed (docs/learning-loop-design.md, Stage 2). A closed list: the run's
 * page prints `DEBRIEF_SKIP_TEXT[reason]` (lib/runbooks/debrief.ts), never free text.
 */
export const DEBRIEF_SKIP_REASONS = [
  'not-successful', 'nothing-learned', 'no-obstacle', 'review-queue-full', 'daily-limit', 'learning-budget',
  'session-unavailable', 'no-checkout', 'executor-unsupported',
] as const;
export type DebriefSkipReason = typeof DEBRIEF_SKIP_REASONS[number];

/**
 * Where a run's debrief stands.
 *   skipped          never asked; `reason` says why.
 *   requested        the server asked the worker for one and is waiting (until `expiresAt`).
 *   filed            the kept folder became a proposal (`proposalId`).
 *   nothing-to-keep  the session answered `none` (`answer.reason`).
 *   lint-failed      the folder failed lint; `lint` holds the errors and nothing entered the queue.
 *   refused          the folder was refused before lint (`problems`: size, path, shape).
 *   expired          nothing came back before `expiresAt`.
 */
export type DebriefState = 'skipped' | 'requested' | 'filed' | 'nothing-to-keep' | 'lint-failed' | 'refused' | 'expired';

export interface RunDebriefAnswer {
  kind: 'none' | 'new' | 'revise';
  /** The session's one line (for none) or its rationale; untrusted, capped, shown as text. */
  reason: string;
  /** revise: the runbook it rewrote. */
  runbookId: string | null;
  /** new/revise: the `.lab/keep/<name>` folder it wrote. */
  folder: string | null;
}

export interface RunDebrief {
  state: DebriefState;
  /** Set when state is `skipped`, or when a request ended `session-unavailable`. */
  reason: DebriefSkipReason | null;
  /** The plain sentence for `reason` (DEBRIEF_SKIP_TEXT), stored so every page prints the same words. */
  reasonText: string | null;
  /** The debrief prompt's version (lib/runbooks/debrief.ts DEBRIEF_PROMPT_VERSION) when one was asked. */
  promptVersion: string | null;
  decidedAt: string;
  expiresAt: string | null;
  settledAt: string | null;
  /** Binds the one-shot debrief token to this request (not a secret: the token is signed). */
  nonce: string | null;
  /** The learning line's hold for a billed executor (lib/learning-budget.ts), else null. */
  holdId: string | null;
  /** The dollar ceiling the turn was given (`--max-budget-usd`). */
  ceilingUsd: number | null;
  answer: RunDebriefAnswer | null;
  proposalId: string | null;
  /** `edit` when a new runbook was filed as an edit of a near duplicate (or the session revised one). */
  proposalKind: 'new' | 'edit' | null;
  /** The runbook a near-duplicate `new` was converted into an edit of. */
  convertedFrom: string | null;
  problems: string[];
  /** Lint errors when state is `lint-failed` (the same LintFinding shape as a proposal's). */
  lint: Array<{ rule: string; severity: 'error' | 'warning'; path: string; message: string }>;
  /** What the turn cost: billed (learning line) or reported (local compute, never billed). */
  cost: { billedUsd: number | null; reportedUsd: number | null };
  /** The mock: a hand-written fixture played the debrief (shown as "Demo data"). */
  simulated: boolean;
}

export interface RunReport {
  runRef: string;
  workItemId: string | null;
  initiativeId: string | null;
  executor: RunExecutor;
  model: string | null;
  startedAt: string | null;
  endedAt: string;
  outcome: RunOutcome;
  /** A short machine code when the run failed or was cancelled (`claim_lost`, `budget`, `exit_1`…), else null. */
  failureCode: string | null;
  /** What was done, ≤ 1,200 characters. Worker-supplied; '' when the self-report is missing. */
  summary: string;
  changes: { files: RunReportChangedFile[]; changeRequestId: string | null };
  verification: RunReportVerification[];
  /** Things that went wrong and how they were got round, ≤ 8 short entries. */
  obstacles: string[];
  /** From the frozen brief's offer (lane D fills it); [] for a brief with none. */
  runbooksOffered: RunReportRunbookRef[];
  runbooksUsed: RunReportUse[];
  cost: RunReportCost;
  kept: RunReportKept[];
  selfReport: SelfReportState;
  /**
   * Lane C: the run's one sentence of what a written procedure would have saved it ('' for
   * nothing). Optional on reports stored before lane C.
   */
  learned?: string;
  /** Lane C: what the run said of each runbook it was given. Optional on older reports. */
  runbookAccounts?: RunReportRunbookAccount[];
  /** Lane C: whether the run was debriefed and how that ended. null/absent: not decided (older reports). */
  debrief?: RunDebrief | null;
  /** Lane C: the Claude Code session the work turn ran in (a UUID the worker reported), which a debrief resumes. */
  claudeSessionId?: string | null;
  /** The frozen brief this run was given, or null when none froze. */
  briefId: string | null;
  /** When the report was stored. */
  createdAt: string;
}

/**
 * What a worker sends about its own run (local compute with its completion
 * call; a devbox's `lab report` from the SessionEnd hook). Every field is
 * untrusted and optional; `normalizeWorkerPart` caps it before anything reads it.
 */
export interface WorkerReportPart {
  /** The raw text inside the final message's ```lab-report fence (or the whole final message; the parser finds the block). */
  block?: string | null;
  /** Skill names the session loaded, read from the tool-call stream. */
  skillsLoaded?: string[];
  /** Kept skill folders, reported by name (their proposals are filed separately). */
  kept?: RunReportKept[];
  /** The cost the worker reported, in USD. */
  reportedCostUsd?: number | null;
  /** Lane C: the Claude Code session id of the work turn (validated as a UUID). */
  claudeSessionId?: string | null;
}

/** Caps on every free-text and list field. Applied to everything a worker sends, and to fixtures too. */
export const RUN_REPORT_LIMITS = {
  summary: 1_200,
  obstacles: 8,
  obstacle: 300,
  verification: 20,
  command: 300,
  files: 200,
  path: 300,
  failureCode: 80,
  model: 120,
  runbooksUsed: 50,
  skillName: 64,
  kept: 10,
  keptProblems: 5,
  keptProblem: 200,
  /** The raw `lab-report` text a worker may send; anything longer is refused unread as malformed. */
  block: 16_384,
  learned: 300,
  runbookAccounts: 10,
  runbookNote: 300,
  debriefReason: 300,
  debriefProblems: 8,
} as const;

/**
 * Who may list run reports (routes/run-reports.ts): these roles, or anyone holding the action. The
 * search index applies the same two rules to a run result (providers/search.ts), so a search never
 * shows a person a report the list would refuse them.
 */
export const RUN_REPORT_READ_ROLES = ['org-leader', 'hr-admin', 'program-owner'] as const;
export const RUN_REPORT_READ_ACTION = 'ManageBots';
