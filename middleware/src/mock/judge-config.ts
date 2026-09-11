// The LLM-as-judge rubric — SSM, offline.
//
// WHY THIS EXISTS. `/orgiq/canary/judge_config` is the parameter `/iq/evaluations`
// edits and `lib/canary-judge.ts` reads on every canary ask. `getJudgeConfig`
// already degraded correctly when SSM was unreachable — it falls back to
// `DEFAULT_JUDGE_CONFIG` — so the BEHAVIOUR offline was right. What was wrong
// was everything around it: there is no credential offline, so every read past
// the 20-second cache window made a doomed `GetParameter` call, and the first
// one logged `[judge-config] SSM read failed, using defaults
// UnrecognizedClientException`. A log line that cries wolf on every run is a
// log line nobody reads on the run that matters, and a round trip that can only
// fail is one the hot path pays every twenty seconds for nothing. And because
// the fallback is a CONSTANT, a `PUT /config` offline
// wrote to nothing: the rubric could not be edited, so the page's whole reason
// for existing was unexercised (contract.ts rule 5 — a provider with no mock
// path makes an unbuilt feature and an unseeded one look identical).
//
// A fixture rather than a constant, for the same reason `mock/canary-weight.ts`
// is one: a PUT in `dev:mock` has to move the same row the next GET reads, or
// the editor snaps back and the surface is a decoration.
//
// THE ROW IS THE SHIPPED DEFAULT, NOT A NEW ONE. `default` mirrors
// `DEFAULT_JUDGE_CONFIG` by reference — the rubric keys (`helpfulness`,
// `factuality`, `tone`, `conciseness`) and the weights are read from the module
// that defines them rather than retyped here, because a rubric key typed from
// memory is contract.ts rule 2 and `weightedComposite` silently scores 0 for a
// dimension whose key it cannot find.
//
// CYCLE NOTE. `lib/judge-config.ts` imports this module for its mock branch and
// this module imports `DEFAULT_JUDGE_CONFIG` back. The read happens inside the
// rows FACTORY, which `defineFixture` does not call at import, so whichever
// module is evaluated first the other is fully initialised before the constant
// is ever touched. Same shape as the invocations ↔ agent-statuses cycle.

import { defineFixture } from './core/index.js';
import { DEFAULT_JUDGE_CONFIG, type JudgeConfig } from '../lib/judge-config.js';

/**
 * The parameter, as one row.
 *
 * `default` — the parameter holds the rubric the product ships with. This is
 *             what an operator sees on `/iq/evaluations` before they have
 *             touched anything, and what the judge scores against.
 * `empty`   — the parameter has never been written. `getJudgeConfig`'s
 *             `ParameterNotFound` branch is the one that runs, and it answers
 *             `DEFAULT_JUDGE_CONFIG`. So the VALUES a caller sees are the same
 *             in both worlds, and that identity is the honest reading rather
 *             than a gap: an unwritten parameter and a parameter holding the
 *             defaults are indistinguishable to every reader by design. What
 *             differs is that a PUT in this world has nothing to update until
 *             it creates the row, which is exactly what `mockSetJudgeConfig`
 *             does. Declared explicitly, because an undeclared scenario falls
 *             back to `default` and this state would otherwise be unreachable.
 */
export const judgeConfigParam = defineFixture<JudgeConfig>({
  key: 'judge-config',
  scenarios: {
    default: () => [structuredClone(DEFAULT_JUDGE_CONFIG)],
    empty: () => [],
  },
});

/**
 * The parameter's value, or `null` when the parameter does not exist.
 *
 * Null is the `ParameterNotFound` signal, kept distinct from "a config that
 * happens to equal the defaults" so `lib/judge-config.ts` can take the same
 * branch offline that it takes against a fresh account — including the cache
 * entry it writes, so a missing parameter is not re-read on every call.
 */
export function mockGetJudgeConfig(): JudgeConfig | null {
  const row = judgeConfigParam.rows()[0];
  return row ? structuredClone(row) : null;
}

/**
 * `PutParameter` with `Overwrite: true` — the parameter is replaced whole, and
 * it is created if it was absent. Takes the already-sanitised config, so the
 * mock cannot store a shape the real path would have rejected.
 */
export function mockSetJudgeConfig(cfg: JudgeConfig): void {
  const rows = judgeConfigParam.rows();
  rows.splice(0, rows.length, structuredClone(cfg));
}
