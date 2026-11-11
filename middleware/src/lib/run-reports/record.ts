// recordRunEnd — the ONE place a run's end becomes a run report
// (docs/learning-loop-design.md §1). Every executor's completion point calls it:
//
//   fleet job          lib/job-dispatcher.ts      runJob (done/failed, and the claimed-without-a-box failure)
//   microVM job        lib/microvm-dispatcher.ts  runMicrovmJob's completion (deps.recordRunEnd)
//   governed run       lib/sdlc-pipeline.ts       dispatchGovernedRun, after the run and its capture
//   local compute      routes/local-compute.ts    POST /jobs/:id/complete (with the worker's part)
//   the mock           lib/bot-runner.ts          settleSimulatedRun (a fixture's worker part)
//   bot runs           a bot run is one of the above underneath (a queue job or a governed run),
//                      so its report is that run's; the bot_run row is accounting only.
//
// What it does, in order: read what the server already knows (the frozen
// brief, the job row, the change request), take the worker's part (the local
// worker's completion body, or a devbox runner's own stream: its final message
// and the skills it loaded), parse and cap it, store the report
// write-once, then write one application row per runbook the run was given,
// from the run's OWN account of it (lane C, decision 22), so
// lib/runbooks/health.ts moves; then decide the debrief
// (lib/runbooks/debrief.ts) and do the library upkeep a saved report can make
// due (lib/runbooks/retire.ts: expiry, retire proposals).
//
// It never throws: a run's end must not fail because its report could not be
// written. A failure is logged and answered with null.
import { createHash } from 'node:crypto';
import { clock } from '../../mock/core/clock.js';
import { AlreadyExistsError, type RunbookStore, type SessionBrief } from '../runbooks/index.js';
import { cleanText, parseLabReport } from './self-report.js';
import { SKILL_NAME_RE } from './use-detection.js';
import type { RunReportStore } from './store.js';
import {
  RUN_REPORT_LIMITS as L,
  type RunExecutor, type RunOutcome, type RunReport, type RunReportChangedFile, type RunReportCost, type RunReportKept,
  type RunReportRunbookRef, type RunReportUse, type WorkerReportPart, type RunDebrief, type RunReportRunbookAccount,
} from './types.js';
import type { ApplicationOutcome } from '../runbooks/types.js';

export interface RunEndInput {
  runRef: string;
  executor: RunExecutor;
  outcome: RunOutcome;
  failureCode?: string | null;
  /** Server-known; read from the job row / brief when omitted. */
  workItemId?: string | null;
  initiativeId?: string | null;
  model?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  /** What the ledger was charged (0 for local; null when unknown). */
  billedUsd?: number | null;
  /** The cost figure is a fixture (the mock), never money. */
  simulated?: boolean;
  /** A governed run's change request id; its files and line counts are read from it. */
  changeRequestId?: string | null;
  /** Files the executor already knows changed, when there is no change request. */
  changedFiles?: RunReportChangedFile[];
  /** The worker's own account (untrusted). null/omitted: the run said nothing (selfReport 'missing'). */
  worker?: WorkerReportPart | null;
  /** Local compute: whether the run had a checkout of its own to write a debrief folder in. */
  hasCheckout?: boolean;
  /** Skip the debrief decision (a caller that has none to make, or a test). */
  noDebrief?: boolean;
}

export interface RecordDeps {
  reports?: RunReportStore;
  runbooks?: RunbookStore;
  nowIso?: () => string;
}

type Listener = (report: RunReport) => void | Promise<void>;
const listeners = new Set<Listener>();

/**
 * Subscribe to newly stored reports (once per run). Lane C's distiller hangs
 * off this. A listener's failure never reaches the run.
 */
