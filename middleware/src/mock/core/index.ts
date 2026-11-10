// The mock data floor. One import site for the whole contract:
//
//   import { clock, defineFixture, todayInUtc } from '../core/index.js';
//
// The rules, the reasoning and the five bugs they exist to prevent are in
// contract.ts; the long form is in contract.ts.

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
  declaredScenariosFor,
  mockWorldGeneration,
  removeFixtureRows,
} from './fixture.js';

export type { Accessor } from './derive.js';
export { countBy, sumBy, groupBy, latestBy, todayInUtc, toRecord } from './derive.js';

export type { DataState, MockScope, ScopeScenario, CreateScopeInput } from './scope.js';
export {
  currentMockScope,
  runInMockScope,
  runOutsideMockScope,
  createMockScope,
  getMockScope,
  deleteMockScope,
  listMockScopes,
  clearMockScopes,
  describeMockScope,
  isDataState,
  DATA_STATES,
  MANY_ROWS,
  LONG_TEXT_LENGTH,
  MAX_DELAY_MS,
  ScopeLimitError,
} from './scope.js';
