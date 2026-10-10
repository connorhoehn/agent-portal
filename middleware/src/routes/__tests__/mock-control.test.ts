// The mock control plane (routes/mock-control.ts).
//
// The gating cases are the point of this file. This plane can empty or break
// any surface in the process, so it must not exist outside a non-production
// mock dev server — and it must answer 404 rather than 403, because a 403
// confirms to a prober that the endpoint is real. Everything below the
// "gating" describe is the behaviour those gates protect.

const mockFlags = { aurora: true, agentcore: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() {
      return { aurora: mockFlags.aurora, agentcore: mockFlags.agentcore, guardrails: true, cloudwatch: true };
    },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import express from 'express';
import request from '../../test-support/http.js';
import {
  mockControlRouter,
  mockControlEnabled,
  setFixtureRegistry,
  __resetMockControlState,
} from '../mock-control.js';
import { errorHandler } from '../../lib/async-handler.js';
import type { Fixture, FixtureRegistry, Scenario, ScenarioName } from '../../mock/core/contract.js';

// ── Fixtures, built on the real floor ──────────────────────────────────────
//
// These use `defineFixture` / `createFixtureRegistry` from mock/core, not a
// hand-written stand-in, so the plane is tested against the registry it will
// actually drive — including the part the contract type does not state, that
// `rows()` with no argument resolves through the REGISTRY's active scenario.
// Each fixture goes into an isolated registry so a test never switches the
// world out from under a parallel suite.

import { createFixtureRegistry, defineFixture, describeScenario } from '../../mock/core/index.js';

interface Row { id: string }

const SIZES: Record<ScenarioName, number> = { default: 3, empty: 0, error: 0, large: 25, fresh: 1, demo: 3, 'distillation-demo': 3 };

function rowsOf(key: string, scenario: ScenarioName): () => Row[] {
  return () => Array.from({ length: SIZES[scenario] }, (_, i) => ({ id: `${key}-${i}` }));
}

function defineTestFixture(
  registry: ReturnType<typeof createFixtureRegistry>,
  key: string,
  opts: { describes?: boolean; throwsOnError?: boolean } = {},
): Fixture<Row> {
  const fixture = defineFixture<Row>({
    key,
    registry,
    scenarios: {
      default: rowsOf(key, 'default'),
      empty: rowsOf(key, 'empty'),
      large: rowsOf(key, 'large'),
      fresh: rowsOf(key, 'fresh'),
      error: opts.throwsOnError
        ? () => { throw new Error(`${key} is unavailable`); }
        : rowsOf(key, 'error'),
    },
  });
  if (opts.describes) {
    (fixture as Fixture<Row> & { scenarios(): Scenario[] }).scenarios =
      (): Scenario[] => [{ name: 'empty', describes: `No ${key} have been recorded yet.` }];
  }
  return fixture;
}

/** An isolated registry holding `keys`, wired into the plane. */
function withFixtures(keys: string[], opts: Record<string, { describes?: boolean; throwsOnError?: boolean }> = {}): FixtureRegistry {
  const registry = createFixtureRegistry();
  for (const key of keys) defineTestFixture(registry, key, opts[key] ?? {});
  setFixtureRegistry(registry);
  return registry;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(mockControlRouter);
  // A surface the plane does not own, so the header seam can be checked on a
  // response this module never writes.
  app.get('/api/anything', (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);
  return app;
}

const originalNodeEnv = process.env['NODE_ENV'];

beforeEach(() => {
  mockFlags.aurora = true;
  mockFlags.agentcore = true;
  process.env['NODE_ENV'] = 'development';
  delete process.env['MOCK_CONTROL_SECRET'];
  __resetMockControlState();
});

afterAll(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = originalNodeEnv;
});

// ── Gating ─────────────────────────────────────────────────────────────────

describe('gating', () => {
  const routes: Array<['get' | 'post', string]> = [
    ['get', '/api/__mock/scenarios'],
    ['get', '/api/__mock/state'],
    ['post', '/api/__mock/scenario'],
    ['post', '/api/__mock/reset'],
  ];

  it('404s every route when NODE_ENV=production, even with the mocks on', async () => {
    process.env['NODE_ENV'] = 'production';
    withFixtures(['bots']);
    expect(mockControlEnabled()).toBe(false);

    for (const [method, path] of routes) {
      const res = method === 'get'
        ? await request(buildApp()).get(path)
        : await request(buildApp()).post(path).send({ scenario: 'empty' });
      expect([method, path, res.status]).toEqual([method, path, 404]);
      // 404 and nothing else: no hint that a control plane exists here.
      expect(res.body).toEqual({ error: 'Not found' });
      expect(res.headers['x-mock-scenario']).toBeUndefined();
    }
  });

  it('404s every route when the mock providers are off', async () => {
    mockFlags.aurora = false;
    mockFlags.agentcore = false;
    withFixtures(['bots']);
    expect(mockControlEnabled()).toBe(false);

    for (const [method, path] of routes) {
      const res = method === 'get'
        ? await request(buildApp()).get(path)
        : await request(buildApp()).post(path).send({ scenario: 'empty' });
      expect([method, path, res.status]).toEqual([method, path, 404]);
      expect(res.body).toEqual({ error: 'Not found' });
    }
  });

  it('is reachable when either mock provider is on in a non-production process', async () => {
    withFixtures(['bots']);

    mockFlags.aurora = true; mockFlags.agentcore = false;
    expect((await request(buildApp()).get('/api/__mock/state')).status).toBe(200);

    mockFlags.aurora = false; mockFlags.agentcore = true;
    expect((await request(buildApp()).get('/api/__mock/state')).status).toBe(200);
  });

  it('honours an optional shared secret without ever downgrading the 404', async () => {
    withFixtures(['bots']);
    process.env['MOCK_CONTROL_SECRET'] = 'shhh';

    expect((await request(buildApp()).get('/api/__mock/state')).status).toBe(401);
    const ok = await request(buildApp()).get('/api/__mock/state').set('x-mock-control-auth', 'shhh');
    expect(ok.status).toBe(200);

    // Production still wins: the gate order must not leak a 401 there.
    process.env['NODE_ENV'] = 'production';
    expect((await request(buildApp()).get('/api/__mock/state')).status).toBe(404);
  });
});

// ── The menu ───────────────────────────────────────────────────────────────

describe('GET /api/__mock/scenarios', () => {
  it('lists the six worlds with a sentence each', async () => {
    withFixtures(['bots', 'people']);
    const res = await request(buildApp()).get('/api/__mock/scenarios');

    expect(res.status).toBe(200);
    expect(res.body.scenarios.map((s: Scenario) => s.name))
      .toEqual(['default', 'empty', 'error', 'large', 'fresh', 'demo', 'distillation-demo']);
    for (const s of res.body.scenarios) expect(s.describes.length).toBeGreaterThan(10);
  });

  it("prefers a fixture's own description over the generic one", async () => {
    withFixtures(['bots', 'people'], { bots: { describes: true } });
    const res = await request(buildApp()).get('/api/__mock/scenarios');

    const bots = res.body.fixtures.find((f: { key: string }) => f.key === 'bots');
    const people = res.body.fixtures.find((f: { key: string }) => f.key === 'people');
    const emptyOf = (f: { scenarios: Scenario[] }) => f.scenarios.find((s) => s.name === 'empty')!.describes;

    expect(emptyOf(bots)).toBe('No bots have been recorded yet.');
    expect(emptyOf(people)).toBe(describeScenario('empty').describes);
    // A fixture that declares one scenario still lists all five.
    expect(bots.scenarios).toHaveLength(5);
  });

  it('says so, rather than 500ing, when nothing has registered', async () => {
    withFixtures([]);
    const res = await request(buildApp()).get('/api/__mock/scenarios');
    expect(res.status).toBe(200);
    expect(res.body.registryLoaded).toBe(false);
    expect(res.body.fixtures).toEqual([]);
    expect(res.body.scenarios).toHaveLength(7);
  });
});

// ── Switching ──────────────────────────────────────────────────────────────

describe('POST /api/__mock/scenario', () => {
  it('switches every fixture at once', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    const res = await request(app).post('/api/__mock/scenario').send({ scenario: 'empty' });
    expect(res.status).toBe(200);
    expect(res.body.scenario).toBe('empty');
    expect(res.body.fixtures.map((f: { rows: number }) => f.rows)).toEqual([0, 0]);
  });

  it('switches one fixture and leaves the rest alone', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    const res = await request(app).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'bots' });
    expect(res.status).toBe(200);

    const state = (await request(app).get('/api/__mock/state')).body;
    expect(state.scenario).toBe('default');
    expect(state.fixtures).toEqual([
      { key: 'bots', scenario: 'empty', pinned: true, rows: 0 },
      { key: 'people', scenario: 'default', pinned: false, rows: 3 },
    ]);
  });

  it('rejects an unknown scenario with the list of known ones', async () => {
    withFixtures(['bots']);
    const res = await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'chaos' });
    expect(res.status).toBe(400);
    expect(res.body.known).toEqual(['default', 'empty', 'error', 'large', 'fresh', 'demo', 'distillation-demo']);
  });

  it('404s an unknown fixture key and names the keys that exist', async () => {
    withFixtures(['bots']);
    const res = await request(buildApp()).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.known).toEqual(['bots']);
  });

  it('a global switch overrules a pin — asking for the whole world means the whole world', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    await request(app).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'bots' });
    await request(app).post('/api/__mock/scenario').send({ scenario: 'large' });

    const state = (await request(app).get('/api/__mock/state')).body;
    expect(state.fixtures.every((f: { scenario: string; pinned: boolean }) => f.scenario === 'large' && !f.pinned)).toBe(true);
    expect(state.fixtures.map((f: { rows: number }) => f.rows)).toEqual([25, 25]);
  });
});

