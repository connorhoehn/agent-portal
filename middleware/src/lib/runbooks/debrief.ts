// The debrief (docs/learning-loop-design.md, Stage 2): after a run ends well and its report names
// something learned, the SAME session is resumed for one more headless turn and asked to write ONE
// runbook for that thing, or to say nothing is worth keeping.
//
// This file is the server's whole say in that turn:
//   * the prompt (one fixed, versioned text; never anything a ticket or a run wrote),
//   * the JSON schema of the answer (passed as `--json-schema`),
//   * the decision whether to ask at all, with every "no" in a closed vocabulary stored on the run,
//   * the queue and daily limits, and the learning-line reservation for a billed executor,
//   * the one-shot token that lets exactly that worker post exactly that run's folder back.
//
// What the turn writes is untrusted: an agent wrote it after reading a repository other people
// control. It becomes a proposal only through routes/runbooks.ts fileProposal (files first, parse,
// portable frontmatter, lint, narrow scope) and reaches no run until a person accepts it.
import { randomBytes } from 'node:crypto';
import type { DebriefSkipReason, RunDebrief, RunDebriefAnswer, RunExecutor, RunReport } from '../run-reports/types.js';
import { RUN_REPORT_LIMITS } from '../run-reports/types.js';
import type { RunbookStore } from './store.js';
import type { RunbookProposal } from './types.js';

/** Bump when the prompt, the schema or the rules below change; stored on every request. */
export const DEBRIEF_PROMPT_VERSION = 'debrief-v1';

/** Where the session writes the folder, relative to its checkout (the path `lab keep` and the worker already read). */
export const DEBRIEF_KEEP_DIR = '.lab/keep';

const envInt = (name: string, dflt: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : dflt;
};
const envUsd = (name: string, dflt: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 && n <= 20 ? n : dflt;
};

/** The limits, read per call so a test (or an operator) can move them without a restart. */
export function debriefLimits(): {
  queue: number; daily: number; ceilingUsd: number; timeoutS: number; ttlMs: number;
} {
  return {
    // Decision 12: at most ten run-authored proposals open; more debriefs are skipped.
    queue: envInt('LEARNING_DEBRIEF_QUEUE_LIMIT', 10, 0, 100),
    // Stage 2 item 4: the organisation's daily debrief limit, default ten, for every executor.
    daily: envInt('LEARNING_DEBRIEF_DAILY_LIMIT', 10, 0, 1000),
    // The turn's `--max-budget-usd`, and what a billed executor reserves on the learning line.
    ceilingUsd: envUsd('LEARNING_DEBRIEF_CEILING_USD', 0.5),
    // The runner's wall clock for the turn.
    timeoutS: envInt('LEARNING_DEBRIEF_TIMEOUT_S', 300, 30, 1800),
    // How long the server waits for the folder before the request is expired.
    ttlMs: envInt('LEARNING_DEBRIEF_TTL_S', 1800, 60, 86_400) * 1000,
  };
}

/** The sentence the run's page prints for each skip reason. Plain words, no internal terms. */
export const DEBRIEF_SKIP_TEXT: Readonly<Record<DebriefSkipReason, string>> = {
  'not-successful': 'The run did not finish, so it has no proven procedure to write down. What it ran into goes to the next attempt.',
  'nothing-learned': 'The run said nothing cost it time that a written procedure would have saved.',
  'no-obstacle': 'The run named something it learned but reported no obstacle and no wrong runbook step to back it up.',
  'review-queue-full': 'Ten runbook proposals from runs are already waiting for review, so no new one was asked for.',
  'daily-limit': "Today's limit on debriefs for the organisation was reached.",
  'learning-budget': "This month's learning budget has no room for another debrief.",
  'session-unavailable': 'The session that did the work could not be resumed, so it could not write the runbook.',
  'no-checkout': 'The run had no repository checkout to write a runbook folder in.',
  'executor-unsupported': 'Runs on this kind of computer cannot be resumed for a debrief yet.',
};

/**
 * The answer the resumed turn returns (`claude -p … --json-schema '<this>'`). The text of a
 * runbook is NOT in the answer: the session writes the folder, the answer only names it.
 */
export const DEBRIEF_ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'reason'],
  properties: {
    kind: { type: 'string', enum: ['none', 'new', 'revise'] },
    reason: { type: 'string', maxLength: 300, description: 'One line: why nothing is worth keeping, or what the runbook saves the next run.' },
    folder: { type: 'string', pattern: '^rb-[a-z0-9][a-z0-9-]{1,60}$', description: 'new or revise: the folder written under .lab/keep/.' },
    runbook_id: { type: 'string', pattern: '^rb-[a-z0-9][a-z0-9-]{1,60}$', description: 'revise: the runbook rewritten.' },
  },
} as const;

