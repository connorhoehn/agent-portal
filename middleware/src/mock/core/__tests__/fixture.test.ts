// Fixtures, scenarios and the registry.
//
// Every test here uses its OWN registry (`createFixtureRegistry`) so a failure
// cannot leak fixtures into the shared one — which is itself the shape of
// contract bug #4: an audit that has to mutate shared state and then warn the
// next reader about it.

import { clock, freezeClock, unfreezeClock } from '../clock.js';
import {
  createFixtureRegistry,
  defineFixture,
  describeScenario,
  fixtureRegistry,
  isScenarioName,
  SCENARIOS,
  SCENARIO_NAMES,
} from '../fixture.js';

interface Run {
  id: string;
  status: 'ok' | 'failed';
  startedAt: string;
}

afterEach(() => unfreezeClock());

describe('rows()', () => {
  it('builds from the factory lazily — not at define time', () => {
    const registry = createFixtureRegistry();
    const factory = jest.fn(() => [{ id: 'r1' }]);
    const fixture = defineFixture({ key: 'lazy', scenarios: { default: factory }, registry });

    expect(factory).not.toHaveBeenCalled();
    fixture.rows();
    fixture.rows();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('samples the clock at READ time, not import time — contract bug #3', () => {
    const registry = createFixtureRegistry();
    const runs = defineFixture<Run>({
      key: 'runs',
      scenarios: {
        default: () => [
          { id: 'r1', status: 'ok', startedAt: clock.hoursAgo(3, { keepWithinToday: true }) },
        ],
      },
      registry,
    });

    const atMidday = freezeClock('2026-09-09T15:30:00.000Z');
    expect(runs.rows()[0]!.startedAt).toBe('2026-09-09T12:30:00.000Z');
    atMidday();

    // A different day, a different read: the row moves with the clock, which is
    // the whole point. (reset() is what re-runs the factory.)
    const nextDay = freezeClock('2026-09-10T15:30:00.000Z');
    runs.reset();
    expect(runs.rows()[0]!.startedAt).toBe('2026-09-10T12:30:00.000Z');
    nextDay();
  });

  it('hands back the live array, so a mock provider can push to it', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'live',
      scenarios: { default: () => [{ id: 'a' }] },
      registry,
    });

    fixture.rows().push({ id: 'b' });
    fixture.rows()[0]!.id = 'mutated';
    expect(fixture.rows().map((r) => r.id)).toEqual(['mutated', 'b']);
  });
});

describe('reset', () => {
  it('restores mutated rows to the seed', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'r',
      scenarios: { default: () => [{ id: 'a' }] },
      registry,
    });

    fixture.rows().push({ id: 'b' });
    fixture.rows().length = 0;
    expect(fixture.rows()).toHaveLength(0);

    fixture.reset();
    expect(fixture.rows()).toEqual([{ id: 'a' }]);
  });

  it('resetAll restores every registered fixture at once', () => {
    const registry = createFixtureRegistry();
    const a = defineFixture<{ id: string }>({ key: 'a', scenarios: { default: () => [{ id: 'a1' }] }, registry });
    const b = defineFixture<{ id: string }>({ key: 'b', scenarios: { default: () => [{ id: 'b1' }] }, registry });

    a.rows().push({ id: 'a2' });
    b.rows().pop();
    expect(a.rows()).toHaveLength(2);
    expect(b.rows()).toHaveLength(0);

    registry.resetAll();
    expect(a.rows()).toEqual([{ id: 'a1' }]);
    expect(b.rows()).toEqual([{ id: 'b1' }]);
  });

  it('drops mutations left behind in a scenario the caller has walked away from', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'multi',
      scenarios: { default: () => [{ id: 'd' }], large: () => [{ id: 'l' }] },
      registry,
    });

    fixture.rows('large').push({ id: 'stray' });
    fixture.reset();
    expect(fixture.rows('large')).toEqual([{ id: 'l' }]);
  });
});

