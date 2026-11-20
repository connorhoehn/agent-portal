// Loads a corpus file and runs its scenarios through a rig with bounded concurrency.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Corpus, Scenario } from './types.mts';
import type { Rig } from './rigs.mts';
import { passEvery, scoreScenario, type ScenarioScore } from './score.mts';

const here = dirname(fileURLToPath(import.meta.url));
export type CorpusName = 'dev' | 'holdout';

export function loadCorpus(name: CorpusName): Scenario[] {
  const c = JSON.parse(readFileSync(resolve(here, 'corpus', `${name}.json`), 'utf8')) as Corpus;
  return c.scenarios;
}

export async function runAll(rig: Rig, scenarios: Scenario[], concurrency = 6): Promise<ScenarioScore[]> {
  const out: ScenarioScore[] = new Array(scenarios.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= scenarios.length) return;
      const s = scenarios[i]!;
      out[i] = scoreScenario(s, await rig(s));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, worker));
  return out;
}

/** The trials each scenario is run for; it passes only if every one passes (pass^3). */
export const TRIALS = 3;

/** Runs every scenario `trials` times and folds the runs with pass^k. */
export async function runTrials(rig: Rig, scenarios: Scenario[], trials = TRIALS, concurrency = 6): Promise<ScenarioScore[]> {
  const runs: ScenarioScore[][] = [];
  for (let k = 0; k < trials; k += 1) runs.push(await runAll(rig, scenarios, concurrency));
  return passEvery(runs);
}

export const pct = (x: { ok: number; of: number }): string => (x.of === 0 ? 'n/a' : `${x.ok}/${x.of} (${((100 * x.ok) / x.of).toFixed(1)}%)`);