// ── Resetting ──────────────────────────────────────────────────────────────

describe('POST /api/__mock/reset', () => {
  it('puts the whole world back to default', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    await request(app).post('/api/__mock/scenario').send({ scenario: 'empty' });
    await request(app).post('/api/__mock/scenario').send({ scenario: 'large', fixture: 'people' });

    const res = await request(app).post('/api/__mock/reset').send({});
    expect(res.status).toBe(200);
    expect(res.body.scenario).toBe('default');
    expect(res.body.fixtures).toEqual([
      { key: 'bots', scenario: 'default', pinned: false, rows: 3 },
      { key: 'people', scenario: 'default', pinned: false, rows: 3 },
    ]);
  });

  it('resetting one fixture returns it to the world the rest are in, not to default', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    await request(app).post('/api/__mock/scenario').send({ scenario: 'large' });
    await request(app).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'bots' });
    await request(app).post('/api/__mock/reset').send({ fixture: 'bots' });

    const state = (await request(app).get('/api/__mock/state')).body;
    expect(state.fixtures).toEqual([
      { key: 'bots', scenario: 'large', pinned: false, rows: 25 },
      { key: 'people', scenario: 'large', pinned: false, rows: 25 },
    ]);
  });
});

// ── State ──────────────────────────────────────────────────────────────────

