// The mock data floor. One import site for the whole contract:
//
//   import { clock, defineFixture, todayInUtc } from '../core/index.js';
//
// The rules, the reasoning and the five bugs they exist to prevent are in
// contract.ts; the human-length version is docs/mock-floor.md.

export type {
  Fixture,
  FixtureRegistry,
  FreezeClock,
  MockClock,
  Scenario,
  ScenarioName,
} from './contract.js';

export {
  clock,
  mockClock,
  freezeClock,
  unfreezeClock,
  isClockFrozen,
  utcDayStartMs,
  msSinceUtcMidnight,
  HOUR_MS,
  DAY_MS,
} from './clock.js';

export type { FixtureSpec, MockFixtureRegistry, RowsFactory } from './fixture.js';
export {
  defineFixture,
  fixtureRegistry,
  createFixtureRegistry,
  SCENARIOS,
  SCENARIO_NAMES,
  isScenarioName,
  describeScenario,
} from './fixture.js';

export type { Accessor } from './derive.js';
export { countBy, sumBy, groupBy, latestBy, todayInUtc, toRecord } from './derive.js';
