// The microVM fleet, offline — the rows Computer Lab multiplexes.
//
// WHY THIS EXISTS. `providers/devbox-fleet-store.ts::loadFleet()` opens with
// `if (!usable()) return []`, and `usable()` is false whenever Aurora is
// mocked. So the fleet was empty BY CONSTRUCTION in the whole offline demo:
// `GET /api/devbox/boxes` answered `{"boxes":[]}` and Computer Lab — the
// flagship multiplexer, a whole nav item — rendered "No computers to lab.
// Provision at least one computer" in every demo anyone has ever given.
//
// That is contract.ts rule 5 exactly, and `mock/lab.ts`'s header already
// names it about its own surface: "THE STORE WAS EMPTY, so GET returned []
// and an unbuilt feature and an unseeded one looked identical." The lab is
// the more expensive version of the same bug, because its empty state is
// phrased as an instruction ("Provision at least one computer") — so the
// surface does not read as unfinished, it reads as *waiting for you*, and the
// obvious next move offline is to try provisioning one against a runtime that
// is not there.
//
// WHAT IS SEEDED, AND WHY THESE. The fleet's own visibility rule
// (lib/devbox-visibility.ts) recognises three shapes of computer, and a seed
// that only carries one of them exercises a third of the rule:
//
//   personal      ownerId, no projectId  → its owner, plus org-wide roles
//   shared        projectId              → everyone on that initiative
//   unattributed  neither                → org-wide roles only
//
// So there is at least one of each, and the ids are the seed's own — real
// `u-*` subs from providers/identity.ts and real `p-*` initiative ids from
// schema/seed_program.sql — never invented ones. A box charged to an
// initiative nobody is attached to would be invisible to every role and look
// like a bug in the filter rather than a seed that says nothing.
//
// The statuses cover what the lab actually renders differently: `running`
// with a live task and a context gauge, `idle` after a finished one,
// `waiting` (the human-input heuristic) and `provisioning` (minted, microVM
// not up yet). `stopped` is deliberately absent from the SEED — `loadFleet`
// filters `status <> 'stopped'` and prunes them, so a stopped row here would
// be seeding a state the real loader guarantees never arrives. Stopped boxes
// still reach the lab honestly offline: the reaper stops a box at its idle
// timeout or lifetime ceiling (mock/devbox-shell.ts answers its
// StopRuntimeSession), and `markStopped` keeps it listed until it is removed —
// exactly what a running process shows between a reap and the next boot.
//
// Every timestamp comes from `clock`, so a frozen clock in a test makes these
// deterministic and an unfrozen one keeps "12 minutes ago" true whenever the
// demo runs.

import { clock, defineFixture } from './core/index.js';
import { workItems } from './work-items.js';
import { bots } from './bots.js';
import type { FleetBox } from '../lib/devbox-fleet.js';

/** Claude's nominal window, mirrored from devbox-fleet.ts's own constant so
 *  the `contextUsed` fractions below are derived rather than eyeballed. */
const NOMINAL_CONTEXT_WINDOW = 200_000;

/** `contextUsed` as the fleet computes it: peak prompt / nominal window. */
function contextFraction(peakPromptTokens: number): number {
  return Math.min(1, peakPromptTokens / NOMINAL_CONTEXT_WINDOW);
}

/** Minutes before now — the unit the reaper's meters are read in. */
const minutesAgo = (m: number): string => clock.hoursAgo(m / 60);

/**
 * The seeded work item a computer is working, by id. Read off the board
 * fixture (mock/work-items.ts, ids from schema/seed_program.sql) so the task
 * line a computer shows is the item's own title, never a second copy of it.
 */
function task(workItemId: string): string {
  const item = workItems.rows('default').find((w) => w.id === workItemId);
  if (!item) throw new Error(`devbox seed names a work item the board does not have: ${workItemId}`);
  return item.title;
}

/** A seeded bot's standing mission, by name — the job a fleet box runs for it. */
function botMission(name: string): string {
  const bot = bots.rows('default').find((b) => b.name === name);
  if (!bot) throw new Error(`devbox seed names a bot the roster does not have: ${name}`);
  return bot.prompt;
}

// AGES ARE THE REAPER'S, NOT A STORY'S. `GET /api/devbox/boxes` hangs each box's
// meters off lib/devbox-reaper.ts `timeLeft`: a running box stops at the
// 60-minute lifetime ceiling, anything else at the sooner of that and the
// 20-minute idle timeout. A seed that said a box was five hours old therefore
// rendered every meter at zero — and was a box the reaper would already have
// stopped. Every age below sits inside those windows and they differ, so the
// lab's meters read as a spread (one nearly out, one fresh) rather than a row
// of identical bars.

