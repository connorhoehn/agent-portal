// Promotions inbox — the missing middle of the promotion ladder.
//
//   OBSERVATION (one thing that happened once, written by `lab` into
//   lab_experiences) → seen >=3 times across >=2 sessions → PATTERN →
//   has a repeatable trigger AND outcome → RUNBOOK, else → INSIGHT (a fact
//   injected, never run) → human approval + a completed dry-run RUN of its
//   runbook definition (pipelines tenant, rule 1) → SKILL.
//   Drift detection can send a SKILL back to RUNBOOK.
//
// lab_experiences already stores the raw material; nothing curates it into
// this ladder today. This module is that curation step: cluster the raw
// observations, decide which clusters are real patterns, classify each
// pattern, and gate every step up the ladder with a pure decision function —
// same separation as design-reviews.ts, because the same shape of problem
// applies (a human ratifies a machine-proposed graduation, refusably).
//
// Clustering is deliberately NOT ML: normalized-token Jaccard overlap, same
// as a person skimming titles would do it. The ladder only earns trust if a
// reviewer can see WHY two observations were called "the same thing" — a
// black-box embedding score doesn't answer that, a shared-words score does.
//
// Aurora path: lab_experiences has no promotion/cluster tables yet — this is
// mock-first like the rest of the lab loop's downstream surfaces.

import { config } from '../config.js';
// The candidates live behind a registered fixture, so a promote or a dismiss
// is undone by `POST /api/__mock/reset` instead of standing until the process
// restarts. See mock/promotions.ts for why that mattered here in particular.
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

export type ProposedKind = 'insight' | 'runbook' | 'skill';
export type PromotionStatus = 'candidate' | 'approved' | 'dismissed' | 'promoted';

export interface PromotionCandidate {
  id: string;
  proposedKind: ProposedKind;
  title: string;
  /** Why the cluster earned this proposed kind — the reviewer's whole basis
   *  for a decision, since they were not there for any of the sessions. */
  rationale: string;
  /**
   * How many observations back this cluster, and how many distinct sessions
   * they came from. DERIVED on every read from `observations` (see
   * `toCandidate`), never stored — they are the two numbers the promotion
   * floor is written in terms of (`qualifiesAsPattern`: >=3 sightings across
   * >=2 sessions), and a stored copy beside the rows it counts is rule 1 of
   * the mock floor. One of them had already drifted in the fixture.
   */
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
  /**
   * DERIVED from `dryRun` for the readers that still speak the boolean (the
   * orgiq promotions page): true = its run completed, false = it failed,
   * null = no run or one still going. Never accepted as evidence on a write.
   */
  dryRunPassed: boolean | null;
  /** Set when drift detection demoted this candidate from an existing skill
   *  back down to a runbook — the id of the skill it fell from. */
  driftedFrom?: string;
}

/**
 * A candidate as it is STORED — everything a reader sees except the two
 * numbers that fall out of `observations`. The mock fixture holds these; the
 * Aurora path, when there is one, will project the counts in SQL the same way.
 */
export type SeededCandidate = Omit<PromotionCandidate, 'supportCount' | 'sessionCount' | 'dryRun' | 'dryRunPassed'>;

/** The run a promotion verdict is judged on (a `pipeline_runs` record, narrowed). */
export interface DryRunRef {
  runId: string;
  definitionId: string;
  status: string;
  finishedAt?: string | null;
}

/** A cluster is the pre-candidate grouping: observations that look like the
 *  same recurring thing, before anyone has decided they qualify as a pattern
 *  or classified what kind of asset they should become. */
export interface Cluster {
  key: string;
  observations: Observation[];
}

// ─── Pure decision rules (unit-tested) ───────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'was',
  'were', 'are', 'has', 'have', 'had', 'not', 'but', 'its', 'it', 'a', 'an',
  'to', 'of', 'in', 'on', 'at', 'as', 'by', 'is', 'be', 'or', 'so', 'than',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const CLUSTER_THRESHOLD = 0.2;

