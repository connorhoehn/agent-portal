// The pipelines tenant's runbook definitions are read from here: a fixed set of
// seeded candidates (mock/promotions.ts), each a cluster of observations, with
// the dry-run each one's verdict stands on resolved from `pipeline_runs`.
// There is no Aurora table behind them; every environment reads the fixture.

import { promotionCandidates } from '../mock/promotions.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ObservationKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';

export interface Observation {
  id: string;
  kind: ObservationKind;
  title: string;
  body: string;
  repo: string | null;
  initiativeId: string | null;
  sessionId: string;
  createdAt: string;
}

export type ProposedKind = 'runbook' | 'skill';
export type PromotionStatus = 'candidate' | 'approved' | 'dismissed' | 'promoted';

export interface PromotionCandidate {
  id: string;
  proposedKind: ProposedKind;
  title: string;
  /** Why the cluster earned this proposed kind. */
  rationale: string;
  /** How many observations back this cluster, and from how many distinct
   *  sessions. Derived on every read from `observations`, never stored. */
  supportCount: number;
  sessionCount: number;
  observations: Observation[];
  status: PromotionStatus;
  /**
   * The dry-run this candidate's verdict stands on — a `pipeline_runs` id
   * (`job:<uuid>`), the run of its runbook definition `runbook:<id>` that the
   * pipelines tenant started (POST /api/pipelines/definitions/:id/dry-run).
   * STORED: the run, not a claim about it. null until a dry-run has been
   * resolved against this candidate.
   */
  dryRunRunId: string | null;
  /** That run as it stands now — DERIVED per read from `pipeline_runs`, never stored. */
  dryRun: DryRunRef | null;
  /** Derived from `dryRun`: true = completed, false = failed, null = no run or one still going. */
  dryRunPassed: boolean | null;
  /** The id of the skill this candidate's seed says it was demoted from. */
  driftedFrom?: string;
}

/** A candidate as the fixture stores it: everything except the derived fields. */
export type SeededCandidate = Omit<PromotionCandidate, 'supportCount' | 'sessionCount' | 'dryRun' | 'dryRunPassed'>;

/** The run a promotion verdict is judged on (a `pipeline_runs` record, narrowed). */
export interface DryRunRef {
  runId: string;
  definitionId: string;
  status: string;
  finishedAt?: string | null;
}

/** The runbook definition a candidate is — the id its dry-runs are runs of. */
export const runbookDefinitionIdOf = (candidateId: string): string => `runbook:${candidateId}`;

/**
 * Rule 1 of docs/social-tenant-design.md §5.2: a RUNBOOK becomes a SKILL only
 * on a `completed` run of ITS OWN definition. Each refusal says which of the
 * four facts failed, because the reviewer's next step differs: start a
 * dry-run, wait for one, fix a failed one, or stop citing another runbook's.
 */
export function decideDryRunGate(
  candidate: Pick<PromotionCandidate, 'id'>,
  dryRun: DryRunRef | null,
): { ok: true } | { ok: false; reason: string } {
  const own = runbookDefinitionIdOf(candidate.id);
  // No route in the reason: it is read by both tenants (the orgiq promote
  // 409 and the pipelines runbook view), and an orgiq reviewer pointed at a
  // pipelines page they hold no grant in had no remedy at all (sme #19).
  if (!dryRun) return { ok: false, reason: `a skill needs a completed dry-run of ${own}, and none is recorded yet` };
  if (dryRun.definitionId !== own) {
    return { ok: false, reason: `run ${dryRun.runId} is a dry-run of ${dryRun.definitionId}, not of ${own} — a skill stands on its own runbook's run` };
  }
  if (dryRun.status === 'failed') return { ok: false, reason: `dry run ${dryRun.runId} failed — fix it and rerun before promoting` };
  if (dryRun.status !== 'completed') return { ok: false, reason: `dry run ${dryRun.runId} is ${dryRun.status}, not completed — promote once it finishes` };
  return { ok: true };
}

// ─── Provider ────────────────────────────────────────────────────────────────

/** Project a stored candidate for the wire; `sessionCount` counts distinct sessions. */
function toCandidate(c: SeededCandidate, runs: ReadonlyMap<string, DryRunRef>): PromotionCandidate {
  const dryRun = c.dryRunRunId ? runs.get(c.dryRunRunId) ?? null : null;
  return {
    ...c,
    supportCount: c.observations.length,
    sessionCount: new Set(c.observations.map((o) => o.sessionId)).size,
    dryRun,
    dryRunPassed: dryRun?.status === 'completed' ? true : dryRun?.status === 'failed' ? false : null,
  };
}

/** Every recorded pipelines run, by id — what `dryRunRunId` resolves against. */
async function runRefs(): Promise<Map<string, DryRunRef>> {
  try {
    const { listRunRecords } = await import('./pipeline-definitions.js');
    return new Map((await listRunRecords()).map((r) => [r.id, {
      runId: r.id, definitionId: r.definitionId, status: r.status, finishedAt: r.finishedAt,
    }]));
  } catch (err) {
    // pipeline_runs unreadable (a cluster without pipeline_schema.sql): every
    // candidate then reads "no run", which refuses promotion — the safe side.
    console.warn('[promotions] pipeline_runs unreadable:', (err as Error).message);
    return new Map();
  }
}

export async function listCandidates(opts: { status?: string } = {}): Promise<PromotionCandidate[]> {
  let list = promotionCandidates.rows().slice();
  if (opts.status) list = list.filter((c) => c.status === opts.status);
  const runs = await runRefs();
  return list.map((c) => toCandidate(c, runs)).sort((a, b) => b.supportCount - a.supportCount);
}
