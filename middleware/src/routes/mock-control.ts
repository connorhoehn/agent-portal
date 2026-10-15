import { persistInitiativeDecks, initiativeDeckDurabilityEnabled, initiativeDeckRelationalFixtures } from '../mock/initiative-deck-durability.js';
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
  declaredScenariosFor,
  describeScenario,
  isScenarioName,
  SCENARIO_NAMES,
  type Fixture,
  type FixtureRegistry,
  type Scenario,
  type ScenarioName,
  clearMockScopes,
  createMockScope,
  currentMockScope,
  deleteMockScope,
  describeMockScope,
  getMockScope,
  isDataState,
  listMockScopes,
  runInMockScope,
  ScopeLimitError,
  DATA_STATES,
  type MockScope,
  type ScopeScenario,
} from '../mock/core/index.js';
import { cloneIdentity, CloneRefused, deleteIdentityClone, listIdentityClones } from '../providers/identity.js';
import { identityClonesFixture } from '../mock/identity-clones.js';
import { requireServiceAuth, MOCK_CONTROL_SERVICE_AUTH } from '../lib/service-auth.js';
import { join } from 'node:path';
import { handlerSha, handlerSourceFiles } from '../mock/core/wire/handler-sha.js';
import { clearDevPairings } from '../mock/dev-pairings.js';
import { rehydrateMockFleet } from '../providers/devbox-fleet-store.js';
import { rehydrateMockCrawlTargets } from '../lib/crawl-targets.js';
import { rehydrateMockCrawls } from '../lib/crawler.js';
import { rehydrateMockSchedules } from '../lib/ingest-scheduler.js';
import { rehydrateMockNotifications } from '../lib/notification-store.js';
import { rehydrateMockSocialChat } from '../lib/social-chat.js';
import { getDemoState, resetDemoDirector, startDemoDirector, stopDemoDirector } from '../mock/demo-director.js';
import { getDistillationDemoState, resetDistillationDemo, startDistillationDemo, stopDistillationDemo } from '../mock/distillation-demo.js';
import { invalidateAll } from '../lib/gateway/authority-invalidation.js';

export const mockControlRouter = Router();

/**
 * The ingest pipeline's three in-memory stores (crawl targets, crawl history,
 * ingestion schedules) have the exact same shape of trap as the devbox fleet:
 * each is a plain Map/array hydrated from a COPY of its fixture's rows, so
 * `registry.resetAll()` cannot reach any of them. Bundled into one call
 * alongside every `rehydrateMockFleet()` call below, following that
 * precedent. Each rehydrate is individually a no-op when Aurora is real.
 */
function rehydrateIngestMocks(): void {
  rehydrateMockCrawlTargets();
  rehydrateMockCrawls();
  rehydrateMockSchedules();
}

/**
 * Every rehydrate above reads its fixture's `rows()`, and `rows()` THROWS when
 * that fixture is pinned to `error` — that is what an error scenario is. These
 * run from this plane's own POST handlers, so an erroring fixture took the PIN
 * REQUEST down with it: measured 2026-09-18, `POST /scenario
 * {fixture:'devbox-boxes',scenario:'error'}` answered **500** from inside
 * `rehydrateMockFleet`, and the plane could not serve a world it advertises.
 *
 * Caught per rehydrate so one failing fixture cannot prevent the others from
 * re-hydrating. Nothing is hidden by this: the fixture stays pinned to `error`
 * and every route that reads it still fails, which is the whole point of the
 * scenario. The only thing suppressed is the mirror-refresh of an in-memory
 * copy of rows nobody could read.
 */
function rehydrateAll(): void {
  // The gateway's notification inbox is the same kind of copy (an in-memory
  // store seeded from mock/notifications.ts), so it is rebuilt here too.
  // The social chat's ChatService keeps a per-channel cache in front of the
  // fixture-backed store (lib/social-chat.ts), dropped here the same way.
  for (const step of [rehydrateMockFleet, rehydrateIngestMocks, rehydrateMockNotifications, rehydrateMockSocialChat]) {
    try { step(); } catch { /* the fixture is pinned to `error`; its routes report it */ }
  }
  // A world switch rewrites grants, rosters, memberships and rows at once: the
  // gateway's cached verdicts cannot survive it (lib/gateway/authority-invalidation.ts).
  invalidateAll('mock-world');
}

