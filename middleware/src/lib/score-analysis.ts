// Score analysis — the Code Interpreter as a calculator, not a sandbox.
//
// `people` carries three numbers per person: expertise_score, pagerank_score,
// composite_score. They are rendered as-is on the Scores page, which means the
// only questions anyone can answer are "who is highest" and "what is the
// number". Nobody can answer the ones that matter: what is the composite
// actually weighting, is it doing anything the signals do not already say, and
// who is ranked in a way the underlying evidence does not support.
//
// Those are least-squares fits, rank correlations and concentration measures —
// miserable in SQL, tedious and error-prone in TypeScript, and three lines
// each in Python. So the numbers go to the Code Interpreter, real arithmetic
// happens there, and structured results come back.
//
// This is deliberately not a REPL for the user. The code is generated here and
// fixed; the sandbox is compute, and the product surface is the answer.

import { exec } from '../providers/aurora.js';
import { agentcore } from '../providers/index.js';
import { config } from '../config.js';

export interface ScoreDistribution {
  signal: string;
  n: number;
  mean: number; median: number; stdev: number;
  p25: number; p75: number; p90: number;
  min: number; max: number;
  /** Share of the total held by the top decile — 0.1 is even, 1.0 is one person. */
  topDecileShare: number;
  gini: number;
}

export interface ImpliedWeights {
  /** Least-squares fit of composite on the two signals. */
  expertise: number;
  pagerank: number;
  intercept: number;
  /** Share of movement attributable to expertise, on a standardised basis. */
  expertiseShare: number;
  /** How much of the composite's variance the two signals explain. */
  r2: number;
  /** Plain-language reading of the fit, generated from the numbers. */
  reading: string;
}

export interface RankDisagreement {
  personId: string;
  name: string;
  team: string | null;
  compositeRank: number;
  /** Rank implied by the signals alone, via the fitted model. */
  predictedRank: number;
  /** Positive means the composite ranks them higher than the signals justify. */
  rankDelta: number;
  composite: number;
  predicted: number;
}

export interface ScoreAnalysis {
  people: number;
  distributions: ScoreDistribution[];
  correlations: Array<{ a: string; b: string; pearson: number; spearman: number }>;
  weights: ImpliedWeights | null;
  disagreements: RankDisagreement[];
  /** What the sandbox printed that was not the result — kept for diagnosis. */
  stderr?: string;
  durationMs: number;
  sessionId: string;
  computedAt: string;
}

interface PersonRow {
  id: string; name: string; team: string | null;
  expertise: number; pagerank: number; composite: number;
}

function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function loadPeople(): Promise<PersonRow[]> {
  const rows = await exec(
    // `team` is a plain text column on people — there is no team_id foreign key.
    `SELECT p.id, p.name, p.team,
            COALESCE(p.expertise_score, 0)  AS expertise,
            COALESCE(p.pagerank_score, 0)   AS pagerank,
            COALESCE(p.composite_score, 0)  AS composite
       FROM people p
      WHERE p.composite_score IS NOT NULL
      ORDER BY p.composite_score DESC
      LIMIT 2000`,
  );
  return rows.map((r) => ({
    id: toStr(r['id']),
    name: toStr(r['name']),
    team: r['team'] ? toStr(r['team']) : null,
    expertise: toNum(r['expertise']),
    pagerank: toNum(r['pagerank']),
    composite: toNum(r['composite']),
  }));
}

/**
 * The program that runs in the sandbox.
 *
 * Pure standard library on purpose. numpy is usually present, but "usually" is
 * not a good enough reason for the analysis to fail in an environment we do
 * not control — and none of this is heavy enough to need it.
 *
 * Results come back on a sentinel line because the sandbox returns combined
 * text output: anything the runtime decides to print would otherwise be
 * indistinguishable from the result.
 */
