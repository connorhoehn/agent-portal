// Fixtures and the registry they live behind. See contract.ts for the rules.
//
// Two contract bugs are structural here, not conventional:
//
//   * Import-time timestamps (#3). A fixture declares a rows FACTORY, never a
//     rows array. An array literal at module scope bakes every clock call at
//     import; a factory runs on first read, and again after every reset, so
//     `clock.hoursAgo(3, { keepWithinToday: true })` means three hours before
//     the REQUEST, not three hours before the process started.
//
//   * No scenario control (#4). Rows live behind the registry, so asking for
//     an empty world is `resetAll('empty')` — one call, every fixture, and a
//     reset back afterwards. Nobody has to mutate shared state and warn the
//     next auditor in their log.

import type { Fixture, FixtureRegistry, Scenario, ScenarioName } from './contract.js';

/** Produces a fresh, mutable row set. Called on first read and on every reset. */
export type RowsFactory<Row> = () => Row[];

export interface FixtureSpec<Row> {
  /** Stable id — the key the parity harness and the control plane address. */
  key: string;
  /**
   * Rows per scenario. `default` is required; any scenario left undeclared
   * falls back to `default`, so a fixture only names the worlds it actually
   * differs in. Note that means `empty` is NOT empty unless declared — a
   * fixture that wants an auditable empty state writes `empty: () => []`.
   */
  scenarios: { default: RowsFactory<Row> } & Partial<Record<ScenarioName, RowsFactory<Row>>>;
  /** Defaults to the module-level `fixtureRegistry`; tests pass their own. */
  registry?: MockFixtureRegistry | null;
}

/**
 * The registry, plus the two things a control plane needs that the contract's
 * `FixtureRegistry` doesn't name: which scenario is live, and how to switch to
 * one without also rebuilding fixtures that were mid-mutation for a reason.
 */
export interface MockFixtureRegistry extends FixtureRegistry {
  /** The scenario `fixture.rows()` resolves to when called with no argument. */
  scenario(): ScenarioName;
  /** Number of registered fixtures — the harness's "did anything register?" check. */
  size(): number;
}

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  default: {
    name: 'default',
    describes: 'The demo corpus — the seeded world every surface renders by default.',
  },
  empty: {
    name: 'empty',
    describes: 'Nothing seeded, so a surface has to render its own empty state.',
  },
  error: {
    name: 'error',
    describes: 'Providers fail, so a surface has to render an error state rather than a blank panel.',
  },
  large: {
    name: 'large',
    describes: 'A high-volume corpus for pagination, truncation and density.',
  },
  fresh: {
    name: 'fresh',
    describes: 'A brand-new tenant: the cast exists, no history yet.',
  },
};

export const SCENARIO_NAMES: ScenarioName[] = Object.keys(SCENARIOS) as ScenarioName[];

export function isScenarioName(value: unknown): value is ScenarioName {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCENARIOS, value);
}

export function describeScenario(name: ScenarioName): Scenario {
  return SCENARIOS[name];
}

class Registry implements MockFixtureRegistry {
  private readonly fixtures = new Map<string, Fixture<never>>();
  private active: ScenarioName = 'default';

  register<Row>(fixture: Fixture<Row>): Fixture<Row> {
    const existing = this.fixtures.get(fixture.key);
    if (existing && existing !== (fixture as unknown as Fixture<never>)) {
      // Two fixtures under one key means one of them is invisible to the
      // harness and to `resetAll` — exactly the silence this floor exists to
      // remove, so it is a hard failure at import.
      throw new Error(`fixture key already registered: ${fixture.key}`);
    }
    this.fixtures.set(fixture.key, fixture as unknown as Fixture<never>);
    return fixture;
  }

  all(): Array<Fixture<unknown>> {
    return [...this.fixtures.values()] as Array<Fixture<unknown>>;
  }

  get(key: string): Fixture<unknown> | undefined {
    return this.fixtures.get(key) as Fixture<unknown> | undefined;
  }