export function onRunReportSaved(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A queue job's terminal status, as a report outcome. */
export function outcomeOfJobStatus(status: string): RunOutcome {
  if (status === 'done') return 'done';
  if (status === 'awaiting_review') return 'needs-review';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

/** A failure message → a short code: the gate name a caller already has, else the first words. */
export function failureCodeOf(error: string | null | undefined): string | null {
  if (!error) return null;
  const s = cleanText(error, 400, { singleLine: true }).toLowerCase();
  if (!s) return null;
  if (/claim.*(lost|no longer live)|requeued/.test(s)) return 'claim_lost';
  if (/budget|ceiling|spend/.test(s)) return 'budget';
  if (/timed? ?out|timeout|overrun|stale/.test(s)) return 'timeout';
  const exit = /exit(?:ed)?(?: code)? (\d+)/.exec(s);
  if (exit) return `exit_${exit[1]}`;
  return s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, L.failureCode) || null;
}

/** `+`/`-` counts per file from a unified diff. Files outside `diff --git` headers are ignored. */
export function numstatFromDiff(diff: string | null | undefined, files: readonly string[] = []): RunReportChangedFile[] {
  const out = new Map<string, { added: number; removed: number }>();
  let cur: { added: number; removed: number } | null = null;
  for (const line of (diff ?? '').split('\n')) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (h) { cur = { added: 0, removed: 0 }; out.set(h[2]!, cur); continue; }
    if (!cur || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) cur.added += 1;
    else if (line.startsWith('-')) cur.removed += 1;
  }
  const rows: RunReportChangedFile[] = [...out].map(([path, c]) => ({ path, added: c.added, removed: c.removed }));
  for (const f of files) if (!out.has(f)) rows.push({ path: f, added: null, removed: null });
  return capFiles(rows);
}

function capFiles(rows: readonly RunReportChangedFile[]): RunReportChangedFile[] {
  const out: RunReportChangedFile[] = [];
  for (const r of rows) {
    if (out.length >= L.files) break;
    const path = cleanText(r.path, L.path, { singleLine: true });
    if (!path) continue;
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
    out.push({ path, added: n(r.added), removed: n(r.removed) });
  }
  return out;
}

const money = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1_000_000 ? Math.round(v * 1e6) / 1e6 : null;

/** Cap and clean everything a worker sent. Pure; the parity test holds the worker's own caps to this. */
export function normalizeWorkerPart(part: unknown): Required<WorkerReportPart> {
  const p = (part && typeof part === 'object' && !Array.isArray(part) ? part : {}) as Record<string, unknown>;
  const block = typeof p['block'] === 'string' ? (p['block'].length > 4 * L.block ? p['block'].slice(-4 * L.block) : p['block']) : null;
  const skills: string[] = [];
  if (Array.isArray(p['skillsLoaded'])) {
    for (const s of p['skillsLoaded']) {
      if (skills.length >= L.runbooksUsed) break;
      if (typeof s === 'string' && s.length <= L.skillName && SKILL_NAME_RE.test(s) && !skills.includes(s)) skills.push(s);
    }
  }
  const kept: RunReportKept[] = [];
  if (Array.isArray(p['kept'])) {
    for (const k of p['kept']) {
      if (kept.length >= L.kept) break;
      if (!k || typeof k !== 'object') continue;
      const o = k as Record<string, unknown>;
      const name = cleanText(o['name'], L.skillName, { singleLine: true });
      if (!name) continue;
      const proposalId = typeof o['proposalId'] === 'string' && /^prop-[A-Za-z0-9-]{1,40}$/.test(o['proposalId']) ? o['proposalId'] : null;
      const problems = Array.isArray(o['problems'])
        ? o['problems'].slice(0, L.keptProblems).map((x) => cleanText(x, L.keptProblem, { singleLine: true })).filter(Boolean)
        : [];
      kept.push({ name, proposalId, problems });
    }
  }
  const sid = p['claudeSessionId'];
  const claudeSessionId = typeof sid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sid) ? sid : null;
  return { block, skillsLoaded: skills, kept, reportedCostUsd: money(p['reportedCostUsd']), claudeSessionId };
}

/**
 * The runbooks a brief OFFERED its run. Lane D stores the offer on the brief
 * (`offer.runbooks`); a v1 brief named the runbooks it inlined; a v2 brief
 * without an offer offered nothing (it pointed at the whole library).
 */
export function offeredFromBrief(brief: SessionBrief | null): RunReportRunbookRef[] {
  if (!brief) return [];
  const offer = (brief as SessionBrief & { offer?: { runbooks?: Array<{ id?: unknown; runbook_id?: unknown; version?: unknown }> } }).offer;
  if (offer?.runbooks?.length) {
    return offer.runbooks.flatMap((r) => {
      const id = typeof r.id === 'string' ? r.id : typeof r.runbook_id === 'string' ? r.runbook_id : null;
      return id ? [{ id, version: typeof r.version === 'number' ? r.version : null }] : [];
    });
  }
  return brief.sections.filter((s) => s.kind === 'runbook' && s.ref).map((s) => ({ id: s.ref!, version: s.version ?? null }));
}