// Registered FIRST so the header below reaches every response, this plane's
// own included — a router layer added after a matching route never runs.
mockControlRouter.use(stampScenarioHeader);
// Second: a request carrying a scope id runs the rest of its life inside that
// scope (mock/core/scope.ts). Everything mounted after this router — every
// API route — resolves fixtures through it.
mockControlRouter.use(enterMockScope);

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
  // Only what this fixture actually has a branch for. This listing used to
  // return all five for EVERY fixture — the global catalogue, not the
  // fixture's own — so `compute-nodes` advertised `error` ("Providers fail,
  // so a surface has to render an error state rather than a blank panel")
  // while declaring only default/empty/fresh/large. An auditor following
  // docs/mock-floor.md exactly — "to see an empty or error state, ask for
  // it" — pinned it, got a healthy 200 and a normal page, and would have
  // concluded the surface handles a failed read. It does not; the scenario
  // simply fell through to `default`. `declaredScenariosFor` is the same
  // accessor scenario-coverage.test.ts uses to tell "implements it" from
  // "resolves for it", which is exactly the distinction this endpoint owes
  // its caller.
  const has = declaredScenariosFor(fixture);
  return SCENARIOS.filter((s) => has.has(s.name)).map((s) => byName.get(s.name) ?? s);
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
  // A pin is a fact about the SHARED world. Inside a request scope the scope
  // decides, so the pin steps aside and the scope's own resolution runs.
  target.rows = (asked?: ScenarioName) => original(asked ?? (currentMockScope() ? undefined : scenario));
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
  demo: ReturnType<typeof getDemoState>;
  distillationDemo: ReturnType<typeof getDistillationDemoState>;
  scopes: number;
  clones: number;
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
  // `demo` is where the Computer Lab demo's story has got to (mock/demo-director.ts)
  // — phase and milestones, so an e2e can wait on the story instead of a clock.
  // `distillationDemo` is the same for the Distillation demo (mock/distillation-demo.ts).
  return {
    enabled: true, scenario: globalScenario, fixtures, registryLoaded: fixtures.length > 0,
    demo: getDemoState(), distillationDemo: getDistillationDemoState(),
    scopes: listMockScopes().length, clones: listIdentityClones().length,
  };
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
    if (initiativeDeckDurabilityEnabled() && typeof body.fixture === 'string' && initiativeDeckRelationalFixtures.includes(body.fixture)) {
      res.status(409).json({ error: 'Local deck persistence keeps decks and their revision history together. Use a full mock reset or scenario change.', relatedFixtures: initiativeDeckRelationalFixtures });
      return;
    }
    const fixture = findFixture(registry, body.fixture, res);
    if (!fixture) return;
    // Refuse a scenario this fixture has no branch for, rather than pinning a
    // no-op. Accepting it was the other half of the same lie: the pin was
    // stored, `GET /state` reported the fixture as `error`, and the rows came
    // back `default` — so the plane confirmed a world it was not serving.
    // 409, not 400: the request is well-formed and the scenario name is real,
    // it is this fixture that cannot honour it.
    const declared = declaredScenariosFor(fixture);
    if (!declared.has(scenario)) {
      res.status(409).json({
        error: 'fixture does not implement this scenario',
        fixture: fixture.key,
        requested: scenario,
        declares: SCENARIO_NAMES.filter((n) => declared.has(n)),
      });
      return;
    }
    // A pin rebuilds the in-memory fleet and silences every run in flight
    // (rehydrateAll), so a demo story cannot survive it — say so by stopping.
    stopDemoDirector();
    stopDistillationDemo();
    pin(fixture, scenario);
    // See rehydrateMockFleet's doc comment: the microVM fleet lives in an
    // in-memory Map, not in fixture rows, so pinning `devbox-boxes` to `empty`
    // changed the fixture and left five boxes on screen — the scenario plane's
    // one promise ("ask for an empty state by name") silently not kept for
    // this fixture. Cheap enough to run unconditionally; it no-ops off mock.
    rehydrateAll();
    persistInitiativeDecks();
    res.json({ applied: { scenario, fixture: fixture.key }, ...readState(registry) });
    return;
  }

  resetDemoDirector();
  resetDistillationDemo();
  unpinAll(registry);
  // Clones survive a world switch: another auditor asking for `empty` must not
  // sign this run out. Only a full reset (below) removes them.
  const clones = [...listIdentityClones()];
  registry.resetAll(scenario);
  identityClonesFixture.rows().push(...clones);
  rehydrateAll();
  persistInitiativeDecks();
  globalScenario = scenario;
  // The `demo` world is a story, not only a state: its director dispatches
  // through this server's own routes (mock/demo-director.ts), so it is handed
  // the address this request arrived on.
  if (scenario === 'demo') {
    // Optional per-start knobs, so an e2e can play the story fast against a
    // running server: `paceMs` (beat length) and `autoAnswer` (false → only a
    // person answers B). Each falls back to its env when absent.
    const raw = req.body as { paceMs?: unknown; autoAnswer?: unknown };
    const port = req.socket.localPort;
    void startDemoDirector(`http://127.0.0.1:${port}`, {
      ...(typeof raw.paceMs === 'number' && raw.paceMs >= 0 ? { paceMs: raw.paceMs } : {}),
      ...(typeof raw.autoAnswer === 'boolean' ? { autoAnswer: raw.autoAnswer } : {}),
    });
  }
  // The Distillation demo plays in-process into the world just established.
  // Same per-start knobs as `demo`: `paceMs` (beat length) and
  // `autoDecideBeats` (how long it waits for a person on the open pattern;
  // 0 → only a person decides it).
  if (scenario === 'distillation-demo') {
    const raw = req.body as { paceMs?: unknown; autoDecideBeats?: unknown };
    void startDistillationDemo({
      ...(typeof raw.paceMs === 'number' && raw.paceMs >= 0 ? { paceMs: raw.paceMs } : {}),
      ...(typeof raw.autoDecideBeats === 'number' && raw.autoDecideBeats >= 0 ? { autoDecideBeats: raw.autoDecideBeats } : {}),
    });
  }
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
    if (initiativeDeckDurabilityEnabled() && typeof body.fixture === 'string' && initiativeDeckRelationalFixtures.includes(body.fixture)) {
      res.status(409).json({ error: 'Local deck persistence keeps decks and their revision history together. Use a full mock reset or scenario change.', relatedFixtures: initiativeDeckRelationalFixtures });
      return;
    }
    const fixture = findFixture(registry, body.fixture, res);
    if (!fixture) return;
    stopDemoDirector();
    stopDistillationDemo();
    unpin(fixture);
    fixture.reset();
    rehydrateAll();
    persistInitiativeDecks();
    res.json({ reset: { fixture: fixture.key, scenario: globalScenario }, ...readState(registry) });
    return;
  }

  resetDemoDirector();
  resetDistillationDemo();
  unpinAll(registry);
  // The dev-pairing file as well as the rows: without this, a machine paired
  // by hand reappears on the next boot and `reset` silently means "reset most
  // of it". No-op unless MOCK_PERSIST_PAIRINGS=1 (see mock/dev-pairings.ts).
  clearDevPairings();
  // Every request scope goes too, and `resetAll` empties the identity-clones
  // fixture, so every clone (and every session minted for one) is gone.
  clearMockScopes();
  registry.resetAll(DEFAULT_SCENARIO);
  identityClonesFixture.reset();
  // Same reason as the line above: the microVM fleet lives in an in-memory Map
  // in lib/devbox-fleet.ts, not in fixture rows, so `resetAll` cannot reach a
  // box that was renamed or stopped during a demo. Runs AFTER resetAll so it
  // re-reads the fixture in the world the reset just established.
  rehydrateAll();
  persistInitiativeDecks();
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

