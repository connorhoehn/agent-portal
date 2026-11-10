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
} as const;