// SPEND IS NOT STORED HERE (DE-31). A box's dollars are a ledger read
// (providers/spend-ledger.ts getBoxSpend over `spend_entries` rows carrying
// its `boxId`), so the seeded spend lives as entries in mock/spend-ledger.ts
// and `spendUsd` on the wire is that selector. A task that settles offline
// moves the chip; POST /api/__mock/reset restores it.

function seedBoxes(): FleetBox[] {
  return [
    // SHARED, and busy — an SME's computer charged to an initiative she
    // contributes to, mid-task. This is the row the lab opens a pane onto, and
    // the one Nora (sme on Auth Migration) must be able to see.
    {
      id: 'box-mock-0001',
      label: 'auth-migration-1',
      sessionId: 'sess-mock-auth-migration-0001-0000-0000-000000000001',
      createdAt: minutesAgo(41),
      status: 'running',
      lastActivityAt: minutesAgo(0.4),
      ownerId: 'u-nora',
      projectId: 'p-auth-migration',
      currentTask: task('wi-auth-e1-b4'),
      tokensUsed: 486_300,
      contextUsed: contextFraction(78_400),
      activeModel: 'claude-sonnet-5',
    },
    // SHARED, finished — the initiative owner's computer, idle after the run
    // that put its story into review. Two boxes on one project is what makes
    // the lab's grouping rail show a group rather than a list of singletons.
    {
      id: 'box-mock-0002',
      label: 'auth-migration-2',
      sessionId: 'sess-mock-auth-migration-0002-0000-0000-000000000002',
      createdAt: minutesAgo(52),
      status: 'idle',
      lastActivityAt: minutesAgo(9),
      ownerId: 'u-vera',
      projectId: 'p-auth-migration',
      currentTask: task('wi-auth-e1-s3'),
      lastResult: { subtype: 'success', turns: 14, durationMs: 512_000, costUsd: 1.86 },
      tokensUsed: 321_900,
      contextUsed: contextFraction(54_100),
      activeModel: 'claude-sonnet-5',
    },
    // SHARED on a different initiative, and WAITING — the state the lab
    // surfaces as needing a person. A fleet where nothing ever waits never
    // exercises that affordance.
    {
      id: 'box-mock-0003',
      label: 'observability-1',
      sessionId: 'sess-mock-observability-0003-0000-0000-000000000003',
      createdAt: minutesAgo(26),
      status: 'waiting',
      lastActivityAt: minutesAgo(4),
      ownerId: 'u-layla',
      projectId: 'p-observability',
      currentTask: task('wi-obs-e1-s3'),
      tokensUsed: 142_500,
      contextUsed: contextFraction(31_200),
      activeModel: 'claude-sonnet-5',
    },
    // PERSONAL — an owner and no project, so it is visible to its owner and
    // to org-wide roles and to nobody else. Without one of these the
    // personal branch of canSeeBox is never taken offline. Idle long enough
    // that its idle meter is the one nearly out.
    {
      id: 'box-mock-0004',
      label: 'rachel-scratch',
      sessionId: 'sess-mock-rachel-scratch-0004-0000-0000-000000000004',
      createdAt: minutesAgo(33),
      status: 'idle',
      lastActivityAt: minutesAgo(17),
      ownerId: 'u-rachel',
      currentTask: 'Check whether the guardrail rule change actually fires on the salary prompt',
      lastResult: { subtype: 'success', turns: 6, durationMs: 141_000, costUsd: 0.38 },
      tokensUsed: 64_800,
      contextUsed: contextFraction(18_900),
      activeModel: 'claude-haiku-4-5',
    },
    // UNATTRIBUTED — neither owner nor project, the shape the fleet makes for
    // itself (job-dispatcher and bot-runner boxes). Org-wide roles only, and
    // the conservative case devbox-visibility.ts is deliberate about.
    {
      id: 'box-mock-0005',
      label: 'fleet-dispatch-7',
      sessionId: 'sess-mock-fleet-dispatch-0005-0000-0000-000000000005',
      createdAt: minutesAgo(19),
      status: 'idle',
      lastActivityAt: minutesAgo(6),
      currentTask: botMission('auth-dep-watch'),
      lastResult: { subtype: 'success', turns: 3, durationMs: 88_000, costUsd: 0.12 },
      tokensUsed: 28_400,
      contextUsed: contextFraction(9_100),
      activeModel: 'claude-haiku-4-5',
    },
    // SHARED, running, on the busiest initiative — the collector bug its
    // second SME is on. Young, so its lifetime meter is nearly full.
    {
      id: 'box-mock-0006',
      label: 'observability-2',
      sessionId: 'sess-mock-observability-0006-0000-0000-000000000006',
      createdAt: minutesAgo(12),
      status: 'running',
      lastActivityAt: minutesAgo(0.2),
      ownerId: 'u-eli',
      projectId: 'p-observability',
      currentTask: task('wi-obs-e1-b5'),
      tokensUsed: 97_600,
      contextUsed: contextFraction(41_800),
      activeModel: 'claude-sonnet-5',
    },
    // SHARED, running, a third initiative — so the rail groups three ways.
    {
      id: 'box-mock-0007',
      label: 'llm-platform-1',
      sessionId: 'sess-mock-llm-platform-0007-0000-0000-000000000007',
      createdAt: minutesAgo(23),
      status: 'running',
      lastActivityAt: minutesAgo(0.7),
      ownerId: 'u-caleb',
      projectId: 'p-llm-platform',
      currentTask: task('wi-llm-e1-s2'),
      tokensUsed: 214_700,
      contextUsed: contextFraction(112_300),
      activeModel: 'claude-sonnet-5',
    },
    // PROVISIONING — minted a moment ago, microVM not up yet, so no task has
    // started on it (the real path sets `currentTask` from the first
    // `task_started`, which is also what moves it to running). The tail ticker
    // (mock/devbox-tail.ts) brings it up shortly after boot.
    {
      id: 'box-mock-0008',
      label: 'cost-opt-1',
      sessionId: 'sess-mock-cost-opt-0008-0000-0000-000000000000008',
      createdAt: minutesAgo(0.3),
      status: 'provisioning',
      lastActivityAt: minutesAgo(0.3),
      ownerId: 'u-layla',
      projectId: 'p-cost-opt',
    },
  ];
}