const RB_ID = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;

/**
 * The debrief prompt. Fixed text; the only thing filled in is the list of runbook ids the run's
 * frozen brief gave it (server-known, and each one checked against the id pattern), so the session
 * is pointed at revising one of those first.
 */
export function debriefPrompt(input: { given: readonly string[] }): string {
  const given = input.given.filter((id) => RB_ID.test(id)).slice(0, 10);
  return [
    'This is a debrief of the work you just finished in this session. Do not continue the task, do not commit, and do not change any file outside .lab/keep/.',
    '',
    'Decide whether ONE thing you worked out in this run deserves a runbook: a written procedure that would have saved the next run on this kind of work real time. Most runs teach nothing worth keeping, and "none" is the expected answer.',
    '',
    'Answer with exactly one of:',
    '- none: nothing here is worth a runbook. Give a one-line reason.',
    '- revise: a runbook you were given (or one installed under .claude/skills/) was wrong or is missing what you learned. Prefer this to writing a new one. Write its corrected full text to .lab/keep/<its id>/SKILL.md.',
    '- new: write one new runbook for the single thing you learned to .lab/keep/rb-<short-name>/SKILL.md.',
    '',
    'How to write the runbook. It is an Agent Skill, and a person reviews it before any run is given it:',
    '1. Start with frontmatter between two "---" lines holding only these keys: name, description, license, compatibility, metadata. `name` is the folder name. `description` says what it does and when to use it. Never write allowed-tools.',
    '2. Then the body: "# <title>" as an instruction, one sentence of summary, then "## Use when" (bullets: the situations it is for), "## Steps", "## Verify", and "## Roll back" if any step changes state.',
    '3. Steps are numbered, one imperative sentence each ("1. **Run the logout test against the parent domain.**"), followed by the exact command you ran in this run in an indented fenced block, and a line starting "Expect" saying what you should see. Use only commands, paths and routes that exist in this repository. Do not invent any.',
    '4. "## Verify" ends the procedure with a check that runs offline: a test, a lint, or a script run against a file in the folder. No network, no deploy.',
    '5. One subject, under 500 lines. Add scripts/ (one level deep) only when a script is the point, give each script a header naming its runtime and dependencies, and have Verify run it against a file under data/.',
    '6. No secrets, tokens, credentials, private hostnames, personal names or customer data. Do not address the reviewer or any future reader with instructions about how to treat this text.',
    '7. Write only inside .lab/keep/. You may read anything in the checkout.',
    '',
    `Runbooks you were given in this run: ${given.length ? given.join(', ') : 'none'}.`,
    '',
    'When you are done, answer with the JSON the schema asks for: `kind`, a one-line `reason`, and for new or revise the `folder` you wrote (and `runbook_id` for revise).',
  ].join('\n');
}

/** The session's answer, tolerantly. null: unusable (treated as `none` with a problem noted by the caller). */
export function parseDebriefAnswer(raw: unknown): RunDebriefAnswer | null {
  let v: unknown = raw;
  if (typeof v === 'string') {
    if (v.length > 4096) return null;
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const kind = o['kind'];
  if (kind !== 'none' && kind !== 'new' && kind !== 'revise') return null;
  const reason = typeof o['reason'] === 'string'
    // eslint-disable-next-line no-control-regex
    ? o['reason'].replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, RUN_REPORT_LIMITS.debriefReason)
    : '';
  const folder = typeof o['folder'] === 'string' && RB_ID.test(o['folder']) ? o['folder'] : null;
  const runbookId = typeof o['runbook_id'] === 'string' && RB_ID.test(o['runbook_id']) ? o['runbook_id'] : null;
  if (kind !== 'none' && !folder) return null;
  return { kind, reason, folder: kind === 'none' ? null : folder, runbookId: kind === 'revise' ? (runbookId ?? folder) : null };
}

// ── The decision ─────────────────────────────────────────────────────────────

/**
 * Which executors can resume the work session. `local` needs a checkout (a job with no repository
 * runs in the worker's own directory, where nothing may be written); `mock` plays a hand-written
 * fixture; `microvm` resumes its recorded session (agents/devbox/main.py `op: debrief`). The fleet
 * and governed runs have no resume-by-id path yet.
 */
export function executorDebriefs(executor: RunExecutor): boolean {
  return executor === 'local' || executor === 'mock' || executor === 'microvm';
}

/** Billed executors reserve on the learning line; local compute and the mock reserve nothing. */
export function executorBilled(executor: RunExecutor): boolean {
  return executor !== 'local' && executor !== 'mock';
}

