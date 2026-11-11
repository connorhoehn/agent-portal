// Monthly allocations and sprint envelopes, offline — `initiative_budgets` and
// `budget_grants`.
//
// Both were module-level arrays in providers/budgets.ts (`MOCK_BUDGETS`,
// `MOCK_GRANTS`), with a hand-rolled overlay in providers/grantOverlay.ts
// standing in for the mutability the arrays could not have: a create wrote into
// a side Map, a revoke wrote a tombstone, and reads merged the two. That overlay
// existed for one reason — there was no way to put the seed back, so the seed
// could not be allowed to change. A registered fixture IS that way, so the rows
// below are mutated directly and `POST /api/__mock/reset` restores them.
//
// WHAT IS STORED HERE AND WHAT IS NOT. Only columns. An allocation is a real
// stored value (`initiative_budgets.allocated_usd`), so it is a field; a grant's
// burn is a correlated SUM over `bot_runs` in the sprint window, so it is NOT —
// providers/budgets.ts attaches it as a getter at projection time. Neither are a
// grant's dates: a `budget_grants` row in Aurora has no start or end of its own,
// it JOINs the sprint for them, so the fixture reads them from the sprint
// calendar (mock/sprints.ts) rather than restating them per grant.

import { defineFixture } from './core/index.js';
import { liveArrayView } from './live-view.js';
import type { MockBudget, MockGrantSeed } from '../providers/budgets.js';

// ─── Monthly allocations (initiative_budgets) ────────────────────────────────
//
// These figures used to be described as "plausible against the seed's volumes"
// rather than a mirror of it, and three of them had drifted a long way from
// schema/seed_program.sql: p-observability read 60 against the seed's 95,
// p-llm-platform 45 against 85, p-cost-opt 30 against 45. That is not a
// rounding difference — an allocation is the ceiling every headroom number, the
// maintenance-floor comparison and `decideAllocation`'s brake are judged
// against, so dev:mock was demonstrating a $60 envelope on an initiative Aurora
// gives $95. They are the seed's own numbers now. The remaining disagreement is
// deliberate and named on the row.

function seededAllocations(): MockBudget[] {
  return [
    { id: 'p-observability',     name: 'Observability Platform',   allocated: 100 },
    { id: 'p-llm-platform',      name: 'LLM Application Platform', allocated: 85 },
    // Covers Nora DaSilva's (p-004) envelope on spr-auth-s2 alongside p-051's —
    // sme.md defect #1.
    // Vera Green (u-vera, org-leader) owns this initiative and set its
    // allocation herself, so hers is the name on it.
    { id: 'p-auth-migration',    name: 'Auth Migration',           allocated: 75, updatedBy: 'u-vera' },
    // DELIBERATE DIVERGENCE (learning loop, lane B): the Budgets page's "near
    // cap" example. schema/seed_program.sql allocates $50 a month; offline this
    // initiative is budgeted per SPRINT, tightly, at $2.20 against the $1.79 its
    // bots spent in Sprint 10 so far (81 %, the 80 % mark). A sprint window is
    // relative to now in the mock (mock/sprints.ts), so the figure holds every
    // day; a monthly one drifts with the day of the month, because the mock's
    // run history is relative to now and the month start is not. Its 50 and 80
    // % bells reach its owner (Layla Hassan) on the reaper's first sweep.
    // Declared as knownDrift on the parity entity.
    { id: 'p-cost-opt',          name: 'Cost Optimization',        allocated: 2.2, period: 'sprint' },
    // p-soc2 / p-feature-store / p-mobile-redesign used to derive $0: they hold
    // an allocation, but the mock fleet mirrored only 5 of the seed's 12 bots, so
    // there were no rows to sum. Honest, and useless — an allocation judged
    // against an empty maintenance floor tells a reader nothing. All twelve
    // seeded bots and their run histories are in mock/bots.ts now, so these
    // three derive the seed's own numbers.
    { id: 'p-soc2',              name: 'SOC2 Compliance',          allocated: 25 },
    { id: 'p-feature-store',     name: 'ML Feature Store',         allocated: 25 },
    // DELIBERATE DIVERGENCE. schema/seed_program.sql allocates $20/month here;
    // this row carries null so that an initiative SPENDING WITH NO ALLOCATION —
    // the program-manager's blind spot, and the whole reason the ledger unions
    // "has an allocation" with "has spend this period" — is demonstrable
    // offline. inference-canary-nightly is in the mock fleet, so the row has
    // real derived spend behind the signal. Declared as knownDrift on the
    // parity entity too; if this ever becomes a plain mirror, that entry and
    // this comment both go.
    { id: 'p-inference-platform', name: 'Inference Platform',      allocated: null },
    // Mia Singh's (p-030, program-owner) own initiative — program-owner.md
    // defect #1. Every dollar here is cron maintenance (the bot is parked
    // awaiting repo provisioning), so it is the floor, not feature spend. Mia
    // set this allocation herself (program-owner holds ManageBudgets).
    { id: 'p-mobile-redesign',   name: 'Mobile App Redesign',      allocated: 25, updatedBy: 'u-mia' },
    // The four initiatives that came with the rest of the seed's bot fleet.
    // They are here because they now derive spend, and a ledger that shows an
    // initiative's money must show the allocation that money is judged against:
    // Aurora's `ids` CTE is the UNION of "has an allocation" and "has spend this
    // period", so an initiative spending here and missing from this list would
    // appear on the real ledger and not the mock one.
    { id: 'p-realtime-analytics', name: 'Real-time Analytics Pipeline', allocated: 30 },
    { id: 'p-design-v3',         name: 'Design System v3',         allocated: 30 },
    { id: 'p-design-system-api', name: 'Design System API',        allocated: 30 },
    // A COMPLETED initiative that still costs ~$0.10/run to keep indexed — the
    // clearest case docs/program-operating-model.md makes: maintenance is the
    // floor of owning something, not of building it.
    { id: 'p-rag-search',        name: 'RAG Knowledge Search',     allocated: 5 },
    // The last two the mock omitted, and the omission was a defect the parity
    // harness had already written up by id and by dollar
    // (mock/core/parity/entities.ts). Neither has a maintenance bot, which is
    // why they were skipped — but Aurora's ledger query unions "has an
    // allocation" with "has spend this period", so a cluster carrying
    // schema/seed_program.sql returns all fourteen rows while /admin/budgets
    // read "no allocation" offline for two initiatives that have one. An
    // allocation with no floor to read it against is still an allocation the
    // ledger must show; both derive $0 spend against a real ceiling, which is
    // exactly what the real query returns for them. p-zero-trust is the sharper
    // case: the mock sprint calendar carries spr-zt-s1, so it was an initiative
    // with a live sprint on /iq/sprints and no row on the ledger at all.
    { id: 'p-zero-trust',        name: 'Zero Trust Network',       allocated: 20 },
    { id: 'p-data-lake',         name: 'Data Lake Migration',      allocated: 15 },
  ];
}

