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
// with a live task and a context gauge, `idle` after a finished one, and
// `waiting` (the human-input heuristic). `stopped` is deliberately absent —
// `loadFleet` filters `status <> 'stopped'` and prunes them, so a stopped row
// here would be seeding a state the real loader guarantees never arrives.
//
// Every timestamp comes from `clock`, so a frozen clock in a test makes these
// deterministic and an unfrozen one keeps "12 minutes ago" true whenever the
// demo runs.

import { clock, defineFixture } from './core/index.js';
import type { FleetBox } from '../lib/devbox-fleet.js';

/** Claude's nominal window, mirrored from devbox-fleet.ts's own constant so
 *  the `contextUsed` fractions below are derived rather than eyeballed. */
const NOMINAL_CONTEXT_WINDOW = 200_000;

/** `contextUsed` as the fleet computes it: peak prompt / nominal window. */
function contextFraction(peakPromptTokens: number): number {
  return Math.min(1, peakPromptTokens / NOMINAL_CONTEXT_WINDOW);
}

function seedBoxes(): FleetBox[] {
  return [
    // SHARED, and busy — an SME's computer charged to an initiative they
    // contribute to, mid-task. This is the row the lab opens a pane onto.
    {
      id: 'box-mock-0001',
      label: 'auth-migration-1',
      sessionId: 'sess-mock-auth-migration-0001-0000-0000-000000000001',
      createdAt: clock.hoursAgo(5),
      status: 'running',
      lastActivityAt: clock.hoursAgo(0.05),
      ownerId: 'u-nora',
      projectId: 'p-auth-migration',
      currentTask: 'Migrate the remaining session callbacks off the legacy cookie helper and update their tests',
      spendUsd: 2.41,
      tokensUsed: 486_300,
      contextUsed: contextFraction(78_400),
      activeModel: 'claude-sonnet-5',
    },
    // SHARED, finished — same initiative, a second computer that has gone
    // idle. Two boxes on one project is what makes the lab's grouping rail
    // show a group rather than a list of singletons.
    {
      id: 'box-mock-0002',
      label: 'auth-migration-2',
      sessionId: 'sess-mock-auth-migration-0002-0000-0000-000000000002',
      createdAt: clock.hoursAgo(9),
      status: 'idle',
      lastActivityAt: clock.hoursAgo(1.4),
      ownerId: 'u-eli',
      projectId: 'p-auth-migration',
      currentTask: 'Backfill the integration tests for the token refresh path',
      lastResult: { subtype: 'success', turns: 14, durationMs: 512_000, costUsd: 1.86 },
      spendUsd: 1.86,
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
      createdAt: clock.hoursAgo(2.5),
      status: 'waiting',
      lastActivityAt: clock.hoursAgo(0.3),
      ownerId: 'u-layla',
      projectId: 'p-observability',
      currentTask: 'Add the span projector dashboard panel — which of the two metric namespaces should it read?',
      spendUsd: 0.74,
      tokensUsed: 142_500,
      contextUsed: contextFraction(31_200),
      activeModel: 'claude-sonnet-5',
    },
    // PERSONAL — an owner and no project, so it is visible to its owner and
    // to org-wide roles and to nobody else. Without one of these the
    // personal branch of canSeeBox is never taken offline.
    {
      id: 'box-mock-0004',
      label: 'rachel-scratch',
      sessionId: 'sess-mock-rachel-scratch-0004-0000-0000-000000000004',
      createdAt: clock.hoursAgo(26),
      status: 'idle',
      lastActivityAt: clock.hoursAgo(20),
      ownerId: 'u-rachel',
      currentTask: 'Check whether the guardrail rule change actually fires on the salary prompt',
      lastResult: { subtype: 'success', turns: 6, durationMs: 141_000, costUsd: 0.38 },
      spendUsd: 0.38,
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
      createdAt: clock.hoursAgo(14),
      status: 'idle',
      lastActivityAt: clock.hoursAgo(3.2),
      currentTask: 'Nightly dependency audit for the platform repos',
      lastResult: { subtype: 'success', turns: 3, durationMs: 88_000, costUsd: 0.12 },
      spendUsd: 0.12,
      tokensUsed: 28_400,
      contextUsed: contextFraction(9_100),
      activeModel: 'claude-haiku-4-5',
    },
  ];
}

/**
 * The offline fleet.
 *
 * `empty` is a real state and worth asking for by name: a brand-new account
 * before anyone has provisioned anything, which is the ONE case where "No
 * computers to lab · Provision at least one computer" is the honest screen.
 */
export const devboxBoxes = defineFixture<FleetBox>({
  key: 'devbox-boxes',
  scenarios: {
    default: seedBoxes,
    empty: () => [],
  },
});