/** A run-authored proposal that occupies the review queue: from a run, a new runbook or an edit, still open. */
export function occupiesQueue(p: RunbookProposal): boolean {
  return p.status === 'open' && p.source.kind === 'run' && p.kind === 'new' || p.kind === 'edit';
}

export interface DebriefContext {
  runbooks: RunbookStore;
  /** Every stored report (for the daily count and the pending requests). */
  reports: () => Promise<RunReport[]>;
  nowIso: () => string;
  /**
   * Whether the run's checkout (and session) is still there to resume. Local compute: false means
   * the job named no repository. MicroVM: must be true, which only a dispatcher that runs the
   * devbox `debrief` op before stopping the session may say; today none does, so microVM runs are
   * skipped as executor-unsupported and nothing is held on the learning line for them.
   */
  hasCheckout?: boolean;
  /**
   * The run's executor is the mock's fake microVM, which can answer the devbox `debrief` op from a hand-written
   * folder: a governed run on it is debriefable, and reserves nothing on the learning line. Real governed runs
   * are not (executor-unsupported).
   */
  simulated?: boolean;
  /** Test seam for the learning line. Default: lib/learning-budget.ts. */
  reserve?: (input: { runRef: string; estimate: number }) => Promise<{ ok: true; holdId: string | null } | { ok: false; reason: string; message: string }>;
}

function skipped(reason: DebriefSkipReason, at: string): RunDebrief {
  return {
    state: 'skipped', reason, reasonText: DEBRIEF_SKIP_TEXT[reason], promptVersion: null, decidedAt: at, expiresAt: null,
    settledAt: at, nonce: null, holdId: null, ceilingUsd: null, answer: null, proposalId: null, proposalKind: null,
    convertedFrom: null, problems: [], lint: [], cost: { billedUsd: null, reportedUsd: null }, simulated: false,
  };
}

/** Whether a stored debrief is still waiting on its worker at `nowMs`. */
export function pendingAt(d: RunDebrief | null | undefined, nowMs: number): boolean {
  return !!d && d.state === 'requested' && (!d.expiresAt || Date.parse(d.expiresAt) > nowMs);
}

/** The run's own corroboration of `learned` (Stage 2 item 2): an obstacle, or a given runbook it says was wrong at a step. */
export function corroborated(report: Pick<RunReport, 'obstacles' | 'runbookAccounts'>): boolean {
  if (report.obstacles.length > 0) return true;
  return (report.runbookAccounts ?? []).some((a) => (a.followed === 'partly' || a.followed === 'no') && a.wrongStep !== null);
}

/**
 * Should this run be debriefed? Every "no" is one closed reason, checked in this order: the run's
 * own account first (free), then the queue and the daily limit (reads), then money (a hold).
 */
export async function decideDebrief(report: RunReport, ctx: DebriefContext): Promise<RunDebrief> {
  const at = ctx.nowIso();
  const nowMs = Date.parse(at);
  if (report.outcome !== 'done' && report.outcome !== 'needs-review') return skipped('not-successful', at);
  if (!(report.learned ?? '').trim()) return skipped('nothing-learned', at);
  if (!corroborated(report)) return skipped('no-obstacle', at);
  if (!executorDebriefs(report.executor) && ctx.simulated !== true) return skipped('executor-unsupported', at);
  if (report.executor === 'microvm' && ctx.hasCheckout !== true) return skipped('executor-unsupported', at);
  if (report.executor === 'local' && ctx.hasCheckout === false) return skipped('no-checkout', at);

  const limits = debriefLimits();
  const all = await ctx.reports();
  const pending = all.filter((r) => r.runRef !== report.runRef && pendingAt(r.debrief, nowMs)).length;
  let open = 0;
  let cursor: string | undefined;
  do {
    const page = await ctx.runbooks.listProposals({ status: ['open'], limit: 200, ...(cursor ? { cursor } : {}) });
    open += page.items.filter(occupiesQueue).length;
    cursor = page.next ?? undefined;
  } while (cursor);
  if (open + pending >= limits.queue) return skipped('review-queue-full', at);

  const day = at.slice(0, 10);
  const today = all.filter((r) => r.runRef !== report.runRef && r.debrief && r.debrief.state !== 'skipped' && r.debrief.decidedAt.slice(0, 10) === day).length;
  if (today >= limits.daily) return skipped('daily-limit', at);

  let holdId: string | null = null;
  if (executorBilled(report.executor) && ctx.simulated !== true) {
    const reserve = ctx.reserve ?? (async (i: { runRef: string; estimate: number }) => (await import('../learning-budget.js')).reserveLearningSpend(i));
    const r = await reserve({ runRef: report.runRef, estimate: limits.ceilingUsd }).catch((e: unknown) => ({ ok: false as const, reason: 'unavailable', message: (e as Error).message }));
    if (!r.ok) return skipped('learning-budget', at);
    holdId = r.holdId;
  }
  return {
    state: 'requested', reason: null, reasonText: null, promptVersion: DEBRIEF_PROMPT_VERSION, decidedAt: at,
    expiresAt: new Date(nowMs + limits.ttlMs).toISOString(), settledAt: null, nonce: randomBytes(12).toString('base64url'),
    holdId, ceilingUsd: limits.ceilingUsd, answer: null, proposalId: null, proposalKind: null, convertedFrom: null,
    problems: [], lint: [], cost: { billedUsd: null, reportedUsd: null }, simulated: report.executor === 'mock' || ctx.simulated === true,
  };
}