/**
 * Group observations that look like the same recurring thing. Explainable on
 * purpose: normalized token overlap on title+body, same rule a person skims
 * for. A shared repo halves the bar — two unrelated repos can both mention
 * "timeout" and "retry", but the same repo saying similar words about the
 * same failure is much more likely to be one recurring event.
 */
export function clusterObservations(observations: Observation[]): Cluster[] {
  const working: Array<{ key: string; tokens: Set<string>; repo: string | null; observations: Observation[] }> = [];

  for (const ob of observations) {
    const obTokens = tokenize(`${ob.title} ${ob.body}`);
    let match: (typeof working)[number] | null = null;
    for (const cluster of working) {
      const sameRepo = cluster.repo != null && ob.repo != null && cluster.repo === ob.repo;
      const score = jaccard(obTokens, cluster.tokens);
      const bar = sameRepo ? CLUSTER_THRESHOLD / 2 : CLUSTER_THRESHOLD;
      if (score >= bar) { match = cluster; break; }
    }
    if (match) {
      match.observations.push(ob);
      for (const t of obTokens) match.tokens.add(t);
      if (!match.repo && ob.repo) match.repo = ob.repo;
    } else {
      working.push({ key: `cl-${working.length + 1}`, tokens: obTokens, repo: ob.repo, observations: [ob] });
    }
  }

  return working.map((c) => ({ key: c.key, observations: c.observations }));
}

/** The promotion floor: an isolated incident is a story, not a pattern. Three
 *  sightings in one session is one long incident told three times — it takes
 *  a second session to show the thing actually recurs. */
export function qualifiesAsPattern(cluster: Pick<Cluster, 'observations'>): boolean {
  if (cluster.observations.length < 3) return false;
  return new Set(cluster.observations.map((o) => o.sessionId)).size >= 2;
}

const ACTIONABLE_VERBS = [
  'retry', 'restart', 'redeploy', 'revoke', 'poll', 'pin', 'drain', 'patch',
  'rebuild', 'switch', 'gate', 'reconcile', 'provision', 'install', 'bump',
  'wait', 'preflight', 'wrap', 'reorder', 'grant',
];

/**
 * A RUNBOOK is a procedure: given this trigger, do this, and it resolves.
 * That claim needs evidence the fix actually WORKED (or was a ratified
 * `decision`, not just a hunch) AND that the fix is describable as an action
 * — a cluster of pure `gotcha`/`convention` observations is real knowledge,
 * but it is a fact to hand the model, not a sequence to run. Those become
 * INSIGHT instead.
 */
export function classifyPattern(cluster: Pick<Cluster, 'observations'>): 'runbook' | 'insight' {
  const hasOutcome = cluster.observations.some((o) => o.kind === 'worked' || o.kind === 'decision');
  const text = cluster.observations.map((o) => `${o.title} ${o.body}`).join(' ').toLowerCase();
  const hasTrigger = ACTIONABLE_VERBS.some((v) => text.includes(v));
  return hasOutcome && hasTrigger ? 'runbook' : 'insight';
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
  if (!dryRun) return { ok: false, reason: `a skill needs a completed dry-run of ${own} — start one from /pipelines/runbooks` };
  if (dryRun.definitionId !== own) {
    return { ok: false, reason: `run ${dryRun.runId} is a dry-run of ${dryRun.definitionId}, not of ${own} — a skill stands on its own runbook's run` };
  }
  if (dryRun.status === 'failed') return { ok: false, reason: `dry run ${dryRun.runId} failed — fix it and rerun before promoting` };
  if (dryRun.status !== 'completed') return { ok: false, reason: `dry run ${dryRun.runId} is ${dryRun.status}, not completed — promote once it finishes` };
  return { ok: true };
}

/**
 * May this candidate be promoted right now? Mirrors decideApproval's shape:
 * a candidate that is already terminal refuses outright, everything else
 * needs a human's name on it — and a SKILL additionally needs a completed
 * dry-run of its own runbook definition (decideDryRunGate), because a skill
 * runs unattended and a runbook does not.
 */
