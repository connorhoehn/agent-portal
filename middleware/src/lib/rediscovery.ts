// Short-circuiting rediscovery — look before you spend.
//
// An agent is about to spend forty minutes and forty thousand tokens working
// out why an ECS rollout is stuck. Somebody already did that — in August, on a
// different project, on someone else's laptop. The knowledge exists, it is
// indexed, and nothing in the system currently makes the agent look before it
// spends. This module is the looking.
//
// Two things have to be true that are not true of `lab recall` today:
//
//   1. RETRIEVAL CANNOT BE SCOPED BY REPO. `listExperiences` filters on repo or
//      initiative, and both indexes on lab_experiences are built that way — so
//      recall is scoped to where the knowledge was WRITTEN rather than to the
//      problem it is ABOUT, which is exactly backwards for rediscovery. The
//      August lesson lives under a different repo and a repo-scoped query can
//      never see it. Here the repo is a RANKING signal, never a filter.
//
//   2. A MATCH IS A CANDIDATE, NOT AN ANSWER. The August fix may be stale — a
//      different CDK version, an account rule that has since changed. Replaying
//      it blind trades a forty-minute rediscovery for a confidently wrong path,
//      which is worse than the rediscovery. So every match carries a verdict
//      and the evidence for it, and the caller is told what is uncertain.
//
// Pure: no AWS, no Aurora. The ranking and the verdicts are the whole product
// here, so they are testable without a database.

// ─── Types ───────────────────────────────────────────────────────────────────

export type ExperienceKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';

export interface Experience {
  id: string;
  kind: ExperienceKind;
  title: string;
  body: string;
  repo: string | null;
  sessionId: string;
  createdAt: string;
}

export type Verdict = 'applies' | 'partial' | 'stale';

export interface Match {
  experienceId: string;
  title: string;
  body: string;
  kind: ExperienceKind;
  repo: string | null;
  sessionId: string;
  ageDays: number;
  score: number;
  /** Learned on a different repo than the one asking. The payoff case: this is
   *  precisely the knowledge a repo-scoped recall can never reach. */
  crossProject: boolean;
  verdict: Verdict;
  why: string;
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

/** Below this a match is not worth a human's attention at a spend moment. */
export const SCORE_FLOOR = 0.25;
/** Above this the shapes agree enough to call it the same problem. */
export const STRONG_SCORE = 0.5;

// ─── Problem shape ───────────────────────────────────────────────────────────

/** Prose that carries no signal about WHICH problem this is. Dropped before
 *  scoring so "the deploy is stuck" cannot match "the test is stuck". */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'and', 'or', 'but', 'with', 'without', 'this', 'that', 'it',
  'its', 'as', 'at', 'by', 'from', 'we', 'i', 'you', 'not', 'no', 'why', 'how',
  'when', 'what', 'which', 'after', 'before', 'then', 'than', 'so', 'if',
  'has', 'have', 'had', 'do', 'does', 'did', 'can', 'will', 'would', 'should',
  'my', 'our', 'your', 'their', 'there', 'here', 'about', 'into', 'out', 'up',
]);

/**
 * A token that identifies a problem rather than describes it: an exception
 * name, an identifier, an error code, a flag. These carry nearly all the
 * cross-project signal — `HttpEndpointNotEnabledException` means the same thing
 * in any repo, while "failed" means nothing on its own — so they are weighted
 * far above prose.
 */
function isDistinctive(token: string): boolean {
  return (
    /[A-Z][a-z]+[A-Z]/.test(token) ||        // CamelCase / PascalCase
    /^[A-Z0-9_]{4,}$/.test(token) ||         // SCREAMING_SNAKE / error codes
    /_/.test(token) ||                       // snake_case
    /^\d{3}$/.test(token) ||                 // HTTP status
    /[.:/-].*[a-z]/i.test(token) && token.length > 8  // paths, image refs, arns
  );
}

const WEIGHT_DISTINCTIVE = 4;
const WEIGHT_PROSE = 1;
/** A prose-only overlap has to be SUBSTANTIAL before it means anything: below
 *  this, shared ordinary words are coincidence. */
const PROSE_ONLY_MIN = 0.55;
/** Penalty applied to a prose-only overlap that misses PROSE_ONLY_MIN. */
const PROSE_ONLY_PENALTY = 0.4;

/**
 * The weighted signature of a problem description.
 *
 * Case is preserved for the distinctiveness test, then folded for matching, so
 * `HttpEndpointNotEnabledException` and `httpendpointnotenabledexception` are
 * the same key while still being recognised as distinctive.
 */