/**
 * Per-initiative monthly allocations.
 *
 * `default` — schema/seed_program.sql's `initiative_budgets`, all fourteen, with
 *             p-inference-platform's held at null on purpose (see the row).
 * `empty`   — nothing allocated anywhere: every initiative is spending blind,
 *             which is the state the ledger's own empty copy is written for.
 */
export const initiativeBudgets = defineFixture<MockBudget>({
  key: 'initiative-budgets',
  scenarios: {
    default: () => seededAllocations(),
    empty: () => [],
    // Allocations are money. "Nothing allocated" and "we could not read the
    // allocations" must never render the same, because the first invites
    // spending and the second means you do not know what is left.
    error: () => { throw new Error('initiative_budgets unavailable: relation does not exist'); },
  },
});

// ─── Sprint envelopes (budget_grants) ────────────────────────────────────────

// Who granted each initiative's envelopes — schema/seeds/generate_program_seed.py's
// GRANTED_BY: the owner where the owner holds ManageBudgets (Vera on Auth, Mia on
// Mobile), the release manager on Observability and Cost Optimization (their
// owners hold the sme role, which cannot grant), the program operator elsewhere.
const GRANTED_BY: Record<string, string> = {
  'p-observability': 'u-release', 'p-auth-migration': 'u-vera', 'p-cost-opt': 'u-release', 'p-mobile-redesign': 'u-mia',
};