describe('scenarios', () => {
  it('falls back to default for any scenario the fixture does not declare', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'fallback',
      scenarios: { default: () => [{ id: 'seed' }], empty: () => [] },
      registry,
    });

    expect(fixture.rows('empty')).toEqual([]);
    for (const name of ['error', 'large', 'fresh'] as const) {
      expect(fixture.rows(name)).toEqual([{ id: 'seed' }]);
    }
  });

  it('keeps scenarios independent — mutating one does not touch another', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'iso',
      scenarios: { default: () => [{ id: 'd' }], empty: () => [] },
      registry,
    });

    fixture.rows('empty').push({ id: 'x' });
    expect(fixture.rows('default')).toEqual([{ id: 'd' }]);
    expect(fixture.rows('empty')).toEqual([{ id: 'x' }]);
  });

  it('resetAll(scenario) switches the world every fixture answers with', () => {
    const registry = createFixtureRegistry();
    const bots = defineFixture<{ id: string }>({
      key: 'bots',
      scenarios: { default: () => [{ id: 'bot-1' }], empty: () => [] },
      registry,
    });
    const people = defineFixture<{ id: string }>({
      key: 'people',
      scenarios: { default: () => [{ id: 'p-1' }] },
      registry,
    });

    expect(registry.scenario()).toBe('default');

    registry.resetAll('empty');
    expect(registry.scenario()).toBe('empty');
    expect(bots.rows()).toEqual([]); // declared empty
    expect(people.rows()).toEqual([{ id: 'p-1' }]); // undeclared → falls back

    registry.resetAll('default');
    expect(bots.rows()).toEqual([{ id: 'bot-1' }]);
  });

  it('an explicit scenario argument overrides the active one', () => {
    const registry = createFixtureRegistry();
    const fixture = defineFixture<{ id: string }>({
      key: 'explicit',
      scenarios: { default: () => [{ id: 'd' }], empty: () => [] },
      registry,
    });

    registry.resetAll('empty');
    expect(fixture.rows()).toEqual([]);
    expect(fixture.rows('default')).toEqual([{ id: 'd' }]);
  });

  it('publishes a one-line description for every scenario name', () => {
    expect(SCENARIO_NAMES).toEqual(['default', 'empty', 'error', 'large', 'fresh', 'demo', 'runbooks-demo', 'runbooks-tools-demo']);
    for (const name of SCENARIO_NAMES) {
      expect(describeScenario(name)).toEqual(SCENARIOS[name]);
      expect(SCENARIOS[name].name).toBe(name);
      expect(SCENARIOS[name].describes.length).toBeGreaterThan(10);
    }
    expect(isScenarioName('empty')).toBe(true);
    expect(isScenarioName('enterprise_context')).toBe(false);
  });
});

describe('registry', () => {
  it('exposes fixtures by key and as a list', () => {
    const registry = createFixtureRegistry();
    const a = defineFixture<{ id: string }>({ key: 'k-a', scenarios: { default: () => [] }, registry });

    expect(registry.get('k-a')).toBe(a);
    expect(registry.get('nope')).toBeUndefined();
    expect(registry.all()).toEqual([a]);
    expect(registry.size()).toBe(1);
  });

  it('rejects a duplicate key rather than shadowing a fixture out of resetAll', () => {
    const registry = createFixtureRegistry();
    defineFixture({ key: 'dup', scenarios: { default: () => [] }, registry });
    expect(() => defineFixture({ key: 'dup', scenarios: { default: () => [] }, registry })).toThrow(
      /already registered: dup/,
    );
  });

  it('rejects a rows array in place of a factory — that bakes timestamps at import', () => {
    const registry = createFixtureRegistry();
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defineFixture({ key: 'array', scenarios: { default: [{ id: 'a' }] as any }, registry }),
    ).toThrow(/must be a factory/);
  });

  it('registry: null defines an unregistered fixture (for a test that wants no side effects)', () => {
    const before = fixtureRegistry.size();
    const fixture = defineFixture<{ id: string }>({
      key: 'unregistered',
      scenarios: { default: () => [{ id: 'x' }] },
      registry: null,
    });
    expect(fixture.rows()).toEqual([{ id: 'x' }]);
    expect(fixtureRegistry.size()).toBe(before);
    expect(fixtureRegistry.get('unregistered')).toBeUndefined();
  });
});
