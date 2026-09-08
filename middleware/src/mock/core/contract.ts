// The mock data floor — the contract every fixture in this repo codes against.
//
// WHY THIS EXISTS. Five classes of bug shipped from the old hand-rolled
// fixtures, each found by a human audit rather than a test:
//
//   1. Typed aggregates. A count written next to the rows it claims to count
//      drifts the moment either changes — "5 bots" over an empty table, a
//      team reading "New · 17/17", a banner saying "6 pending" over 5 cards,
//      25 errors promised by a summary the list could not produce.
//   2. Invented wire strings. A fixture keyed `enterprise` while the server
//      sent `enterprise_context`; the unit test used the fixture's key, so
//      the test agreed with the code and both disagreed with the server.
//      Six documents were unreachable and every check was green.
//   3. Import-time timestamps. "3 hours ago" baked at module load put a run
//      in yesterday whenever the process booted near UTC midnight.
//   4. No scenario control. To audit an empty state an auditor had to mutate
//      shared state, then warn the next auditor in their log.
//   5. Providers with no mock branch, so a surface is blank in dev:mock and
//      nobody can tell an unbuilt feature from an unseeded one.
//
// THE RULES. A fixture module may export rows and selectors. It may not
// export a number that could have been counted from rows it also exports.
// Every timestamp comes from the clock below. Every wire-shaped string
// (section key, status enum, capability name) is asserted against a real
// response, never typed from memory.

/**
 * The one clock. Fixtures express age relative to `now()` at READ time, so a
 * module that loads at 23:59 and is read at 00:01 still reports "today"
 * correctly, and a test can freeze the instant it cares about.
 */
export interface MockClock {
  now(): Date;
  /** ISO string for `now()` — the form most rows carry. */
  nowIso(): string;
  /** An instant `hours` before now, clamped so a "today" row stays today. */
  hoursAgo(hours: number, opts?: { keepWithinToday?: boolean }): string;
  daysAgo(days: number): string;
}

/** Freeze the clock for a test; returns a restore function. */
export type FreezeClock = (at: Date | string) => () => void;

/**
 * A named world a caller can ask for. `default` is the demo corpus; the
 * others exist so an audit never has to damage shared state to see an empty
 * table or an error state.
 */
export type ScenarioName = 'default' | 'empty' | 'error' | 'large' | 'fresh';

export interface Scenario {
  name: ScenarioName;
  /** One line, shown by the control plane so a reader knows what they asked for. */
  describes: string;
}

/**
 * A fixture: the rows, and selectors derived from them. `rows` is the single
 * source of truth — anything countable is a selector, never a stored field.
 */
export interface Fixture<Row> {
  /** Stable id used by the parity harness and the scenario registry. */
  readonly key: string;
  rows(scenario?: ScenarioName): Row[];
  /** Restore this fixture to the scenario's starting state. */
  reset(scenario?: ScenarioName): void;
}

/**
 * Registry: every fixture registers here so the control plane can reset them
 * all, and the parity harness can walk them without a hand-maintained list.
 */
export interface FixtureRegistry {
  register<Row>(fixture: Fixture<Row>): Fixture<Row>;
  all(): Array<Fixture<unknown>>;
  get(key: string): Fixture<unknown> | undefined;
  resetAll(scenario?: ScenarioName): void;
}