function buildProgram(people: PersonRow[]): string {
  const payload = JSON.stringify(people.map((p) => [p.id, p.name, p.team, p.expertise, p.pagerank, p.composite]));
  return `
import json, math

ROWS = json.loads(r'''${payload}''')
people = [{"id": r[0], "name": r[1], "team": r[2],
           "expertise": float(r[3]), "pagerank": float(r[4]), "composite": float(r[5])}
          for r in ROWS]
n = len(people)

def quantile(xs, q):
    if not xs: return 0.0
    s = sorted(xs); i = (len(s) - 1) * q
    lo, hi = int(math.floor(i)), int(math.ceil(i))
    return s[lo] if lo == hi else s[lo] + (s[hi] - s[lo]) * (i - lo)

def gini(xs):
    # Concentration of a non-negative quantity. 0 = everyone equal.
    xs = sorted(max(0.0, x) for x in xs)
    tot = sum(xs)
    if not xs or tot <= 0: return 0.0
    cum = 0.0
    for i, x in enumerate(xs, 1):
        cum += i * x
    return (2 * cum) / (len(xs) * tot) - (len(xs) + 1) / len(xs)

def describe(name, xs):
    if not xs:
        return {"signal": name, "n": 0, "mean": 0, "median": 0, "stdev": 0,
                "p25": 0, "p75": 0, "p90": 0, "min": 0, "max": 0,
                "topDecileShare": 0, "gini": 0}
    mean = sum(xs) / len(xs)
    var = sum((x - mean) ** 2 for x in xs) / len(xs)
    top = sorted(xs, reverse=True)[:max(1, len(xs) // 10)]
    tot = sum(xs)
    return {
        "signal": name, "n": len(xs), "mean": mean, "median": quantile(xs, 0.5),
        "stdev": math.sqrt(var), "p25": quantile(xs, 0.25), "p75": quantile(xs, 0.75),
        "p90": quantile(xs, 0.90), "min": min(xs), "max": max(xs),
        "topDecileShare": (sum(top) / tot) if tot > 0 else 0.0,
        "gini": gini(xs),
    }

def pearson(a, b):
    if len(a) < 2: return 0.0
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    da = math.sqrt(sum((x - ma) ** 2 for x in a))
    db = math.sqrt(sum((y - mb) ** 2 for y in b))
    return num / (da * db) if da > 0 and db > 0 else 0.0

def ranks(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    out = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out

def spearman(a, b):
    return pearson(ranks(a), ranks(b))

E = [p["expertise"] for p in people]
P = [p["pagerank"] for p in people]
C = [p["composite"] for p in people]

# Ordinary least squares for composite ~ w1*E + w2*P + b, solved directly.
# Two predictors, so the normal equations are a 3x3 system — small enough to
# eliminate by hand and avoid depending on a linear algebra package.
def ols(y, x1, x2):
    m = len(y)
    if m < 3: return None
    s1, s2, sy = sum(x1), sum(x2), sum(y)
    s11 = sum(a * a for a in x1); s22 = sum(a * a for a in x2)
    s12 = sum(a * b for a, b in zip(x1, x2))
    s1y = sum(a * b for a, b in zip(x1, y)); s2y = sum(a * b for a, b in zip(x2, y))
    # Centre the predictors so the intercept separates cleanly.
    m1, m2, my = s1 / m, s2 / m, sy / m
    c11 = s11 - m * m1 * m1
    c22 = s22 - m * m2 * m2
    c12 = s12 - m * m1 * m2
    c1y = s1y - m * m1 * my
    c2y = s2y - m * m2 * my
    det = c11 * c22 - c12 * c12
    if abs(det) < 1e-12: return None
    w1 = (c1y * c22 - c2y * c12) / det
    w2 = (c2y * c11 - c1y * c12) / det
    b = my - w1 * m1 - w2 * m2
    pred = [w1 * a + w2 * c + b for a, c in zip(x1, x2)]
    ss_res = sum((yy - pp) ** 2 for yy, pp in zip(y, pred))
    ss_tot = sum((yy - my) ** 2 for yy in y)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0.0
    return w1, w2, b, r2, pred

x1_vals, x2_vals = E, P
fit = ols(C, E, P)
weights = None
disagreements = []
if fit:
    w1, w2, b, r2, pred = fit
    # Compare standardised contributions, not raw coefficients.
    #
    # The signals are on different scales — expertise runs 0-100, PageRank 0-1
    # — so a coefficient of 23 on PageRank moves the composite far less than
    # 0.65 on expertise. Comparing the raw numbers reported a 70/30
    # expertise-led blend as "97% PageRank". Coefficient x standard deviation
    # is the contribution each signal actually makes.
    def stdev(xs):
        if len(xs) < 2: return 0.0
        m = sum(xs) / len(xs)
        return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))
    contrib_e = abs(w1) * stdev(x1_vals)
    contrib_p = abs(w2) * stdev(x2_vals)
    total = contrib_e + contrib_p
    share_e = contrib_e / total if total > 0 else 0
    if r2 > 0.999:
        reading = ("The composite is exactly %.2f x expertise + %.2f x PageRank. It is a fixed formula, "
                   "not an independent signal — it tells you nothing the two inputs do not already say, "
                   "and ranking by it is the same as ranking by that blend." % (w1, w2))
    elif r2 < 0.5:
        reading = ("The composite is not well explained by these two signals (R²=%.2f) — "
                   "something else is driving it, or it is partly noise." % r2)
    elif share_e > 0.75:
        reading = "The composite is effectively expertise with a small PageRank adjustment (%.0f%% / %.0f%%)." % (share_e * 100, (1 - share_e) * 100)
    elif share_e < 0.25:
        reading = "The composite is effectively PageRank with a small expertise adjustment (%.0f%% / %.0f%%)." % ((1 - share_e) * 100, share_e * 100)
    else:
        reading = "The composite blends the two signals at roughly %.0f%% expertise to %.0f%% PageRank, by how much each actually moves the result." % (share_e * 100, (1 - share_e) * 100)
    weights = {"expertise": w1, "pagerank": w2, "intercept": b, "r2": r2,
               "expertiseShare": share_e, "reading": reading}

    # Where the published ranking and the signal-implied ranking disagree most.
    # High absolute delta means the composite is placing someone somewhere the
    # evidence behind it does not.
    cr = ranks([-c for c in C])
    pr = ranks([-p for p in pred])
    rows = []
    for i, person in enumerate(people):
        rows.append({
            "personId": person["id"], "name": person["name"], "team": person["team"],
            "compositeRank": int(cr[i]), "predictedRank": int(pr[i]),
            "rankDelta": int(pr[i] - cr[i]),
            "composite": C[i], "predicted": pred[i],
        })
    # Only actual disagreements. When the composite is an exact formula over
    # the two signals every delta is 0, and a list of twelve zeroes reads as
    # data when it is the absence of any.
    rows = [r for r in rows if r["rankDelta"] != 0]
    rows.sort(key=lambda r: -abs(r["rankDelta"]))
    disagreements = rows[:12]

result = {
    "people": n,
    "distributions": [describe("expertise", E), describe("pagerank", P), describe("composite", C)],
    "correlations": [
        {"a": "expertise", "b": "pagerank", "pearson": pearson(E, P), "spearman": spearman(E, P)},
        {"a": "expertise", "b": "composite", "pearson": pearson(E, C), "spearman": spearman(E, C)},
        {"a": "pagerank", "b": "composite", "pearson": pearson(P, C), "spearman": spearman(P, C)},
    ],
    "weights": weights,
    "disagreements": disagreements,
}
print("__ORGIQ_RESULT__" + json.dumps(result))
`.trim();
}

