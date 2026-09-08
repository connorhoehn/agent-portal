// The mock control plane — dev-only, so an audit can ASK for a world instead
// of damaging one.
//
// WHY THIS EXISTS. Every browser audit this week that needed an empty table or
// an error state got there by mutating shared dev:mock state, then warned the
// next auditor in its log: "promo-aurora-cold-start is now Promoted until the
// middleware restarts", "the store gained TEAM-008". That is a shared mutable
// world with a changelog written in prose. These four routes replace it:
//
//   GET  /api/__mock/scenarios  — what worlds exist, and what each one means
//   POST /api/__mock/scenario   — switch everything, or one fixture, to a world
//   POST /api/__mock/reset      — put the starting state back
//   GET  /api/__mock/state      — which world each fixture is in right now
//
// GATING. This plane can reset, empty and break any surface, so it must be
// unreachable outside a mock dev process. Two conditions, both required:
// the mock providers are on (`config.mock.aurora` or `config.mock.agentcore`)
// AND `NODE_ENV !== 'production'`. Failing either, every route answers 404 —
// not 403 — because a 403 confirms the endpoint exists. Following the
// machine-callback precedent in this repo (`requireTraceAuth` in harness.ts,
// `requireServiceAuth` in approvals.ts), the guard is applied PER ROUTE rather
// than as a blanket `router.use`, and the routes carry no session floor: an
// auditor curls them with no cookie, and `dev:mock` has no real identity to
// speak of. An optional shared secret (`MOCK_CONTROL_SECRET`) is honoured the
// same way those callbacks honour theirs — open when unset, constant-time
// header check when set — for the one case that matters, a mock middleware
// reachable from something other than localhost.
//
// This module owns no fixture data. It drives whatever registered itself with
// the FixtureRegistry in mock/core/contract.ts; if nothing has, it says so
// rather than pretending the world is empty.

import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../config.js';

import {
  fixtureRegistry,
  describeScenario,
  isScenarioName,
  SCENARIO_NAMES,
  type Fixture,
  type FixtureRegistry,
  type Scenario,
  type ScenarioName,
} from '../mock/core/index.js';
import { requireServiceAuth, MOCK_CONTROL_SERVICE_AUTH } from '../lib/service-auth.js';
import { join } from 'node:path';
import { handlerSha, handlerSourceFiles } from '../mock/core/wire/handler-sha.js';

export const mockControlRouter = Router();

// Registered FIRST so the header below reaches every response, this plane's
// own included — a router layer added after a matching route never runs.
mockControlRouter.use(stampScenarioHeader);

// ── The worlds ─────────────────────────────────────────────────────────────

/**
 * The five named worlds and their sentences, taken from the floor rather than
 * restated here — a second copy of "what `empty` means" would drift from the
 * one the fixtures are written against. A fixture may still override a line
 * for itself (see `DescribedFixture` below).
 */
const SCENARIOS: readonly Scenario[] = SCENARIO_NAMES.map((name) => describeScenario(name));

const DEFAULT_SCENARIO: ScenarioName = 'default';

/**
 * A fixture MAY describe its own scenarios — "empty" means something different
 * for a bot-run history than for an org chart, and the auditor asking for it
 * deserves that sentence rather than the generic one. Structural and optional,
 * so no fixture is obliged to implement it.
 */
interface DescribedFixture {
  scenarios?(): readonly Scenario[];
}

function describeFixture(fixture: Fixture<unknown>): Scenario[] {
  const declared = (fixture as unknown as DescribedFixture).scenarios?.();
  const byName = new Map<string, Scenario>();
  for (const s of SCENARIOS) byName.set(s.name, s);
  if (Array.isArray(declared)) {
    for (const s of declared) {
      if (s && isScenarioName(s.name) && typeof s.describes === 'string') {
        byName.set(s.name, { name: s.name, describes: s.describes });
      }
    }
  }
  return SCENARIOS.map((s) => byName.get(s.name) ?? s);
}

// ── Gating ─────────────────────────────────────────────────────────────────

/**
 * True only in a non-production process running the mock providers. Read at
 * request time, never cached: a test flips NODE_ENV between cases, and caching
 * would make the 404 depend on import order.
 */
export function mockControlEnabled(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return Boolean(config.mock?.aurora || config.mock?.agentcore);
}

