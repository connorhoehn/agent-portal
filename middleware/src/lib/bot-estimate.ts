// Estimate basis selection — the pure half of the cost estimator.
//
// The estimator's one design rule is honesty: ranges, never a single number,
// and the basis always stated. Repo-matched history is the strongest evidence;
// model-wide history is weaker but real; below the sample floors it says
// "prior" out loud rather than dressing two data points up as a forecast.
// The SQL that produces the samples lives in providers/bots.ts
// (runCostSamples); everything judgeable in isolation is here.

/** Percentile cost/duration over a set of completed runs. */
export interface RunPercentiles {
  count: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
}

export interface Estimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
}

/** Repo-matched history is trusted at fewer samples than model-wide history —
 *  it is the same codebase, so three runs already say something. */
export const REPO_MIN_SAMPLES = 3;
export const MODEL_MIN_SAMPLES = 5;

// Static priors by model tier, matched on a substring of the model id (which
// arrives as an inference-profile id, not a bare name). Deliberately wide:
// a prior's job is to bracket, not predict.
const PRIORS: ReadonlyArray<{ match: string } & Omit<Estimate, 'basis' | 'sampleCount'>> = [
  { match: 'haiku', costUsdP25: 0.03, costUsdP75: 0.30, minutesP25: 1, minutesP75: 6 },
  { match: 'sonnet', costUsdP25: 0.15, costUsdP75: 1.50, minutesP25: 3, minutesP75: 15 },
  { match: 'opus', costUsdP25: 0.60, costUsdP75: 5.00, minutesP25: 5, minutesP75: 30 },
];

/** The static prior for a model id. An unrecognised model gets the sonnet
 *  prior — the middle tier is the least-wrong default in both directions. */
export function priorFor(model: string): Estimate {
  const id = model.toLowerCase();
  const tier = PRIORS.find((p) => id.includes(p.match)) ?? PRIORS[1]!;
  const { match: _match, ...range } = tier;
  return { basis: 'prior', sampleCount: 0, ...range };
}

/**
 * Pick the strongest basis the history supports.
 *
 * repoSample is the (model, repo)-matched percentiles (null when no repo was
 * given or nothing matched); modelSample is model-wide. Order matters: a thin
 * repo sample must fall through to the model-wide one, not be preferred for
 * being specific — specificity without volume is exactly the confidence
 * theater this refuses to produce.
 */
export function selectEstimate(
  model: string,
  repoSample: RunPercentiles | null,
  modelSample: RunPercentiles | null,
): Estimate {
  if (repoSample && repoSample.count >= REPO_MIN_SAMPLES) {
    return { basis: 'repo', sampleCount: repoSample.count, ...strip(repoSample) };
  }
  if (modelSample && modelSample.count >= MODEL_MIN_SAMPLES) {
    return { basis: 'model', sampleCount: modelSample.count, ...strip(modelSample) };
  }
  return priorFor(model);
}

function strip(p: RunPercentiles): Omit<Estimate, 'basis' | 'sampleCount'> {
  return {
    costUsdP25: p.costUsdP25, costUsdP75: p.costUsdP75,
    minutesP25: p.minutesP25, minutesP75: p.minutesP75,
  };
}
