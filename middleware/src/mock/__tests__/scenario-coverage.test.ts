// Guards the exact defect class this session found: `GET /api/__mock/scenarios`
// advertises every name in `mock/core/fixture.ts`'s `SCENARIOS` globally,
// independent of whether any fixture actually implements it. `large` shipped
// that way — the scenario existed, `POST /api/__mock/scenario {"scenario":
// "large"}` answered 200, `GET /api/__mock/state` showed every fixture quietly
// still on `default`, and nothing failed. Applying `large` changed nothing.
//
// This test makes that silence impossible again: for every scenario name
// other than `default`, at least one registered fixture must have DECLARED a
// branch for it (`declaredScenariosFor`, mock/core/fixture.ts) — not merely
// resolved to one by falling back to `default`, which every fixture does for
// every scenario name whether or not it means anything.
//
// Every mock fixture module in this directory is imported below (bare, for
// its registration side effect) so the shared registry is fully populated
// before the assertion runs. Importing only the modules another test happens
// to touch would let an unimported fixture read as "implements nothing" when
// the real gap is "this file never loaded it" — indistinguishable from the
// defect this test exists to catch.

// `config.ts` reads `import.meta.url`, which is a hard TS1343 error under
// ts-jest's CJS transform (mock-control.ts's own header names this trap).
// Importing every mock module below pulls several providers in transitively,
// and several of those import `config.js` — so it is mocked here the same
// way schema-shape.test.ts and mock-control.test.ts already do, rather than
// let the whole suite fail to compile.
jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import '../agent-jobs.js';
import '../agent-project-runs.js';
import '../agent-projects.js';
import '../agent-statuses.js';
import '../answer-check.js';
import '../assessment.js';
import '../bots.js';
import '../budgets.js';
import '../calibration.js';
import '../canary-ask.js';
import '../canary-library.js';
import '../canary-scores.js';
import '../canary-weight.js';
import '../capabilities.js';
import '../capability-inventory.js';
import '../connected-sources.js';
import '../decisions.js';
import '../design-reviews.js';
import '../devbox-delivery.js';
import '../devbox-shell.js';
import '../devbox-workspace.js';
import '../document-agent-edits.js';
import '../embedding.js';
import '../pipeline-queue.js';
import '../runbooks.js';
import '../github-runs.js';
import '../github.js';
import '../graph-taxonomy.js';
import '../harness.js';
import '../invocations.js';
import '../judge-config.js';
import '../kb-registry.js';
import '../knowledge-base.js';
import '../lab.js';
import '../landing-zone.js';
import '../live-view.js';
import '../live.js';
import '../local-compute.js';
import '../observability-queries.js';
import '../observability.js';
import '../org-findings.js';
import '../people-scores.js';
import '../people.js';
import '../promotions.js';
import '../prompt-evals.js';
import '../prompt-library.js';
import '../prompt-studio.js';
import '../prompt-versions.js';
import '../responses.js';
import '../scores.js';
import '../sdlc.js';
import '../session-bundle.js';
import '../sprints.js';
import '../static-review.js';
import '../topology.js';
import '../trace-sink.js';
import '../traces.js';
import '../upload-links.js';
import '../work-item-comments.js';
import '../work-items.js';

import { fixtureRegistry, SCENARIO_NAMES, declaredScenariosFor } from '../core/index.js';

describe('every advertised scenario is actually implemented somewhere', () => {
  it('registers a real number of fixtures (sanity: the imports above worked)', () => {
    // Below this, "zero fixtures implement X" would just mean the import
    // list above rotted, not that X is unimplemented.
    expect(fixtureRegistry.size()).toBeGreaterThan(30);
  });

  it('has at least one fixture that DECLARED a branch for every non-default scenario', () => {
    const nonDefault = SCENARIO_NAMES.filter((name) => name !== 'default');
    const implementedBy = new Map<string, string[]>(nonDefault.map((name) => [name, []]));

    for (const fixture of fixtureRegistry.all()) {
      for (const name of declaredScenariosFor(fixture)) {
        implementedBy.get(name)?.push(fixture.key);
      }
    }

    const unimplemented = nonDefault.filter((name) => (implementedBy.get(name)?.length ?? 0) === 0);
    // A failure here should name the scenario, not just say "[] !== [...]" —
    // this is the whole message the next person needs.
    if (unimplemented.length > 0) {
      throw new Error(
        `scenario(s) advertised by GET /api/__mock/scenarios with NO fixture implementing them: ` +
          `${unimplemented.join(', ')}. Coverage: ${JSON.stringify(Object.fromEntries(implementedBy))}`,
      );
    }
    expect(unimplemented).toEqual([]);
  });
});