// ── Request scopes ─────────────────────────────────────────────────────────
//
// A scope is a world only the requests carrying its id see — the cookie below
// or the `x-mock-scope` header. The global world, every other session and the
// shared fixture rows are untouched by anything done inside one (see
// mock/core/scope.ts for the copy-on-write rule and the data states).

export const MOCK_SCOPE_COOKIE = 'orgiq.mock-scope';
export const MOCK_SCOPE_HEADER = 'x-mock-scope';

/** Story scenarios run a process-wide director; they cannot be one context's. */
const GLOBAL_ONLY: ReadonlySet<string> = new Set(['demo', 'distillation-demo']);

function isScopeScenario(value: unknown): value is ScopeScenario {
  return (isScenarioName(value) || isDataState(value)) && !GLOBAL_ONLY.has(value as string);
}

function scopeIdOf(req: Request): string | null {
  const header = req.headers[MOCK_SCOPE_HEADER];
  if (typeof header === 'string' && header) return header;
  const parsed = (req as Request & { cookies?: Record<string, string> }).cookies?.[MOCK_SCOPE_COOKIE];
  if (typeof parsed === 'string' && parsed) return parsed;
  // A router mounted without cookie-parser (a test app) still honours the cookie.
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === MOCK_SCOPE_COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Run the request inside its scope. The control plane's own routes stay
 * global (they manage scopes; they are not served from one). An id that names
 * no live scope is refused with 410 rather than served from the shared world:
 * a context that believes it is in its own world must not write into everyone's.
 */
function enterMockScope(req: Request, res: Response, next: NextFunction): void {
  if (!mockControlEnabled()) { next(); return; }
  const id = scopeIdOf(req);
  if (!id || req.path.startsWith('/api/__mock')) { next(); return; }
  const scope = getMockScope(id);
  if (!scope) {
    res.clearCookie(MOCK_SCOPE_COOKIE, { path: '/' });
    res.status(410).json({ error: 'mock scope expired or unknown — create a new one (POST /api/__mock/scope)', scope: id });
    return;
  }
  res.setHeader('X-Mock-Scenario', scope.base);
  res.removeHeader('X-Mock-Scenario-Pins');
  res.setHeader('X-Mock-Scope', scope.id);
  const named = Object.entries(scope.fixtures);
  if (named.length > 0) res.setHeader('X-Mock-Scope-Fixtures', named.map(([k, v]) => `${k}=${v}`).sort().join(','));
  const go = (): void => { runInMockScope(scope, () => next()); };
  if (scope.delayMs > 0) setTimeout(go, scope.delayMs); else go();
}

function scopeReport(scope: MockScope): ReturnType<typeof describeMockScope> & { rows: Record<string, number | null> } {
  const registry = injected ?? fixtureRegistry;
  const rows: Record<string, number | null> = {};
  runInMockScope(scope, () => {
    for (const key of scope.touched) {
      const fixture = registry.get(key);
      if (!fixture) continue;
      try { rows[key] = fixture.rows().length; } catch { rows[key] = null; }
    }
  });
  return { ...describeMockScope(scope), rows };
}

/**
 * POST /api/__mock/scope { scenario, fixture? | fixtures?, label?, ttlMs?, delayMs? }
 *
 * `{ scenario }` — every fixture in the scope resolves to it.
 * `{ scenario, fixture }` — only that fixture; the rest of the scope is `default`.
 * `{ fixtures: { key: scenario }, scenario? }` — several, over an optional base.
 * Answers 201 with the scope id, sets the `orgiq.mock-scope` cookie on the
 * caller, and names the header that carries the same id.
 */
mockControlRouter.post('/api/__mock/scope', ...gate, (req, res) => {
  const body = (req.body ?? {}) as { scenario?: unknown; fixture?: unknown; fixtures?: unknown; label?: unknown; ttlMs?: unknown; delayMs?: unknown };
  const known = [...SCENARIO_NAMES.filter((n) => !GLOBAL_ONLY.has(n)), ...Object.keys(DATA_STATES)];
  const named: Record<string, ScopeScenario> = {};
  let base: ScopeScenario = DEFAULT_SCENARIO;

  if (body.fixture !== undefined || body.fixtures !== undefined) {
    if (body.fixture !== undefined && body.fixtures !== undefined) {
      res.status(400).json({ error: 'pass fixture or fixtures, not both' }); return;
    }
    if (body.fixture !== undefined) {
      if (typeof body.fixture !== 'string') { res.status(400).json({ error: 'fixture must be a string key' }); return; }
      if (!isScopeScenario(body.scenario)) { res.status(400).json({ error: 'unknown scenario', got: body.scenario ?? null, known }); return; }
      named[body.fixture] = body.scenario;
    } else {
      if (!body.fixtures || typeof body.fixtures !== 'object' || Array.isArray(body.fixtures)) {
        res.status(400).json({ error: 'fixtures must be an object of { fixtureKey: scenario }' }); return;
      }
      for (const [key, value] of Object.entries(body.fixtures as Record<string, unknown>)) {
        if (!isScopeScenario(value)) { res.status(400).json({ error: 'unknown scenario', fixture: key, got: value ?? null, known }); return; }
        named[key] = value;
      }
      if (body.scenario !== undefined) {
        if (!isScopeScenario(body.scenario)) { res.status(400).json({ error: 'unknown scenario', got: body.scenario, known }); return; }
        base = body.scenario;
      }
    }
    const registry = resolveRegistry();
    for (const [key, scenario] of Object.entries(named)) {
      const fixture = findFixture(registry, key, res);
      if (!fixture) return;
      // Generic empty/error and the data states apply to any named fixture;
      // `large`/`fresh` mean nothing a registry can derive, so they must be declared.
      if (isScenarioName(scenario) && scenario !== 'empty' && scenario !== 'error' && !declaredScenariosFor(fixture).has(scenario)) {
        res.status(409).json({ error: 'fixture does not implement this scenario', fixture: key, requested: scenario,
          declares: SCENARIO_NAMES.filter((n) => declaredScenariosFor(fixture).has(n)) });
        return;
      }
    }
  } else {
    if (!isScopeScenario(body.scenario)) { res.status(400).json({ error: 'unknown scenario', got: body.scenario ?? null, known }); return; }
    base = body.scenario;
  }

  let scope: MockScope;
  try {
    scope = createMockScope({
      base, fixtures: named,
      label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null,
      ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
      ...(typeof body.delayMs === 'number' ? { delayMs: body.delayMs } : {}),
    });
  } catch (err) {
    if (err instanceof ScopeLimitError) { res.status(429).json({ error: err.message }); return; }
    throw err;
  }
  res.cookie(MOCK_SCOPE_COOKIE, scope.id, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: scope.expiresAt - scope.createdAt });
  res.status(201).json({
    scope: describeMockScope(scope),
    cookie: { name: MOCK_SCOPE_COOKIE, value: scope.id },
    header: MOCK_SCOPE_HEADER,
  });
});