/** The version of `id` the run was given, or undefined when the brief did not give it. */
function givenVersion(brief: SessionBrief | null, id: string): number | undefined {
  if (!brief) return undefined;
  const offered = offeredFromBrief(brief).find((r) => r.id === id);
  if (offered && offered.version !== null) return offered.version;
  if (brief.skill_library) return brief.skill_library.skills.find((k) => k.name === id)?.version;
  return brief.sections.find((s) => s.kind === 'runbook' && s.ref === id)?.version;
}

export const applicationId = (runRef: string, runbookId: string): string =>
  `app-${createHash('sha256').update(`${runRef}|${runbookId}`).digest('hex').slice(0, 12)}`;

async function serverFacts(input: RunEndInput): Promise<{
  workItemId: string | null; initiativeId: string | null; model: string | null; startedAt: string | null;
}> {
  let job: { payload: Record<string, unknown>; startedAt: string | null; claimedAt: string | null; result: Record<string, unknown> | null } | null = null;
  if (input.executor !== 'governed') {
    try { job = await (await import('../../providers/agent-jobs.js')).getJob(input.runRef); } catch { job = null; }
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    workItemId: input.workItemId ?? str(job?.payload['workItemId']),
    initiativeId: input.initiativeId ?? str(job?.payload['initiativeId']),
    model: input.model ?? str(job?.result?.['model']) ?? str(job?.payload['model']),
    startedAt: input.startedAt ?? job?.startedAt ?? job?.claimedAt ?? null,
  };
}

async function changesOf(input: RunEndInput): Promise<RunReport['changes']> {
  if (input.changeRequestId) {
    try {
      const cr = await (await import('../../providers/sdlc.js')).getChangeRequest(input.changeRequestId);
      if (cr) return { files: numstatFromDiff(cr.diff, cr.files), changeRequestId: cr.id };
    } catch { /* fall through to what the caller knows */ }
    return { files: capFiles(input.changedFiles ?? []), changeRequestId: input.changeRequestId };
  }
  return { files: capFiles(input.changedFiles ?? []), changeRequestId: null };
}

async function labApplied(store: RunbookStore, brief: SessionBrief | null, runRef: string): Promise<RunReportUse[]> {
  const names = brief?.skill_library?.skills.map((k) => k.name)
    ?? brief?.sections.filter((s) => s.kind === 'runbook' && s.ref).map((s) => s.ref!) ?? [];
  const out: RunReportUse[] = [];
  for (const id of names) {
    const a = (await store.listApplications(id)).find((x) => x.run_ref === runRef && x.outcome !== 'not_used');
    if (a) out.push({ id, version: a.version, source: 'lab-applied' });
  }
  return out;
}

function costOf(input: RunEndInput, reportedUsd: number | null): RunReportCost {
  const billed = money(input.billedUsd);
  if (input.simulated) return { billedUsd: billed, reportedUsd: null, basis: 'simulated' };
  if (input.executor === 'local') return { billedUsd: 0, reportedUsd, basis: 'reported' };
  return { billedUsd: billed, reportedUsd: null, basis: billed === null ? 'unknown' : 'billed' };
}

/** A run's account of one runbook, as an application row: a wrong step is a failure at that step. */
export function applicationOf(a: RunReportRunbookAccount): { outcome: ApplicationOutcome; step: number | null; note: string | null } {
  if (a.wrongStep !== null) return { outcome: 'failed', step: a.wrongStep, note: a.note };
  return { outcome: a.followed === 'yes' ? 'followed' : a.followed === 'partly' ? 'followed_with_deviation' : 'not_used', step: null, note: a.note };
}

