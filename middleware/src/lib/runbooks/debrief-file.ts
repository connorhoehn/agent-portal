// From a debrief's answer and kept folder to a proposal (docs/learning-loop-design.md, Stage 3),
// and the run's debrief record moved to its end. One function for every executor: the local
// worker's POST /api/local-compute/jobs/:id/debrief, a devbox's debrief proposal, and the mock's
// hand-written fixture all come through `settleDebrief`.
//
// The folder is data until a person reviews it. In order:
//   1. the run must have an open request (single use: the record moves off `requested` once);
//   2. the answer must match the schema; `none` ends there;
//   3. the folder's shape: the name it was asked for, a SKILL.md, files under scripts/ or data/
//      only (lib/runbooks/files.ts filesOf: safe paths, text only, per-file and per-bundle caps);
//   4. routes/runbooks.ts fileProposal with the run-authored rules: parse, portable frontmatter,
//      lint (an error stores the findings on the run and files nothing), the run's repository or
//      initiative as its scope, a near duplicate of a published runbook filed as an edit of it;
//   5. money: a billed executor settles its learning-line hold with what the turn reported
//      (or releases it when the turn never ran); local compute and the mock bill nothing.
import type { RunDebrief, RunReport } from '../run-reports/types.js';
import { RUN_REPORT_LIMITS as L } from '../run-reports/types.js';
import type { RunReportStore } from '../run-reports/store.js';
import type { RunbookStore } from './store.js';
import type { LintFinding } from './types.js';
import { executorBilled, parseDebriefAnswer, settledDebrief } from './debrief.js';

const RB_ID = /^rb-[a-z0-9][a-z0-9-]{1,60}$/;
const SKILL_MD_MAX = 200_000;

export interface SettleDebriefInput {
  runRef: string;
  /** The turn's structured answer (the `--json-schema` result), raw. */
  answer?: unknown;
  /** The kept folder the worker read: `{ name, skill_md, files: [{ path, content, mode }] }`, raw. */
  folder?: unknown;
  /** The worker could not resume the session (or the turn died before answering). */
  sessionUnavailable?: boolean;
  /** Problems the worker already found reading the folder (traversal, links, sizes): the folder is refused. */
  problems?: unknown;
  /** What the turn reported it cost. */
  costUsd?: number | null;
  /** The run's repository (for the default scope), when the executor knows it. */
  repo?: string | null;
  /** The mock's hand-written fixture played the turn. */
  simulated?: boolean;
}

export interface SettleDebriefDeps {
  runbooks?: RunbookStore;
  reports?: RunReportStore;
  nowIso?: () => string;
  settle?: (i: { runRef: string; costUsd: number | null }) => Promise<void>;
  release?: (holdId: string | null) => Promise<void>;
}

export type SettleDebriefResult =
  | { ok: true; debrief: RunDebrief }
  | { ok: false; status: number; code: string; error: string };

const cleanLine = (v: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩‎‏]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

const money = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1000 ? Math.round(v * 1e6) / 1e6 : null;