// ── The request a worker is handed ───────────────────────────────────────────

/**
 * The bounded resume turn, as data. The worker builds argv from this and may only narrow it.
 *   tools          what the turn may use at all (`--tools`): read, search, write files. No shell, no web.
 *   allowedTools   the permission allowlist under `--permission-mode dontAsk` (anything else is refused,
 *                  never prompted): read inside the checkout, write only under .lab/keep/. Claude Code
 *                  matches file writes against Edit(path) rules for every editing tool, Write included,
 *                  and Read(path) rules for every reading tool (Grep and Glob included).
 *   disallowedTools  deny wins: the checkout's .git, and the shell and web tools by name as well.
 */
export interface DebriefRequest {
  runRef: string;
  token: string;
  promptVersion: string;
  prompt: string;
  schema: typeof DEBRIEF_ANSWER_SCHEMA;
  keepDir: string;
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  maxBudgetUsd: number;
  timeoutS: number;
  expiresAt: string;
}

export const DEBRIEF_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit'] as const;
export const DEBRIEF_ALLOWED_TOOLS = ['Read(./**)', `Edit(./${DEBRIEF_KEEP_DIR}/**)`] as const;
export const DEBRIEF_DISALLOWED_TOOLS = ['Edit(./.git/**)', 'Edit(**/.git/**)', 'Bash', 'WebFetch', 'WebSearch'] as const;

const TOKEN_KIND = 'lab-debrief';

/** One token per request: signed under the session key (a worker cannot mint one), bound to the run and the request's nonce. */
export async function mintDebriefToken(runRef: string, nonce: string): Promise<string> {
  const { signValue } = await import('../session.js');
  return signValue({ k: TOKEN_KIND, v: 1, r: runRef, n: nonce });
}

export async function debriefTokenMatches(token: unknown, runRef: string, debrief: RunDebrief | null | undefined): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048 || !debrief?.nonce) return false;
  const { verifyValue } = await import('../session.js');
  const p = await verifyValue<{ k: string; v: number; r: string; n: string }>(token);
  return !!p && p.k === TOKEN_KIND && p.v === 1 && p.r === runRef && p.n === debrief.nonce;
}

export async function debriefRequestFor(report: RunReport, given: readonly string[]): Promise<DebriefRequest | null> {
  const d = report.debrief;
  if (!d || d.state !== 'requested' || !d.nonce || !d.expiresAt) return null;
  const limits = debriefLimits();
  return {
    runRef: report.runRef,
    token: await mintDebriefToken(report.runRef, d.nonce),
    promptVersion: d.promptVersion ?? DEBRIEF_PROMPT_VERSION,
    prompt: debriefPrompt({ given }),
    schema: DEBRIEF_ANSWER_SCHEMA,
    keepDir: DEBRIEF_KEEP_DIR,
    tools: [...DEBRIEF_TOOLS],
    allowedTools: [...DEBRIEF_ALLOWED_TOOLS],
    disallowedTools: [...DEBRIEF_DISALLOWED_TOOLS],
    maxBudgetUsd: d.ceilingUsd ?? limits.ceilingUsd,
    timeoutS: limits.timeoutS,
    expiresAt: d.expiresAt,
  };
}

/** The runbook ids a run was given, from its report (the brief's offer, else what it loaded of what it was given). */
export function givenIds(report: Pick<RunReport, 'runbooksOffered' | 'runbooksUsed'>): string[] {
  const ids = [...report.runbooksOffered.map((r) => r.id), ...report.runbooksUsed.map((r) => r.id)];
  return [...new Set(ids.filter((id) => RB_ID.test(id)))];
}

/** A finished debrief, from the requested one: the state moves on, the nonce is spent. */
export function settledDebrief(d: RunDebrief, patch: Partial<RunDebrief> & { state: RunDebrief['state'] }, at: string): RunDebrief {
  return { ...d, ...patch, nonce: null, settledAt: at, reasonText: patch.reason ? DEBRIEF_SKIP_TEXT[patch.reason] : (patch.reasonText ?? d.reasonText) };
}