/** Every stored report, all pages. */
export async function allReports(reports: RunReportStore): Promise<RunReport[]> {
  const out: RunReport[] = [];
  let cursor: string | undefined;
  do {
    const page = await reports.listReports({ limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.items);
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

/** Assemble, store (write-once) and announce a run's report; write its application rows. Never throws. */
export async function recordRunEnd(input: RunEndInput, deps: RecordDeps = {}): Promise<RunReport | null> {
  try {
    if (!input.runRef) return null;
    const reports = deps.reports ?? (await import('./store-select.js')).runReportStore();
    const existing = await reports.getReport(input.runRef);
    if (existing) return existing;
    const runbooks = deps.runbooks ?? (await import('../runbooks/store-select.js')).runbookStore();
    const now = deps.nowIso ?? (() => clock.nowIso());

    const brief = await runbooks.getBrief(input.runRef).catch(() => null);
    const facts = await serverFacts(input);
    const worker = normalizeWorkerPart(input.worker ?? null);
    const self = parseLabReport(worker.block);

    const observed: RunReportUse[] = worker.skillsLoaded
      .filter((s) => s.startsWith('rb-'))
      .map((id) => ({ id, version: givenVersion(brief, id) ?? null, source: 'observed' as const }));
    const applied = (await labApplied(runbooks, brief, input.runRef).catch(() => []))
      .filter((a) => !observed.some((o) => o.id === a.id));

    const endedAt = input.endedAt ?? now();
    const report: RunReport = {
      runRef: input.runRef,
      workItemId: facts.workItemId ?? brief?.work_item_id ?? null,
      initiativeId: facts.initiativeId ?? brief?.initiative_id ?? null,
      executor: input.executor,
      model: facts.model ? cleanText(facts.model, L.model, { singleLine: true }) || null : null,
      startedAt: facts.startedAt,
      endedAt,
      outcome: input.outcome,
      failureCode: input.outcome === 'failed' || input.outcome === 'cancelled'
        ? (input.failureCode ? cleanText(input.failureCode, L.failureCode, { singleLine: true }) : null)
        : null,
      summary: self.summary,
      changes: await changesOf(input),
      verification: self.verification,
      obstacles: self.obstacles,
      runbooksOffered: offeredFromBrief(brief),
      runbooksUsed: [...observed, ...applied].slice(0, L.runbooksUsed),
      cost: costOf(input, worker.reportedCostUsd),
      kept: worker.kept,
      selfReport: self.state,
      learned: self.learned,
      runbookAccounts: self.runbooks,
      debrief: null,
      claudeSessionId: worker.claudeSessionId,
      briefId: brief?.id ?? null,
      createdAt: now(),
    };

    const { report: stored, created } = await reports.putReport(report);
    if (!created) return stored;

    // Evidence (decision 22): one application row per runbook the run was GIVEN, from the run's
    // OWN account of it. What the run says it did with a runbook is what is written; a successful
    // run that loaded one and said nothing counts as having followed it; a failed run that says
    // nothing about a runbook writes no row for it (a run fails for many reasons, and health must
    // not drift by association). The id is the one `lab applied` writes (routes/runbooks.ts), so
    // the signals never double-count.
    if (brief && stored.outcome !== 'cancelled') {
      const succeeded = stored.outcome === 'done' || stored.outcome === 'needs-review';
      const rows = new Map<string, { outcome: ApplicationOutcome; step: number | null; note: string | null }>();
      for (const a of stored.runbookAccounts ?? []) rows.set(a.id, applicationOf(a));
      if (succeeded) for (const use of observed) if (!rows.has(use.id)) rows.set(use.id, { outcome: 'followed', step: null, note: null });
      for (const [id, row] of rows) {
        const version = givenVersion(brief, id);
        if (version === undefined) continue;
        try {
          await runbooks.appendApplication({
            id: applicationId(stored.runRef, id), runbook_id: id, version, run_ref: stored.runRef,
            brief_id: brief.id, outcome: row.outcome, failed_at_step: row.step, note: row.note, at: stored.endedAt,
          });
        } catch (e) {
          if (!(e instanceof AlreadyExistsError)) console.warn(`[run-reports] application for ${id} on ${stored.runRef}:`, (e as Error).message);
        }
      }
    }

    // Lane C: the debrief decision, stored on the run (its page says why there was none), then
    // the library upkeep a saved report can make due. Neither ever fails the run.
    let final = stored;
    if (!input.noDebrief) {
      try {
        const { decideDebrief } = await import('../runbooks/debrief.js');
        const decision: RunDebrief = await decideDebrief(stored, {
          runbooks, nowIso: now, reports: () => allReports(reports),
          ...(input.hasCheckout !== undefined ? { hasCheckout: input.hasCheckout } : {}),
        });
        final = (await reports.setDebrief(stored.runRef, decision, null)) ?? stored;
      } catch (e) {
        console.warn(`[run-reports] debrief decision for ${stored.runRef}:`, (e as Error).message);
      }
    }
    try {
      const { afterReportSaved } = await import('../runbooks/retire.js');
      await afterReportSaved(final, { runbooks, reports, nowIso: now });
    } catch (e) {
      console.warn(`[run-reports] library upkeep after ${stored.runRef}:`, (e as Error).message);
    }

    for (const fn of listeners) {
      try { void Promise.resolve(fn(final)).catch((e: unknown) => console.warn('[run-reports] listener failed:', (e as Error).message)); } catch { /* never the run's problem */ }
    }
    return final;
  } catch (err) {
    console.warn(`[run-reports] could not record the report for ${input.runRef}:`, (err as Error).message);
    return null;
  }
}
