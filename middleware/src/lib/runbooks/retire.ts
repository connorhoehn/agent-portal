// How the library stays small, and the proposal queue honest (docs/learning-loop-design.md,
// Stages 3 and 5). Everything here runs when a run report is saved (run-reports/record.ts), from
// the report rows, with no queue and no pass of its own:
//
//   expiry         a run-authored proposal nobody decided in fourteen days is withdrawn as expired;
//   retire, unfollowed
//                  three consecutive successful runs on the current model were given a runbook and
//                  said they did not follow it: one `retire` proposal naming those runs and that model;
//   retire, disuse a published runbook given to at least five runs in sixty days and followed by none,
//                  or (older than ninety days) given to no run in ninety days: one `retire` proposal.
//
// One open retire proposal per runbook, and none for thirty days after a person rejected one (a
// person said keep it; the next report must not ask again at once). A retire proposal is only a
// proposal: a person with review rights accepts it, and accepting is what retires the runbook.
//
// And when a person rejects a run's change request, the run's open proposals are withdrawn at once
// (`withdrawForRejectedChange`, called by routes/sdlc.ts): a procedure from a change that was
// turned down is not a procedure that worked.
import { randomUUID } from 'node:crypto';
import type { RunReport } from '../run-reports/types.js';
import type { RunReportStore } from '../run-reports/store.js';
import type { RunbookStore } from './store.js';
import type { Runbook, RunbookProposal } from './types.js';

const DAY_MS = 86_400_000;
export const PROPOSAL_EXPIRY_DAYS = 14;
export const RETIRE_UNFOLLOWED_RUNS = 3;
export const DISUSE_GIVEN_MIN = 5;
export const DISUSE_GIVEN_WINDOW_DAYS = 60;
export const DISUSE_UNGIVEN_DAYS = 90;
export const RETIRE_COOLOFF_DAYS = 30;

export interface UpkeepDeps {
  runbooks: RunbookStore;
  reports: RunReportStore;
  nowIso: () => string;
}