  resetAll(scenario?: ScenarioName): void {
    if (scenario) this.active = scenario;
    for (const fixture of this.fixtures.values()) fixture.reset();
  }

  scenario(): ScenarioName {
    return this.active;
  }

  size(): number {
    return this.fixtures.size;
  }
}

/** The registry every fixture in this repo registers with. */
export const fixtureRegistry: MockFixtureRegistry = new Registry();

/** An isolated registry, for tests that must not touch the shared one. */
export function createFixtureRegistry(): MockFixtureRegistry {
  return new Registry();
}

/**
 * Define a fixture and register it. The returned object is the only handle to
 * its rows — there is no exported array to import directly, which is what
 * makes `resetAll` total.
 */
export function defineFixture<Row>(spec: FixtureSpec<Row>): Fixture<Row> {
  const registry = spec.registry === undefined ? fixtureRegistry : spec.registry;
  const key = spec.key;

  if (typeof spec.scenarios.default !== 'function') {
    throw new Error(
      `fixture ${key}: scenarios.default must be a factory (\`() => [...]\`), not an array — ` +
        'an array literal bakes its timestamps at import time.',
    );
  }

  // Materialized rows per scenario, built lazily. A scenario that has never
  // been read holds nothing, so defining a fixture costs no clock reads and
  // no allocation.
  const live = new Map<ScenarioName, Row[]>();

  const factoryFor = (scenario: ScenarioName): RowsFactory<Row> =>
    spec.scenarios[scenario] ?? spec.scenarios.default;

  const resolve = (scenario?: ScenarioName): ScenarioName =>
    scenario ?? (registry ? registry.scenario() : 'default');

  const fixture: Fixture<Row> = {
    key,

    /**
     * The live, mutable array for this scenario. Mock providers push and splice
     * against it (a demo POST has to show up in the next GET), so this is
     * deliberately not a copy — `reset` is how you get the seed back.
     */
    rows(scenario?: ScenarioName): Row[] {
      const name = resolve(scenario);
      let rows = live.get(name);
      if (!rows) {
        rows = factoryFor(name)();
        live.set(name, rows);
      }
      return rows;
    },

    /**
     * Rebuild from the factory. With no argument this resets every scenario
     * this fixture has materialized, not just the active one — a scenario
     * switch should never expose the mutations left behind in a world the
     * caller has since walked away from.
     */
    reset(scenario?: ScenarioName): void {
      if (scenario) live.delete(scenario);
      else live.clear();
    },
  };

  declaredScenarios.set(
    fixture as unknown as Fixture<never>,
    new Set(Object.keys(spec.scenarios) as ScenarioName[]),
  );

  return registry ? registry.register(fixture) : fixture;
}

/**
 * Which scenarios a fixture actually declared a branch for — as opposed to
 * one it merely resolves for, by falling back to `default`. A `WeakMap`
 * keyed on the fixture object rather than a field on `Fixture` itself: the
 * contract type (`contract.ts`) is what the parity harness and every mock
 * provider code against, and this is a control-plane/test concern, not
 * theirs to carry.
 *
 * This is how `scenario-coverage.test.ts` tells "nothing implements `large`"
 * (the actual defect: `GET /api/__mock/scenarios` advertised it while every
 * fixture silently resolved to `default`) apart from "this fixture happens to
 * implement `large`" — a black-box comparison of `rows('large')` against
 * `rows('default')` cannot make that distinction when the two happen to
 * produce equal content, and must re-materialize every scenario of every
 * fixture to even try.
 */
const declaredScenarios = new WeakMap<Fixture<never>, ReadonlySet<ScenarioName>>();

/** A fixture that predates this map (or was built by hand, not `defineFixture`) reads as declaring only `default`. */
const DEFAULT_ONLY: ReadonlySet<ScenarioName> = new Set(['default']);

export function declaredScenariosFor(fixture: Fixture<unknown>): ReadonlySet<ScenarioName> {
  return declaredScenarios.get(fixture as unknown as Fixture<never>) ?? DEFAULT_ONLY;
}