/**
 * 404, not 403. A 403 tells a prober that `/api/__mock` is a real surface on
 * this host; a 404 says only what an unmounted path would say. The body
 * matches Express's own default shape so it is not distinguishable by content
 * either.
 */
function requireMockPlane(_req: Request, res: Response, next: NextFunction): void {
  if (!mockControlEnabled()) { res.status(404).json({ error: 'Not found' }); return; }
  next();
}

/**
 * Optional shared secret, same contract as the agent callbacks in this repo:
 * open when `MOCK_CONTROL_SECRET` is unset (the normal laptop case), a
 * constant-time header check when it is set. Runs after requireMockPlane so a
 * production probe still gets 404 rather than 401.
 */
const requireControlSecret = requireServiceAuth(
  MOCK_CONTROL_SERVICE_AUTH,
  'mock control authentication required',
);

const gate = [requireMockPlane, requireControlSecret];

// ── Which world are we in ──────────────────────────────────────────────────

/**
 * The registry owns the world everything resolves to (`registry.scenario()`).
 * This mirror exists so the response header below can name it synchronously,
 * on every request, without reaching into the registry; it is re-synced from
 * the registry on every control-plane call.
 */
let globalScenario: ScenarioName = DEFAULT_SCENARIO;

/** Fixtures switched on their own, away from the global world. See `pin`. */
const overrides = new Map<string, ScenarioName>();

function effectiveScenario(key: string): ScenarioName {
  return overrides.get(key) ?? globalScenario;
}

/** Exported for tests and for the header seam; not a route. */
export function activeScenarioLabel(): string {
  if (overrides.size === 0) return globalScenario;
  return 'mixed';
}

// ── Reaching the registry ──────────────────────────────────────────────────

/**
 * The shared registry every fixture registers with (mock/core/fixture.ts).
 * `setFixtureRegistry` swaps in an isolated one — `createFixtureRegistry()` —
 * so a test never switches the world out from under a parallel suite.
 */
let injected: FixtureRegistry | null = null;

/** Test seam: drive an isolated registry instead of the shared one. */
export function setFixtureRegistry(registry: FixtureRegistry | null): void {
  injected = registry;
}

/** The registry also tracks which world is live; the contract type does not say so. */
interface ScenarioAwareRegistry extends FixtureRegistry {
  scenario?(): ScenarioName;
}

function resolveRegistry(): FixtureRegistry {
  const registry = injected ?? fixtureRegistry;
  // Re-sync the mirror: `resetAll` is callable from anywhere (a test, a
  // provider), and the header must not report a world this module happens to
  // remember rather than the one fixtures are actually resolving against.
  const live = (registry as ScenarioAwareRegistry).scenario?.();
  if (live && isScenarioName(live)) globalScenario = live;
  return registry;
}

function listFixtures(registry: FixtureRegistry): Array<Fixture<unknown>> {
  try {
    return registry.all().filter((f): f is Fixture<unknown> => !!f && typeof f.key === 'string');
  } catch {
    return [];
  }
}

// ── Pinning one fixture ────────────────────────────────────────────────────
//
// The registry resolves `rows()` through ONE active scenario, which is the
// right default — an auditor asking for the empty world wants the whole page
// empty, not one panel. But "show me this table empty against an otherwise
// normal page" is a real audit, and the contract has no per-fixture pin.
//
// So the plane pins by wrapping the fixture's own `rows`: with no argument it
// resolves to the pinned scenario instead of the registry's; with an explicit
// argument it passes straight through, unchanged. The original is kept on the
// fixture and put back on unpin, so nothing about the fixture module changes
// and a pin cannot outlive the process. This is dev-only code reaching into
// dev-only data; it is confined to this file on purpose.

const PINNED = Symbol.for('orgiq.mockControl.originalRows');

type Pinnable = Fixture<unknown> & { [PINNED]?: (scenario?: ScenarioName) => unknown[] };

function pin(fixture: Fixture<unknown>, scenario: ScenarioName): void {
  const target = fixture as Pinnable;
  const original = target[PINNED] ?? fixture.rows.bind(fixture);
  target[PINNED] = original;
  target.rows = (asked?: ScenarioName) => original(asked ?? scenario);
  overrides.set(fixture.key, scenario);
  // Rebuild that world from its factory so the pin starts from the seed, not
  // from whatever a previous audit left mutated in it.
  fixture.reset(scenario);
}

