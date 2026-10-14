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
import { mockRestartSnapshot, restoredFixtureRows } from '../restart-state.js';
import {
  cloneRows, currentMockScope, isDataState, lengthen, MANY_ROWS, multiply,
  scopedUnavailable, scopeNamesFixture, scopeScenarioFor, type MockScope,
} from './scope.js';

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
  /**
   * `false` keeps this fixture out of request scopes (core/scope.ts): every
   * read, scoped or not, sees the one shared world. For process-wide state a
   * scope must never fork — the identity directory's grant writes and clones,
   * which the session middleware reads before any scope is entered. Default
   * `true`.
   */
  scoped?: boolean;
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
  demo: {
    name: 'demo',
    describes: 'The Computer Lab demo: three agents pick up Auth Migration\'s open items through the governed dispatch path — one asks a question, one posts a change for review, one is held at a money gate. Starts a ~3–4 minute director; reset or any other scenario stops it.',
  },
  'distillation-demo': {
    name: 'distillation-demo',
    describes: 'The Distillation demo: three Auth Migration lab sessions write run notes live, a compaction turns them into patterns, reviewers agree with three and reject one (one waits for you), the agreed patterns become a cutover guide that is published and then run by an agent. Starts a ~3-minute director; reset or any other scenario stops it.',
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
  private active: ScenarioName = (mockRestartSnapshot()?.scenario as ScenarioName | undefined) ?? 'default';

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
  if (registry === fixtureRegistry) for (const restored of restoredFixtureRows(key) ?? []) live.set(restored.scenario as ScenarioName, restored.rows as Row[]);

  const factoryFor = (scenario: ScenarioName): RowsFactory<Row> =>
    spec.scenarios[scenario] ?? spec.scenarios.default;

  const resolve = (scenario?: ScenarioName): ScenarioName =>
    scenario ?? (registry ? registry.scenario() : 'default');

  const scoped = spec.scoped !== false;
  const declared = new Set(Object.keys(spec.scenarios) as ScenarioName[]);

  /** The shared rows of a scenario as a scope's starting point: a copy of what is live, or the seed. */
  const seedFor = (name: ScenarioName): Row[] => {
    const shared = live.get(name);
    return (shared && cloneRows(shared)) ?? factoryFor(name)();
  };

  /**
   * Copy-on-write read inside a request scope. The scope's rows are built once
   * per scenario and kept on the scope, so a write under the scope lands there
   * and the shared `live` map is never handed out.
   */
  const scopedRows = (scope: MockScope, asked: ScenarioName | undefined): Row[] => {
    const name = asked ?? scopeScenarioFor(scope, key);
    scope.touched.add(key);
    let mine = scope.rows.get(fixture) as Map<string, Row[]> | undefined;
    if (!mine) { mine = new Map(); scope.rows.set(fixture, mine as Map<string, unknown[]>); }
    const held = mine.get(name);
    if (held) return held;
    let rows: Row[];
    if (isDataState(name)) {
      if (name === 'long-text') rows = lengthen(seedFor('default')) as Row[];
      else if (name === 'many') {
        const large = declared.has('large') ? factoryFor('large')() : [];
        rows = large.length >= MANY_ROWS ? large : multiply(large.length > 0 ? large : seedFor('default'));
      } else rows = seedFor('default');
    } else if (declared.has(name)) {
      rows = seedFor(name); // a declared `error` throws from its factory, every read
    } else if (name === 'empty' && scopeNamesFixture(scope, key)) {
      rows = [];
    } else if (name === 'error' && scopeNamesFixture(scope, key)) {
      throw scopedUnavailable(key);
    } else {
      rows = seedFor('default');
    }
    mine.set(name, rows);
    return rows;
  };

  const fixture: Fixture<Row> = {
    key,

    /**
     * The live, mutable array for this scenario. Mock providers push and splice
     * against it (a demo POST has to show up in the next GET), so this is
     * deliberately not a copy — `reset` is how you get the seed back.
     */
    rows(scenario?: ScenarioName): Row[] {
      const scope = scoped ? currentMockScope() : undefined;
      if (scope) return scopedRows(scope, scenario);
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
     * caller has since walked away from. Scopes keep their own rows: a reset
     * of the shared world does not reach into a scope (DELETE the scope).
     */
    reset(scenario?: ScenarioName): void {
      if (scenario) live.delete(scenario);
      else live.clear();
    },
  };

  declaredScenarios.set(fixture as unknown as Fixture<never>, declared);

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