async function allProposals(s: RunbookStore, q: { status?: RunbookProposal['status'][]; runbook_id?: string } = {}): Promise<RunbookProposal[]> {
  const out: RunbookProposal[] = [];
  let cursor: string | undefined;
  do {
    const page = await s.listProposals({ ...q, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

async function allRunbooks(s: RunbookStore): Promise<Runbook[]> {
  const out: Runbook[] = [];
  let cursor: string | undefined;
  do {
    const page = await s.listRunbooks({ status: ['published'], limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

/** A run-authored proposal past its fourteen days. */
export function isExpired(p: RunbookProposal, nowMs: number): boolean {
  return p.status === 'open' && p.source.kind === 'run' && nowMs - Date.parse(p.created_at) > PROPOSAL_EXPIRY_DAYS * DAY_MS;
}

/** Withdraw every run-authored proposal nobody decided in fourteen days. Returns the ids. */
export async function expireStaleProposals(s: RunbookStore, at: string): Promise<string[]> {
  const nowMs = Date.parse(at);
  const out: string[] = [];
  for (const p of await allProposals(s, { status: ['open'] })) {
    if (!isExpired(p, nowMs)) continue;
    try {
      await s.decideProposal({
        proposal_id: p.id, decision: 'withdrawn', decided_by: 'system', at, closed_reason: 'expired',
        note: `Expired: nobody decided it in ${PROPOSAL_EXPIRY_DAYS} days.`,
      });
      out.push(p.id);
    } catch { /* decided meanwhile */ }
  }
  return out;
}

/** The runs's open proposals, withdrawn because a person rejected the change it made. */
export async function withdrawForRejectedChange(changeRequestId: string, deps: Partial<UpkeepDeps> = {}): Promise<string[]> {
  const reports = deps.reports ?? (await import('../run-reports/store-select.js')).runReportStore();
  const runbooks = deps.runbooks ?? (await import('./store-select.js')).runbookStore();
  const at = (deps.nowIso ?? (await import('../../mock/core/clock.js')).clock.nowIso)();
  const { allReports } = await import('../run-reports/record.js');
  const runs = new Set((await allReports(reports)).filter((r) => r.changes.changeRequestId === changeRequestId).map((r) => r.runRef));
  if (runs.size === 0) return [];
  const out: string[] = [];
  for (const p of await allProposals(runbooks, { status: ['open'] })) {
    if (p.source.kind !== 'run' || !p.source.run_ref || !runs.has(p.source.run_ref)) continue;
    try {
      await runbooks.decideProposal({
        proposal_id: p.id, decision: 'withdrawn', decided_by: 'system', at, closed_reason: 'change-rejected',
        note: 'Withdrawn: the change this run made was rejected.',
      });
      out.push(p.id);
    } catch { /* decided meanwhile */ }
  }
  return out;
}

const succeeded = (r: RunReport) => r.outcome === 'done' || r.outcome === 'needs-review';

/** Was the run given `id`? The brief's offer, or the run's own account of it (it names only what it was given). */
export function wasGiven(r: RunReport, id: string): boolean {
  return r.runbooksOffered.some((o) => o.id === id) || (r.runbookAccounts ?? []).some((a) => a.id === id);
}

/** Did the run follow `id`, by its own account, or by loading it in a run that said nothing about it? */
export function followed(r: RunReport, id: string): boolean {
  const a = (r.runbookAccounts ?? []).find((x) => x.id === id);
  if (a) return a.followed !== 'no';
  return r.runbooksUsed.some((u) => u.id === id);
}

/**
 * The organisation's current model: LEARNING_LOOP_CURRENT_MODEL when set, else the model of the
 * newest successful run. "After a model change" then means "after runs started using another one".
 */
export function currentModel(reports: readonly RunReport[]): string | null {
  const pinned = process.env['LEARNING_LOOP_CURRENT_MODEL']?.trim();
  if (pinned) return pinned;
  const newest = reports.filter((r) => succeeded(r) && r.model).sort((a, b) => b.endedAt.localeCompare(a.endedAt))[0];
  return newest?.model ?? null;
}

export interface RetireDue { runbookId: string; rule: NonNullable<RunbookProposal['retire_evidence']>['rule']; runRefs: string[]; model: string | null; rationale: string }

/** Three consecutive successful runs on the current model, given `id`, each said it did not follow it. */
export function unfollowedDue(id: string, reports: readonly RunReport[], model: string | null): RetireDue | null {
  if (!model) return null;
  const runs = reports
    .filter((r) => succeeded(r) && r.model === model && wasGiven(r, id))
    .sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.runRef.localeCompare(b.runRef))
    .slice(0, RETIRE_UNFOLLOWED_RUNS);
  if (runs.length < RETIRE_UNFOLLOWED_RUNS) return null;
  if (!runs.every((r) => (r.runbookAccounts ?? []).some((a) => a.id === id && a.followed === 'no'))) return null;
  const refs = runs.map((r) => r.runRef);
  return {
    runbookId: id, rule: 'unfollowed', runRefs: refs, model,
    rationale: `The last ${RETIRE_UNFOLLOWED_RUNS} successful runs on ${model} that were given ${id} each said they did not follow it (${refs.join(', ')}). The model may no longer need it.`,
  };
}

/** Given to five or more runs in sixty days and followed by none; or, for a runbook older than ninety days, given to none in ninety. */
export function disuseDue(rb: Runbook, reports: readonly RunReport[], appliedAt: readonly string[], nowMs: number): RetireDue | null {
  const inWindow = (iso: string, days: number) => nowMs - Date.parse(iso) <= days * DAY_MS;
  const given60 = reports.filter((r) => wasGiven(r, rb.id) && inWindow(r.endedAt, DISUSE_GIVEN_WINDOW_DAYS));
  if (given60.length >= DISUSE_GIVEN_MIN && !given60.some((r) => followed(r, rb.id))) {
    const refs = given60.map((r) => r.runRef).slice(0, 10);
    return {
      runbookId: rb.id, rule: 'disuse-unfollowed', runRefs: refs, model: null,
      rationale: `${rb.id} was given to ${given60.length} runs in the last ${DISUSE_GIVEN_WINDOW_DAYS} days and none followed it (${refs.join(', ')}).`,
    };
  }
  const old = nowMs - Date.parse(rb.created_at) > DISUSE_UNGIVEN_DAYS * DAY_MS;
  const given90 = reports.some((r) => wasGiven(r, rb.id) && inWindow(r.endedAt, DISUSE_UNGIVEN_DAYS))
    || appliedAt.some((at) => inWindow(at, DISUSE_UNGIVEN_DAYS));
  if (old && !given90) {
    return {
      runbookId: rb.id, rule: 'disuse-ungiven', runRefs: [], model: null,
      rationale: `No run has been given ${rb.id} in the last ${DISUSE_UNGIVEN_DAYS} days.`,
    };
  }
  return null;
}

/** File one retire proposal, unless one is open, or one was rejected inside the cool-off. */
export async function fileRetire(s: RunbookStore, due: RetireDue, at: string): Promise<RunbookProposal | null> {
  const rb = await s.getRunbook(due.runbookId);
  if (!rb || rb.status !== 'published') return null;
  const mine = await allProposals(s, { runbook_id: rb.id });
  const nowMs = Date.parse(at);
  if (mine.some((p) => p.kind === 'retire' && p.status === 'open')) return null;
  if (mine.some((p) => p.kind === 'retire' && p.status === 'rejected' && p.decided_at && nowMs - Date.parse(p.decided_at) < RETIRE_COOLOFF_DAYS * DAY_MS)) return null;
  const proposal: RunbookProposal = {
    id: `prop-${randomUUID().slice(0, 12)}`, kind: 'retire', runbook_id: rb.id, base_version: rb.current_version,
    proposed: null, rationale: due.rationale,
    source: { kind: 'system', lab_experience_ids: [] },
    lint: [], similar: [], status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: at,
    retire_evidence: { rule: due.rule, run_refs: due.runRefs, model: due.model },
  };
  await s.putProposal(proposal);
  await (await import('./notices.js')).notifyFiled(s, proposal);
  return proposal;
}

/** Everything a saved report can make due. Never throws past its caller's try. */
export async function afterReportSaved(report: RunReport, deps: UpkeepDeps): Promise<{ expired: string[]; retired: string[] }> {
  const at = deps.nowIso();
  const nowMs = Date.parse(at);
  const expired = await expireStaleProposals(deps.runbooks, at);
  // Three days before the rest expire, their reviewers hear about it once. Best effort.
  try {
    const { notifyExpiring } = await import('./notices.js');
    await notifyExpiring(deps.runbooks, await allProposals(deps.runbooks, { status: ['open'] }), at);
  } catch { /* the sweep never fails over a notice */ }
  const { allReports } = await import('../run-reports/record.js');
  const reports = await allReports(deps.reports);
  // Debrief requests whose worker never came back free their place in the queue (and their hold).
  const { expireDebrief } = await import('./debrief-file.js');
  for (const r of reports) {
    if (r.debrief?.state === 'requested') await expireDebrief(r, { reports: deps.reports, nowIso: deps.nowIso }).catch(() => false);
  }
  const model = currentModel(reports);
  const retired: string[] = [];

  // Unfollowed: only the runbooks this run said it did not follow can have just become due.
  // A restored runbook starts again: runs that ended before its restore do not count against it,
  // or a runbook people just brought back would be proposed for retirement by the next sweep.
  const published = await allRunbooks(deps.runbooks);
  const restoredAt = new Map(published.filter((rb) => rb.restored).map((rb) => [rb.id, rb.restored!.at]));
  const since = (id: string): readonly RunReport[] => {
    const at = restoredAt.get(id);
    return at ? reports.filter((r) => r.endedAt > at) : reports;
  };
  for (const a of report.runbookAccounts ?? []) {
    if (a.followed !== 'no' || !succeeded(report)) continue;
    const due = unfollowedDue(a.id, since(a.id), model);
    if (due) { const p = await fileRetire(deps.runbooks, due, at); if (p) retired.push(p.id); }
  }
  // Disuse: any published runbook.
  for (const rb of published) {
    const from = rb.restored?.at;
    const applied = (await deps.runbooks.listApplications(rb.id)).map((x) => x.at).filter((x) => !from || x > from);
    const due = disuseDue(from ? { ...rb, created_at: from } : rb, since(rb.id), applied, nowMs);
    if (due) { const p = await fileRetire(deps.runbooks, due, at); if (p) retired.push(p.id); }
  }
  return { expired, retired };
}