export function problemShape(text: string): Map<string, number> {
  const shape = new Map<string, number>();
  const tokens = text.split(/[\s,;()[\]{}"'`]+/).filter(Boolean);
  for (const raw of tokens) {
    // Strip trailing sentence punctuation but keep it mid-token: `window.`
    // and `window` must be the same key, while `orgiq-auth.service` and
    // `v1/checks` keep the separators that make them identifying.
    const token = raw.replace(/^[^\w]+/, '').replace(/[^\w]+$/, '');
    if (token.length < 3) continue;
    const key = token.toLowerCase();
    if (STOPWORDS.has(key)) continue;
    const weight = isDistinctive(token) ? WEIGHT_DISTINCTIVE : WEIGHT_PROSE;
    // Max, not sum: repeating a word does not make it more identifying, and
    // summing would let a loop-heavy log dominate the whole signature.
    shape.set(key, Math.max(shape.get(key) ?? 0, weight));
  }
  return shape;
}

/**
 * Weighted overlap of two shapes, 0..1.
 *
 * Normalised by the SMALLER shape's mass on purpose: a short problem statement
 * fully contained in a long, detailed experience should score high. Dividing by
 * the union would punish the experience for being thorough, which is the
 * opposite of what we want to reward.
 */
export function shapeScore(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  let sharedDistinctive = false;
  for (const [token, weight] of a) {
    const other = b.get(token);
    if (other == null) continue;
    const overlap = Math.min(weight, other);
    shared += overlap;
    if (overlap >= WEIGHT_DISTINCTIVE) sharedDistinctive = true;
  }
  const massA = [...a.values()].reduce((n, w) => n + w, 0);
  const massB = [...b.values()].reduce((n, w) => n + w, 0);
  const floor = Math.min(massA, massB);
  if (floor === 0) return 0;
  const raw = Math.min(1, shared / floor);

  // Prose can suggest; only an identifying token can assert.
  //
  // Without a shared identifier, "the deploy is stuck" and "the test is stuck"
  // overlap on the one word they share and get called the same problem — a
  // false positive at a spend moment, which is how a panel like this teaches
  // people to ignore it. But requiring an identifier outright is too strict the
  // other way: two accounts of the same session-rotation bug, both written in
  // plain English, are genuinely the same problem and would never match.
  //
  // So a prose-only overlap has to be SUBSTANTIAL to survive at all, and even
  // then it is held just under the strong band — it can reach `partial`, never
  // `applies`. Coincidence is filtered; a real prose match still gets to speak,
  // with a verdict that says it is only partial.
  if (sharedDistinctive) return raw;
  return raw >= PROSE_ONLY_MIN
    ? Math.min(raw, STRONG_SCORE - 0.01)
    : raw * PROSE_ONLY_PENALTY;
}

// ─── Verdicts ────────────────────────────────────────────────────────────────

/** Past this an experience is old enough that the environment has probably
 *  moved — not wrong, but no longer something to act on unverified. */
export const STALE_DAYS = 180;

export function daysBetween(fromIso: string, now: number): number {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((now - then) / 86_400_000));
}

/**
 * Does this prior experience still apply?
 *
 * Deliberately conservative in one direction: age degrades a verdict but never
 * promotes one, and a `failed` experience never reads as `applies` on its own
 * — knowing a thing did not work is useful context, not a procedure to follow.
 * The `why` is not decoration; a verdict a person cannot audit is one they will
 * either over-trust or ignore, and both failure modes are expensive here.
 */
export function applicability(input: {
  score: number;
  ageDays: number;
  kind: ExperienceKind;
  sameRepo: boolean;
}): { verdict: Verdict; why: string } {
  const { score, ageDays, kind, sameRepo } = input;
  const age = ageDays > STALE_DAYS
    ? `${Math.round(ageDays / 30)} months old — verify against the current environment`
    : `${ageDays} days old`;
  const where = sameRepo ? 'same repo' : 'different project';

  if (score < SCORE_FLOOR) {
    return { verdict: 'stale', why: `weak signal overlap (${where}, ${age})` };
  }
  if (ageDays > STALE_DAYS) {
    return { verdict: 'partial', why: `strong signal overlap, but ${age} (${where})` };
  }
  if (kind === 'failed') {
    // A dead end is worth knowing and worth not repeating — but it is not a
    // procedure, so it never reaches `applies`.
    return { verdict: 'partial', why: `a dead end recorded ${age} (${where}) — what not to try` };
  }
  if (score >= STRONG_SCORE) {
    return { verdict: 'applies', why: `strong signal overlap, ${age} (${where})` };
  }
  return { verdict: 'partial', why: `partial signal overlap, ${age} (${where})` };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/**
 * Rank prior experiences against a problem.
 *
 * `repo` is a ranking nudge, never a filter — filtering by it is the exact bug
 * that makes today's recall unable to surface the August fix. Same-repo matches
 * get a small boost because context usually does transfer better within a
 * codebase, but a strong cross-project match still outranks a weak local one,
 * which is the whole point.
 */
export function rankMatches(
  problem: string,
  experiences: Experience[],
  opts: { repo?: string | null; limit?: number; now?: number } = {},
): Match[] {
  const now = opts.now ?? Date.now();
  const shape = problemShape(problem);
  const askingRepo = opts.repo ?? null;

  return experiences
    .map((e) => {
      const raw = shapeScore(shape, problemShape(`${e.title} ${e.body}`));
      const sameRepo = askingRepo != null && e.repo === askingRepo;
      const score = Math.min(1, sameRepo ? raw * 1.1 : raw);
      const ageDays = daysBetween(e.createdAt, now);
      const { verdict, why } = applicability({ score, ageDays, kind: e.kind, sameRepo });
      return {
        experienceId: e.id, title: e.title, body: e.body, kind: e.kind,
        repo: e.repo, sessionId: e.sessionId, ageDays,
        score: Math.round(score * 100) / 100,
        crossProject: askingRepo != null && e.repo !== askingRepo,
        verdict, why,
      };
    })
    .filter((m) => m.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}

// ─── The counterfactual ──────────────────────────────────────────────────────

/**
 * What this short-circuit avoided.
 *
 * A saving can only be claimed against a counterfactual, so it is recorded at
 * the MOMENT of the short-circuit using the same estimate the spend decision
 * was about to be authorised against. A number derived afterwards is not
 * defensible, and a made-up one is worse than none — hence null rather than a
 * guess when there is no estimate, and nothing at all when no match was strong
 * enough to have actually stopped the work.
 */
export function avoidedEstimate(
  matches: Match[],
  estimate: { usd?: number | null; minutes?: number | null },
): { usd: number | null; minutes: number | null } {
  const actionable = matches.some((m) => m.verdict === 'applies');
  if (!actionable) return { usd: null, minutes: null };
  return {
    usd: estimate.usd ?? null,
    minutes: estimate.minutes ?? null,
  };
}