describe('GET /api/__mock/state', () => {
  it('reports a fixture that throws instead of failing the whole read', async () => {
    withFixtures(['bots', 'people'], { bots: { throwsOnError: true } });
    const app = buildApp();

    await request(app).post('/api/__mock/scenario').send({ scenario: 'error', fixture: 'bots' });
    const state = (await request(app).get('/api/__mock/state')).body;

    expect(state.fixtures[0]).toEqual({
      key: 'bots', scenario: 'error', pinned: true, rows: null, error: 'bots is unavailable',
    });
    expect(state.fixtures[1].rows).toBe(3);
  });
});

// ── The header seam ────────────────────────────────────────────────────────

describe('X-Mock-Scenario header', () => {
  it('names the active world on responses this plane does not own', async () => {
    withFixtures(['bots']);
    const app = buildApp();

    expect((await request(app).get('/api/anything')).headers['x-mock-scenario']).toBe('default');

    await request(app).post('/api/__mock/scenario').send({ scenario: 'empty' });
    expect((await request(app).get('/api/anything')).headers['x-mock-scenario']).toBe('empty');
  });

  it('reads "mixed" and names the pins when one fixture was switched alone', async () => {
    withFixtures(['bots', 'people']);
    const app = buildApp();

    await request(app).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'bots' });
    const res = await request(app).get('/api/anything');

    expect(res.headers['x-mock-scenario']).toBe('mixed');
    expect(res.headers['x-mock-scenario-pins']).toBe('bots=empty');
  });

  it('stamps nothing outside a mock dev process — an unstamped response is not mock-served', async () => {
    mockFlags.aurora = false;
    mockFlags.agentcore = false;
    const res = await request(buildApp()).get('/api/anything');
    expect(res.status).toBe(200);
    expect(res.headers['x-mock-scenario']).toBeUndefined();
  });
});