export async function settleDebrief(input: SettleDebriefInput, deps: SettleDebriefDeps = {}): Promise<SettleDebriefResult> {
  const reports = deps.reports ?? (await import('../run-reports/store-select.js')).runReportStore();
  const runbooks = deps.runbooks ?? (await import('./store-select.js')).runbookStore();
  const now = deps.nowIso ?? (await import('../../mock/core/clock.js')).clock.nowIso;
  const at = now();
  const report = await reports.getReport(input.runRef);
  if (!report) return { ok: false, status: 404, code: 'NO_REPORT', error: 'this run has no report' };
  const d = report.debrief;
  if (!d || d.state !== 'requested') return { ok: false, status: 409, code: 'NOT_REQUESTED', error: `no debrief is waiting for this run${d ? ` (it is ${d.state})` : ''}` };

  const billed = executorBilled(report.executor);
  const cost = money(input.costUsd);
  const settleMoney = async (ran: boolean): Promise<void> => {
    if (!billed) return;
    try {
      if (ran) await (deps.settle ?? (async (i) => (await import('../learning-budget.js')).settleLearningSpend(i)))({ runRef: report.runRef, costUsd: cost });
      else await (deps.release ?? (async (h) => (await import('../learning-budget.js')).releaseLearningSpend(h)))(d.holdId);
    } catch (e) {
      console.warn(`[debrief] could not settle the learning hold for ${report.runRef}:`, (e as Error).message);
    }
  };
  const costField = { billedUsd: billed ? cost : 0, reportedUsd: billed ? null : cost };
  const finish = async (patch: Partial<RunDebrief> & { state: RunDebrief['state'] }, ran: boolean): Promise<SettleDebriefResult> => {
    if (d.expiresAt && Date.parse(d.expiresAt) <= Date.parse(at)) {
      // Too late: the request was already over. Nothing is filed; the money question is the same.
      patch = { state: 'expired', problems: ['the debrief came back after its request expired'] };
    }
    await settleMoney(ran);
    const next = settledDebrief(d, { ...patch, cost: costField, simulated: d.simulated || input.simulated === true }, at);
    const stored = await reports.setDebrief(report.runRef, next, 'requested');
    if (!stored) return { ok: false, status: 409, code: 'NOT_REQUESTED', error: 'the debrief was settled meanwhile' };
    return { ok: true, debrief: stored.debrief! };
  };

  if (input.sessionUnavailable) return finish({ state: 'skipped', reason: 'session-unavailable' }, false);

  const answer = parseDebriefAnswer(input.answer);
  if (!answer) return finish({ state: 'refused', problems: ['the answer does not match the debrief schema'] }, true);
  if (answer.kind === 'none') return finish({ state: 'nothing-to-keep', answer }, true);

  const workerProblems = Array.isArray(input.problems)
    ? input.problems.map((p) => cleanLine(p, L.keptProblem)).filter(Boolean).slice(0, L.debriefProblems) : [];
  if (workerProblems.length) return finish({ state: 'refused', answer, problems: workerProblems }, true);

  const f = (input.folder && typeof input.folder === 'object' && !Array.isArray(input.folder) ? input.folder : null) as Record<string, unknown> | null;
  const problems: string[] = [];
  if (!f) problems.push(`no folder came back for .lab/keep/${answer.folder}`);
  const name = f && typeof f['name'] === 'string' ? f['name'] : '';
  if (f && name !== answer.folder) problems.push('the folder posted is not the one the answer names');
  if (f && !RB_ID.test(name)) problems.push('the folder name must look like rb-some-name');
  const skillMd = f && typeof f['skill_md'] === 'string' ? f['skill_md'] : '';
  if (f && !skillMd.trim()) problems.push('the folder has no SKILL.md');
  if (skillMd.length > SKILL_MD_MAX) problems.push(`SKILL.md is ${skillMd.length} characters (max ${SKILL_MD_MAX})`);
  const files = f && f['files'] !== undefined ? f['files'] : [];
  if (problems.length) return finish({ state: 'refused', answer, problems }, true);

  const { fileProposal, runAuthoredScope, runProposalSource } = await import('../../routes/runbooks.js');
  const brief = await runbooks.getBrief(report.runRef).catch(() => null);
  const scope = runAuthoredScope({ repo: input.repo ?? brief?.repo ?? null, initiativeId: report.initiativeId ?? brief?.initiative_id ?? null });
  if (!scope) return finish({ state: 'refused', answer, problems: ['the run has neither a repository nor an initiative to scope a runbook to'] }, true);

  let kind: 'new' | 'edit' = 'new';
  let runbookId: string | undefined;
  if (answer.kind === 'revise') {
    const target = answer.runbookId ? await runbooks.getRunbook(answer.runbookId) : null;
    if (!target || target.status !== 'published') return finish({ state: 'refused', answer, problems: [`there is no published runbook ${answer.runbookId ?? ''} to revise`.trim()] }, true);
    kind = 'edit';
    runbookId = target.id;
  } else if (await runbooks.getRunbook(name)) {
    // A `new` folder named like an existing runbook is a revision of it, whatever the answer said.
    kind = 'edit';
    runbookId = name;
  }

  const learned = (report.learned ?? '').trim();
  const body: Record<string, unknown> = {
    kind, skill_md: skillMd, files,
    rationale: learned
      ? `Debrief of run ${report.runRef}. What it learned: ${learned}`
      : `Debrief of run ${report.runRef}.`,
    ...(runbookId ? { runbook_id: runbookId } : {}),
  };
  const source = brief
    ? runProposalSource(brief, report.runRef, {})
    : { kind: 'run' as const, run_ref: report.runRef, lab_experience_ids: [], ...(report.workItemId ? { work_item_id: report.workItemId } : {}) };
  let out;
  try {
    out = await fileProposal(runbooks, body, source, {
      scope, initiativeId: report.initiativeId ?? brief?.initiative_id ?? null, refuseOnLint: true, convertNearDuplicate: kind === 'new',
      debrief: {
        run_ref: report.runRef, prompt_version: d.promptVersion ?? 'unknown', answer_kind: answer.kind === 'revise' ? 'revise' : 'new',
        converted_from_new: false, simulated: d.simulated || input.simulated === true,
      },
    });
  } catch (e) {
    return finish({ state: 'refused', answer, problems: [cleanLine((e as Error).message, L.keptProblem) || 'refused'] }, true);
  }
  if (out.status === 201 && out.proposal) {
    const p = out.proposal;
    return finish({
      state: 'filed', answer, proposalId: p.id, proposalKind: p.kind === 'edit' ? 'edit' : 'new',
      convertedFrom: typeof out.body['converted_from_new'] === 'string' ? out.body['converted_from_new'] : null,
    }, true);
  }
  if (out.body['code'] === 'LINT') {
    const lint = (Array.isArray(out.body['findings']) ? out.body['findings'] : []) as LintFinding[];
    return finish({ state: 'lint-failed', answer, lint: lint.slice(0, 20) }, true);
  }
  const why = out.body['problems'];
  const list = Array.isArray(why)
    ? why.map((x) => cleanLine(typeof x === 'string' ? x : (x as { message?: unknown })?.message ?? JSON.stringify(x), L.keptProblem)).filter(Boolean)
    : [];
  return finish({ state: 'refused', answer, problems: list.length ? list.slice(0, L.debriefProblems) : [cleanLine(out.body['error'], L.keptProblem) || 'refused'] }, true);
}

/** A request whose worker never came back: expire it (and give a billed executor's hold back). */
export async function expireDebrief(report: RunReport, deps: SettleDebriefDeps & { reports: RunReportStore }): Promise<boolean> {
  const d = report.debrief;
  if (!d || d.state !== 'requested' || !d.expiresAt) return false;
  const at = (deps.nowIso ?? (await import('../../mock/core/clock.js')).clock.nowIso)();
  if (Date.parse(d.expiresAt) > Date.parse(at)) return false;
  if (executorBilled(report.executor)) {
    await (deps.release ?? (async (h) => (await import('../learning-budget.js')).releaseLearningSpend(h)))(d.holdId).catch(() => undefined);
  }
  const next = settledDebrief(d, { state: 'expired', problems: ['nothing came back before the request expired'] }, at);
  return !!(await deps.reports.setDebrief(report.runRef, next, 'requested'));
}