function unpin(fixture: Fixture<unknown>): void {
  const target = fixture as Pinnable;
  const original = target[PINNED];
  if (original) {
    target.rows = original;
    delete target[PINNED];
  }
  overrides.delete(fixture.key);
}

function unpinAll(registry: FixtureRegistry): void {
  for (const fixture of listFixtures(registry)) unpin(fixture);
  overrides.clear();
}

// ── State reporting ────────────────────────────────────────────────────────

interface FixtureState {
  key: string;
  scenario: ScenarioName;
  /** Whether this fixture was switched on its own, away from the global world. */
  pinned: boolean;
  /** Counted from the rows, never stored — a stored count drifts from its rows. */
  rows: number | null;
  /** Present when reading the rows threw, which the `error` scenario may do on purpose. */
  error?: string;
}

function readState(registry: FixtureRegistry): {
  enabled: boolean;
  scenario: ScenarioName;
  fixtures: FixtureState[];
  registryLoaded: boolean;
} {
  const fixtures = listFixtures(registry).map((fixture): FixtureState => {
    const scenario = effectiveScenario(fixture.key);
    const base = { key: fixture.key, scenario, pinned: overrides.has(fixture.key) };
    try {
      const rows = fixture.rows();
      return { ...base, rows: Array.isArray(rows) ? rows.length : null };
    } catch (err) {
      return { ...base, rows: null, error: (err as Error).message };
    }
  });
  fixtures.sort((a, b) => a.key.localeCompare(b.key));
  // `registryLoaded` answers the question a blank surface always raises in
  // dev:mock: is this feature unseeded, or has no fixture registered at all?
  return { enabled: true, scenario: globalScenario, fixtures, registryLoaded: fixtures.length > 0 };
}

// ── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /api/__mock/scenarios — the menu. Every world, the sentence that
 * describes it, and per fixture the sentence THAT fixture declares for it
 * (fixtures that declare nothing report the shared line).
 */