/**
 * Run the analysis.
 *
 * Throws only when there is nothing to analyse or the sandbox is unusable —
 * a failed computation returns its own error text rather than a stack trace,
 * because the interesting failure is usually inside the program.
 */
export async function analyzeScores(): Promise<ScoreAnalysis> {
  if (config.mock.aurora) throw new Error('Aurora is mocked — no scores to analyse');

  const people = await loadPeople();
  if (people.length < 3) {
    throw new Error(`Only ${people.length} scored people — not enough to fit anything meaningful`);
  }

  const program = buildProgram(people);
  const run = await agentcore.executeCode(program, 'python');

  const marker = '__ORGIQ_RESULT__';
  const at = run.output.indexOf(marker);
  if (at < 0) {
    const detail = run.error || run.output.slice(-600) || 'no output';
    throw new Error(`The computation produced no result: ${detail}`);
  }

  const line = run.output.slice(at + marker.length).split('\n')[0] ?? '';
  let parsed: Omit<ScoreAnalysis, 'durationMs' | 'sessionId' | 'computedAt' | 'stderr'>;
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch (err) {
    throw new Error(`Result was not valid JSON: ${(err as Error).message}`);
  }

  // Anything printed before the marker is incidental — warnings, banners — and
  // is worth keeping visible rather than silently dropping.
  const noise = run.output.slice(0, at).trim();

  return {
    ...parsed,
    ...(noise ? { stderr: noise.slice(0, 2000) } : {}),
    durationMs: run.durationMs,
    sessionId: run.sessionId,
    computedAt: new Date().toISOString(),
  };
}