mockControlRouter.get('/api/__mock/scope', ...gate, (_req, res) => {
  res.json({ scopes: listMockScopes().map(describeMockScope) });
});

mockControlRouter.get('/api/__mock/scope/:id', ...gate, (req, res) => {
  const scope = getMockScope(String(req.params['id']));
  if (!scope) { res.status(404).json({ error: 'unknown mock scope', scope: req.params['id'] }); return; }
  res.json({ scope: scopeReport(scope) });
});

mockControlRouter.delete('/api/__mock/scope/:id', ...gate, (req, res) => {
  const id = String(req.params['id']);
  const deleted = deleteMockScope(id);
  if (scopeIdOf(req) === id) res.clearCookie(MOCK_SCOPE_COOKIE, { path: '/' });
  if (!deleted) { res.status(404).json({ error: 'unknown mock scope', scope: id }); return; }
  res.json({ deleted: id });
});

// ── Identity clones ────────────────────────────────────────────────────────
//
// A test user minted from a seed persona: same grants, person link and name,
// its own id and session epoch (providers/identity.ts `cloneIdentity`). Sign
// in as it with the ordinary picker login, `POST /api/session/login {userId}`.

mockControlRouter.post('/api/__mock/identity/clone', ...gate, (req, res) => {
  const body = (req.body ?? {}) as { from?: unknown; label?: unknown; ttlMs?: unknown };
  if (typeof body.from !== 'string' || !body.from) { res.status(400).json({ error: 'from (a seed user id) is required' }); return; }
  try {
    const clone = cloneIdentity(body.from, {
      label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : null,
      ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
    });
    res.status(201).json({ clone });
  } catch (err) {
    if (err instanceof CloneRefused) { res.status(err.status).json({ error: err.message, from: body.from }); return; }
    throw err;
  }
});

mockControlRouter.get('/api/__mock/identity/clones', ...gate, (_req, res) => {
  res.json({ clones: listIdentityClones() });
});

mockControlRouter.delete('/api/__mock/identity/clone/:id', ...gate, (req, res) => {
  const id = String(req.params['id']);
  if (!deleteIdentityClone(id)) { res.status(404).json({ error: 'unknown clone', id }); return; }
  res.json({ deleted: id });
});

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
  clearMockScopes();
  identityClonesFixture.reset();
  resetDemoDirector();
  resetDistillationDemo();
}