function seededGrants(): MockGrantSeed[] {
  const grant = (
    id: string, orgProjectId: string, granteePersonId: string, granteeName: string,
    sprintId: string, sprintName: string, sprintStatus: 'active' | 'done', allocatedUsd: number,
  ): MockGrantSeed => ({
    id, orgProjectId, granteePersonId, granteeName, sprintId, sprintName, sprintStatus, allocatedUsd,
    grantedBy: GRANTED_BY[orgProjectId] ?? 'u-rachel',
  });
  return [
    grant('bg-obs-1', 'p-observability', 'p-008', 'Layla Hassan', 'spr-obs-s1', 'Sprint 9 — Ingest hardening', 'done', 25),
    grant('bg-obs-2', 'p-observability', 'p-011', 'Eli Garcia', 'spr-obs-s2', 'Sprint 10 — Burn-rate alerts', 'done', 20),
    grant('bg-obs-3', 'p-observability', 'p-008', 'Layla Hassan', 'spr-obs-s3', 'Sprint 11 — Span metrics + decom', 'active', 35),
    grant('bg-llm-1', 'p-llm-platform', 'p-042', 'Katya Petrov', 'spr-llm-s1', 'Sprint 8 — Prompt registry', 'done', 30),
    grant('bg-llm-2', 'p-llm-platform', 'p-013', 'Caleb Turner', 'spr-llm-s2', 'Sprint 9 — Judge + evals', 'active', 35),
    grant('bg-auth-1', 'p-auth-migration', 'p-051', 'Simone Chang', 'spr-auth-s1', 'Sprint 9 — OIDC core', 'done', 25),
    grant('bg-auth-2', 'p-auth-migration', 'p-051', 'Simone Chang', 'spr-auth-s2', 'Sprint 10 — Session hygiene', 'active', 20),
    // The seeded sme login (u-nora / p-004) is an SME on Auth Migration and
    // holds her own envelope on the same active sprint as p-051's, so the sme
    // persona can exercise the role's core loop in dev:mock — sme.md defect #1.
    // Two grantees on one sprint is allowed (budget_grants has no such
    // uniqueness constraint) and mirrors bg-auth-3 in the seed exactly.
    grant('bg-auth-3', 'p-auth-migration', 'p-004', 'Nora DaSilva', 'spr-auth-s2', 'Sprint 10 — Session hygiene', 'active', 15),
    grant('bg-cost-1', 'p-cost-opt', 'p-011', 'Eli Garcia', 'spr-cost-s1', 'Sprint 9 — Floors and orphans', 'done', 15),
    grant('bg-cost-2', 'p-cost-opt', 'p-017', 'Daniel Novak', 'spr-cost-s2', 'Sprint 10 — Attribution', 'active', 25),
    grant('bg-rta-1', 'p-realtime-analytics', 'p-019', 'Camille Dubois', 'spr-rta-s1', 'Sprint 9 — Checkpoint + schema', 'active', 22),
    grant('bg-lake-1', 'p-data-lake', 'p-017', 'Daniel Novak', 'spr-lake-s1', 'Sprint 6 — Format decision', 'active', 10),
    grant('bg-fs-1', 'p-feature-store', 'p-019', 'Camille Dubois', 'spr-fs-s1', 'Sprint 8 — Freshness', 'active', 18),
    // bg-mob-1 — the sprint envelope on Mia Singh's own initiative.
    grant('bg-mob-1', 'p-mobile-redesign', 'p-035', 'Ben Okafor', 'spr-mob-s1', 'Sprint 9 — Routing', 'active', 15),
    grant('bg-ds-1', 'p-design-v3', 'p-038', 'Isabel Vasquez', 'spr-ds-s1', 'Sprint 8 — Token sync', 'active', 20),
    grant('bg-soc2-1', 'p-soc2', 'p-055', 'Joy Chen', 'spr-soc2-s1', 'Sprint 9 — Collectors', 'active', 18),
    grant('bg-dsapi-1', 'p-design-system-api', 'p-035', 'Ben Okafor', 'spr-dsapi-s1', 'Sprint 7 — Contracts', 'active', 20),
    // Deliberately over: the sprint's planned work ($16.34) is more than this
    // envelope, on the initiative that is also spending with no allocation.
    grant('bg-inf-1', 'p-inference-platform', 'p-013', 'Caleb Turner', 'spr-inf-s1', 'Sprint 9 — Queue-depth scaling', 'active', 15),
    grant('bg-zt-1', 'p-zero-trust', 'p-052', 'Diego Ortiz', 'spr-zt-s1', 'Sprint 5 — Inventory', 'active', 12),
  ];
}

/**
 * SME sprint envelopes — the rows `decideEnvelope()` spends against.
 *
 * `default` — all nineteen of schema/seed_program.sql's envelopes; the mock
 *             sprint calendar carries every sprint they name.
 * `empty`   — sprints exist, nobody has been granted anything. Declared, because
 *             "your SME holds no envelope on this initiative" is a real state
 *             `decideGrantScopedDispatch` 403s on and an audit should be able to
 *             see without revoking a seeded grant.
 */
export const budgetGrants = defineFixture<MockGrantSeed>({
  key: 'budget-grants',
  scenarios: {
    default: () => seededGrants(),
    empty: () => [],
    demo: () => demoGrants(),
  },
});

/**
 * The Computer Lab demo's envelopes (mock/demo-director.ts): the seed's, with
 * Nora DaSilva's sprint-42 envelope on Auth Migration sized to the demo's
 * story. Her three agents' dispatches each fit it: each holds its $0.30 p75
 * while in flight (DE-34 spend holds), and three holds ($0.90) fit. Once two
 * of them have settled at their real figures, what they spent plus what the
 * third still holds leaves less than a fourth item's forecast, so the real
 * envelope brake in `POST /api/bots/dispatch-work` holds it. (Before holds
 * existed this was $0.70, sized on settled burn alone; with holds a $0.70
 * envelope refuses the THIRD agent, which is the race DE-34 closes.) The size
 * is the only thing changed — the gate, the forecast and the burn are all the
 * real ones.
 */
export const DEMO_ENVELOPE_USD = 0.95;
function demoGrants(): MockGrantSeed[] {
  return seededGrants().map((g) => (g.id === 'bg-auth-3' ? { ...g, allocatedUsd: DEMO_ENVELOPE_USD } : g));
}

/** The allocations, live — see mock/live-view.ts for why this is not an array. */
export const MOCK_BUDGETS: MockBudget[] = liveArrayView(() => initiativeBudgets.rows());