export function decidePromotion(
  candidate: Pick<PromotionCandidate, 'id' | 'status' | 'proposedKind'>,
  ctx: { approvedBy: string | null; dryRun: DryRunRef | null },
): { ok: true } | { ok: false; reason: string } {
  if (candidate.status === 'promoted') return { ok: false, reason: 'already promoted' };
  if (candidate.status === 'dismissed') return { ok: false, reason: 'dismissed — reopen it before promoting' };
  if (!ctx.approvedBy) return { ok: false, reason: 'needs human approval first' };
  if (candidate.proposedKind === 'skill') return decideDryRunGate(candidate, ctx.dryRun);
  return { ok: true };
}

// ─── Provider ────────────────────────────────────────────────────────────────

/**
 * Project a stored candidate for the wire: the counts are computed here, from
 * the observations that are right there in the row, so they cannot drift from
 * them. `sessionCount` is DISTINCT sessions — three sightings inside one
 * session is one long incident told three times, which is the whole reason
 * `qualifiesAsPattern` asks for two.
 */
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
  // Aurora path: lab_experiences has no clustering/promotion tables yet;
  // mock-first like the rest of the lab loop's downstream surfaces.
  void config;
  let list = promotionCandidates.rows().slice();
  if (opts.status) list = list.filter((c) => c.status === opts.status);
  const runs = await runRefs();
  return list.map((c) => toCandidate(c, runs)).sort((a, b) => b.supportCount - a.supportCount);
}

export async function getCandidate(id: string): Promise<PromotionCandidate | null> {
  const c = promotionCandidates.rows().find((x) => x.id === id);
  return c ? toCandidate(c, await runRefs()) : null;
}

/**
 * Human approves. For a SKILL the verdict is judged on a recorded run: the one
 * named (`dryRunRunId`), else the newest completed dry-run of this candidate's
 * runbook definition, else its newest dry-run. A client can no longer assert
 * that a dry run passed — the run says so or nothing does.
 *
 * Refused by decidePromotion, the approval still LANDS: a skill refused only
 * for its dry-run has genuinely cleared the human gate, and the next call
 * after a completed run should not have to re-ask for approval. That is the
 * `status: 'approved'` resting state between `candidate` and `promoted`. The
 * run the verdict was judged on is recorded on the candidate either way.
 */
export async function promoteCandidate(
  id: string, opts: { approvedBy: string; dryRunRunId?: string | null },
): Promise<{ candidate: PromotionCandidate; error?: never } | { candidate?: never; error: string } | null> {
  const c = promotionCandidates.rows().find((x) => x.id === id);
  if (!c) return null;

  let dryRun: DryRunRef | null = null;
  if (c.proposedKind === 'skill') {
    const refs = await runRefs();
    if (opts.dryRunRunId) {
      dryRun = refs.get(opts.dryRunRunId) ?? null;
      if (!dryRun) {
        if (c.status === 'candidate') c.status = 'approved';
        return { error: `no recorded run ${opts.dryRunRunId}` };
      }
    } else {
      const { latestDryRunOf } = await import('./pipeline-definitions.js');
      const latest = await latestDryRunOf(runbookDefinitionIdOf(c.id)).catch(() => null);
      dryRun = latest ? refs.get(latest.id) ?? { runId: latest.id, definitionId: latest.definitionId, status: latest.status } : null;
    }
    if (dryRun && dryRun.definitionId === runbookDefinitionIdOf(c.id)) c.dryRunRunId = dryRun.runId;
  }
  const gate = decidePromotion(c, { approvedBy: opts.approvedBy, dryRun });
  if (!gate.ok) {
    if (c.status === 'candidate') c.status = 'approved';
    return { error: gate.reason };
  }
  c.status = 'promoted';
  return { candidate: toCandidate(c, await runRefs()) };
}

export async function dismissCandidate(id: string, reason: string): Promise<PromotionCandidate | null> {
  const c = promotionCandidates.rows().find((x) => x.id === id);
  if (!c) return null;
  c.status = 'dismissed';
  c.rationale = `${c.rationale} — dismissed: ${reason.trim()}`;
  return toCandidate(c, await runRefs());
}