/** The work item a seeded box's first task picks up — the ticker reads it. */
export const PROVISIONING_TASKS: Readonly<Record<string, string>> = {
  'box-mock-0008': 'wi-cost-e1-s2',
};

/** The task a provisioning seed box starts once it is up — the item's title. */
export function provisioningTaskFor(boxId: string): string | null {
  const id = PROVISIONING_TASKS[boxId];
  return id ? task(id) : null;
}

/**
 * The `demo` world's fleet: the default fleet with Auth Migration's computers
 * taken off the stage, so the three demo agents (mock/demo-director.ts) are
 * the only computers on that initiative and come up as auth-migration-1..3.
 */
function demoBoxes(): FleetBox[] {
  return seedBoxes().filter((b) => b.projectId !== 'p-auth-migration');
}

/**
 * The offline fleet.
 *
 * `empty` is a real state and worth asking for by name: a brand-new account
 * before anyone has provisioned anything, which is the ONE case where "No
 * computers to lab · Provision at least one computer" is the honest screen.
 */
export function seededFleet(): FleetBox[] {
  return seedBoxes();
}

export const devboxBoxes = defineFixture<FleetBox>({
  key: 'devbox-boxes',
  scenarios: {
    default: seedBoxes,
    empty: () => [],
    demo: demoBoxes,
    // NO `error` scenario, deliberately, and this is the interesting part.
    //
    // These rows are not read through on every request: they hydrate the
    // in-memory Map in lib/devbox-fleet.ts once, and `/api/devbox/boxes`
    // answers from that Map. So a throwing fixture cannot reach the route.
    // Measured 2026-09-18 with a branch temporarily added here:
    // `rehydrateMockFleet` cleared the Map, the rows() call threw, and
    // `/api/devbox/boxes` answered **200 with 0 boxes** — an empty fleet, not
    // a failure. Worse, the throw surfaced inside the scenario plane's own
    // POST handler, so pinning it answered 500 (fixed separately: the plane
    // now guards its rehydrate step).
    //
    // Declaring `error` here would therefore promise a world this fixture
    // cannot serve — exactly the defect the plane was fixed to stop on
    // 2026-09-18, where every fixture advertised all five scenarios and
    // silently resolved to `default`. A surface whose failure mode is
    // genuinely "empty" should say so; making the devbox fleet report an
    // unreadable store as unreadable is a read-through change in
    // providers/devbox-fleet-store.ts, not a fixture branch.
  },
});