mockControlRouter.get('/api/__mock/scenarios', ...gate, (_req, res) => {
  const registry = resolveRegistry();
  const fixtures = listFixtures(registry);
  res.json({
    scenarios: SCENARIOS,
    fixtures: fixtures
      .map((f) => ({ key: f.key, scenarios: describeFixture(f) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    registryLoaded: fixtures.length > 0,
  });
});

/**
 * POST /api/__mock/scenario { scenario, fixture? } — switch the world.
 *
 * With no `fixture` the registry's active scenario changes, so every fixture
 * — including one that registers later — resolves to it. With `fixture`, only
 * that fixture moves, and it is *pinned*: a later global switch drops the pin
 * and takes it along, because an auditor asking for the whole world means the
 * whole world. /state reports the pin so a journey log can say why one panel
 * differs from the rest of the page.
 */
mockControlRouter.post('/api/__mock/scenario', ...gate, (req, res) => {
  const body = (req.body ?? {}) as { scenario?: unknown; fixture?: unknown };
  if (!isScenarioName(body.scenario)) {
    res.status(400).json({ error: 'unknown scenario', got: body.scenario ?? null, known: SCENARIO_NAMES });
    return;
  }
  const scenario = body.scenario;
  const registry = resolveRegistry();

  if (body.fixture !== undefined) {
    const fixture = findFixture(registry, body.fixture, res);
    if (!fixture) return;
    pin(fixture, scenario);
    res.json({ applied: { scenario, fixture: fixture.key }, ...readState(registry) });
    return;
  }

  unpinAll(registry);
  registry.resetAll(scenario);
  globalScenario = scenario;
  res.json({ applied: { scenario, fixture: null }, ...readState(registry) });
});

/**
 * POST /api/__mock/reset { fixture? } — put the starting state back.
 *
 * No `fixture`: the whole process returns to `default`, pins included — the
 * "undo my audit" button, and the one call that makes a shared dev:mock server
 * safe to hand to the next person. With `fixture`: that fixture drops its pin
 * and rejoins whatever world the rest of the process is in, so resetting one
 * table does not silently drag the others back to default.
 */
mockControlRouter.post('/api/__mock/reset', ...gate, (req, res) => {
  const body = (req.body ?? {}) as { fixture?: unknown };
  const registry = resolveRegistry();

  if (body.fixture !== undefined) {
    const fixture = findFixture(registry, body.fixture, res);
    if (!fixture) return;
    unpin(fixture);
    fixture.reset();
    res.json({ reset: { fixture: fixture.key, scenario: globalScenario }, ...readState(registry) });
    return;
  }

  unpinAll(registry);
  registry.resetAll(DEFAULT_SCENARIO);
  globalScenario = DEFAULT_SCENARIO;
  res.json({ reset: { fixture: null, scenario: DEFAULT_SCENARIO }, ...readState(registry) });
});

/**
 * GET /api/__mock/state — what to paste into a journey log: the world, the
 * per-fixture worlds, and a row count for each so "empty" is visibly empty.
 */
mockControlRouter.get('/api/__mock/state', ...gate, (_req, res) => {
  res.json({ ...readState(resolveRegistry()), handlerSha: bootHandlerSha() });
});

/**
 * The digest of the handler sources THIS PROCESS booted from, computed once.
 *
 * The wire capture records it so the snapshot can prove which code produced
 * it. Without that, freshness was an mtime comparison, and a sweep run against
 * a server booted before an edit wrote a file whose mtime was newer than the
 * source it disagreed with — the check passed over a snapshot that held the
 * pre-change shape. Computed lazily and cached: it is only ever asked for by
 * the capture, and hashing the tree costs nothing once.
 */
let _bootSha: string | null = null;
function bootHandlerSha(): string | null {
  if (_bootSha !== null) return _bootSha;
  try {
    // `process.cwd()`, NOT `import.meta.url`: this module is compiled by the
    // CJS jest config, where `import.meta` is a hard TS1343 error that takes
    // the whole suite down — the same trap the env-read note at the top of
    // this file describes. The server is started from `middleware/`, and if it
    // ever is not, `handlerSourceFiles` finds nothing and we report null
    // rather than a digest of the wrong tree.
    const srcDir = join(process.cwd(), 'src');
    if (handlerSourceFiles(srcDir).length === 0) { _bootSha = ''; return null; }
    _bootSha = handlerSha(srcDir);
  } catch {
    // Running from a build with no sources beside it: say nothing rather than
    // report a digest of the wrong thing.
    _bootSha = '';
  }
  return _bootSha || null;
}

/** Resolve a fixture key, answering the request itself when it is not one. */
function findFixture(registry: FixtureRegistry, key: unknown, res: Response): Fixture<unknown> | null {
  if (typeof key !== 'string') {
    res.status(400).json({ error: 'fixture must be a string key' });
    return null;
  }
  const fixture = registry.get(key);
  if (!fixture) {
    res.status(404).json({
      error: 'unknown fixture',
      fixture: key,
      known: listFixtures(registry).map((f) => f.key).sort(),
    });
    return null;
  }
  return fixture;
}

// ── The header seam ────────────────────────────────────────────────────────

/**
 * Name the active world on EVERY response, not just this plane's.
 *
 * The seam is that this router is mounted at the app root, so it sees every
 * request on the way in and can stamp a header before any handler writes a
 * body — no per-route change anywhere else, and nothing to keep in sync. The
 * value comes from this module's own record of what was asked for, so it costs
 * no registry load per request. Outside a mock dev process it stamps nothing,
 * which is itself the signal: a response with no `X-Mock-Scenario` is not
 * mock-served.
 */
function stampScenarioHeader(_req: Request, res: Response, next: NextFunction): void {
  if (!mockControlEnabled()) { next(); return; }
  res.setHeader('X-Mock-Scenario', activeScenarioLabel());
  if (overrides.size > 0) {
    res.setHeader(
      'X-Mock-Scenario-Pins',
      [...overrides.entries()].map(([key, scenario]) => `${key}=${scenario}`).sort().join(','),
    );
  }
  next();
}

/**
 * Test seam: forget every switch this process has been asked for, including
 * any pins still wrapped around a fixture's `rows`. Restores pins before it
 * drops the registry reference — otherwise a wrapped `rows` would survive on
 * the shared fixture with nothing left holding the record of it.
 */
export function __resetMockControlState(): void {
  const registry = injected ?? fixtureRegistry;
  for (const fixture of listFixtures(registry)) unpin(fixture);
  overrides.clear();
  globalScenario = DEFAULT_SCENARIO;
  injected = null;
}