// ── The plane may only advertise and accept what a fixture implements ───────
//
// Both halves of one lie, found 2026-09-18 auditing error states. `compute-nodes`
// declares default/empty/fresh/large and NOT error, yet:
//   - GET /scenarios listed `error` for it, describing it as "Providers fail,
//     so a surface has to render an error state rather than a blank panel";
//   - POST /scenario {fixture:'compute-nodes',scenario:'error'} returned 200,
//     GET /state then reported it pinned to `error`, and the rows came back
//     `default` with HTTP 200.
// An auditor doing exactly what docs/mock-floor.md says — "to see an empty or
// error state, ask for it" — got a healthy page and would have concluded the
// surface handles a failed read.
describe('scenarios are per-fixture, not the global catalogue', () => {
  function partialFixture(registry: ReturnType<typeof createFixtureRegistry>, key: string) {
    // default + empty only: no `error`, no `large`, no `fresh`.
    return defineFixture<Row>({ key, registry, scenarios: { default: rowsOf(key, 'default'), empty: rowsOf(key, 'empty') } });
  }

  it('GET /scenarios lists only what the fixture declares', async () => {
    const registry = createFixtureRegistry();
    partialFixture(registry, 'partial');
    defineTestFixture(registry, 'full');
    setFixtureRegistry(registry);

    const res = await request(buildApp()).get('/api/__mock/scenarios').expect(200);
    const partial = res.body.fixtures.find((f: { key: string }) => f.key === 'partial');
    const full = res.body.fixtures.find((f: { key: string }) => f.key === 'full');
    expect(partial.scenarios.map((s: { name: string }) => s.name).sort()).toEqual(['default', 'empty']);
    expect(full.scenarios.map((s: { name: string }) => s.name)).toContain('error');
  });

  it('POST /scenario refuses a scenario the fixture has no branch for', async () => {
    const registry = createFixtureRegistry();
    partialFixture(registry, 'partial');
    setFixtureRegistry(registry);

    const res = await request(buildApp())
      .post('/api/__mock/scenario')
      .send({ fixture: 'partial', scenario: 'error' })
      .expect(409);
    expect(res.body.error).toMatch(/does not implement/i);
    expect(res.body.declares.sort()).toEqual(['default', 'empty']);

    // and it did NOT record a pin it cannot honour
    const state = await request(buildApp()).get('/api/__mock/state').expect(200);
    const row = state.body.fixtures.find((f: { key: string }) => f.key === 'partial');
    expect(row.pinned).toBe(false);
    expect(row.scenario).toBe('default');
  });

  it('a scenario the fixture DOES declare still pins', async () => {
    const registry = createFixtureRegistry();
    partialFixture(registry, 'partial');
    setFixtureRegistry(registry);
    await request(buildApp()).post('/api/__mock/scenario').send({ fixture: 'partial', scenario: 'empty' }).expect(200);
    const state = await request(buildApp()).get('/api/__mock/state').expect(200);
    const row = state.body.fixtures.find((f: { key: string }) => f.key === 'partial');
    expect(row.scenario).toBe('empty');
  });
});
