// The sprint calendar, offline — `sprints`.
//
// This was two module-level arrays and a lookup table spread across two
// providers: `MOCK_SPRINTS` (the seeded cadence) and `MOCK_CREATED_SPRINTS`
// (every sprint this process created) in providers/sprints.ts, and
// `MOCK_SPRINT_WINDOWS` (the dates, keyed by sprint id) in
// providers/sprintWindows.ts. None of the three was a registered fixture, so:
//
//   1. NOTHING COULD PUT THEM BACK. `POST /api/__mock/reset` walks the fixture
//      registry, so a sprint created in dev:mock lived until the process was
//      restarted and a write-capture sweep had to refuse `POST /api/sprints`
//      outright. Behind a fixture, a create is undone by a reset.
//   2. THE WINDOW LIVED APART FROM THE SPRINT. A sprint's dates were in one
//      module and the sprint in another, keyed by id, because providers/
//      budgets.ts needs the window to bound a grant's burn and cannot import
//      providers/sprints.ts (that one imports budgets.ts — a cycle). One
//      fixture nobody's provider owns removes the reason for the split: both
//      read this module, and neither reads the other.
//   3. A SPRINT CREATED IN-PROCESS HAD NO WINDOW anywhere the grants side could
//      see. `mockSprintDates` looked only at the seeded table, so an envelope
//      granted on a freshly created sprint fell back to null bounds — and a
//      null bound is UNBOUNDED, which is how a sprint envelope came to be
//      judged against an initiative's lifetime spend. A created sprint is a row
//      in the same fixture now, so it carries its dates like any other.
//
// WHAT IS STORED AND WHAT IS NOT. Only columns. `starts_on`/`ends_on` are DATE
// columns, so they are fields — day strings, computed in the FACTORY from the
// seed's own `NOW() - INTERVAL 'N days'` offsets through mock/core/clock.ts, so
// a reset re-dates the calendar and a frozen test sees a frozen one. Everything
// a sprint page shows on top of that (item counts, points, the envelope, window
// spend) is a rollup over other tables and is derived by providers/sprints.ts
// at read time — never a number written beside these rows.

import { clock, DAY_MS, defineFixture } from './core/index.js';
import type { SprintStatus } from '../providers/sprints.js';

/**
 * A sprint row — the `sprints` columns, and nothing else.
 *
 * `orgProjectName` and `stewardName` are joins (projects, people) rather than
 * columns, but they are carried here for the seeded rows because the mock has
 * no people/projects join to resolve them through, and a fixture that invents
 * a name it cannot resolve is worse than one that mirrors the seed's. A sprint
 * created in-process leaves them null — honest, not fabricated.
 */
export interface MockSprint {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  name: string;
  goal: string | null;
  /** The SME accountable for the sprint; the envelope points at them. */
  stewardPersonId: string | null;
  stewardName: string | null;
  /** `starts_on`/`ends_on` are DATEs in the schema, so these are day strings. */
  startsOn: string | null;
  endsOn: string | null;
  status: SprintStatus;
}

/**
 * A day string `days` before now, in UTC — the fixture analogue of
 * `(NOW() - INTERVAL 'N days')::date`. NEGATIVE days run forward, deliberately:
 * a sprint's end can be in the future (spr-zt-s1 ends a week from now), which
 * is why this is not `clock.daysAgo` — that clamps a negative age to today.
 */
export function mockDateDaysAgo(days: number): string {
  return new Date(clock.now().getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The seeded cadence.
 *
 * Every row mirrors schema/seed_program.sql: the same ids, stewards, goals and
 * statuses, and the same `NOW() - INTERVAL 'N days'` window. Coverage is the
 * union the rest of mock mode already references — every sprint a
 * providers/work-items.ts row carries a `sprintId` for, plus every sprint
 * mock/budgets.ts hands an envelope to. Inventing a sprint beyond that union
 * would put a row on the Sprints page that the grants table and the work board
 * both deny exists; omitting one inside it is the same defect read the other
 * way (a work item whose sprint the page denies exists), which is why
 * spr-llm-s1 / spr-inf-s1 / spr-zt-s1 are here.
 */
function seededSprints(): MockSprint[] {
  const sprint = (
    id: string, orgProjectId: string, orgProjectName: string,
    name: string, goal: string,
    stewardPersonId: string, stewardName: string,
    status: SprintStatus, startDaysAgo: number, endDaysAgo: number,
  ): MockSprint => ({
    id, orgProjectId, orgProjectName, name, goal, stewardPersonId, stewardName, status,
    startsOn: mockDateDaysAgo(startDaysAgo),
    endsOn: mockDateDaysAgo(endDaysAgo),
  });

  return [
    sprint('spr-obs-s1', 'p-observability', 'Observability Platform',
      'Sprint 96 — Ingest hardening', 'Collector fleet stable at 2x peak ingest.',
      'p-008', 'Layla Hassan', 'done', 42, 28),
    sprint('spr-obs-s2', 'p-observability', 'Observability Platform',
      'Sprint 97 — Burn-rate alerts', 'Tier-1 services alert on error-budget burn, not raw error rate.',
      'p-011', 'Eli Garcia', 'done', 28, 14),
    sprint('spr-obs-s3', 'p-observability', 'Observability Platform',
      'Sprint 98 — Span metrics + decom', 'RED dashboards from span metrics; two services off StatsD.',
      'p-008', 'Layla Hassan', 'active', 14, 0),
    sprint('spr-auth-s2', 'p-auth-migration', 'Auth Migration',
      'Sprint 42 — Session hygiene', 'Sessions expire server-side; revoked grants bite within a minute.',
      'p-051', 'Nora Chang', 'active', 14, 0),
    sprint('spr-llm-s1', 'p-llm-platform', 'LLM Application Platform',
      'Sprint 7 — Prompt registry', 'Prompt edits reach the fleet without a redeploy.',
      'p-042', 'Vera Petrov', 'done', 30, 16),
    sprint('spr-llm-s2', 'p-llm-platform', 'LLM Application Platform',
      'Sprint 8 — Judge + evals', 'Canary judge scores every ask; golden sets gate merges.',
      'p-013', 'Caleb Turner', 'active', 14, 0),
    sprint('spr-inf-s1', 'p-inference-platform', 'Inference Platform',
      'Sprint 14 — Queue-depth scaling', 'Scaling reacts to demand, not to a proxy metric.',
      'p-013', 'Caleb Turner', 'active', 14, 0),
    // The one sprint whose window has not closed yet — `endDaysAgo: -7`. It is
    // here because an envelope on a still-open sprint is the state
    // decideEnvelope actually spends against, and a calendar in which every
    // window has already ended cannot demonstrate that.
    sprint('spr-zt-s1', 'p-zero-trust', 'Zero Trust Network',
      'Sprint 2 — Inventory', 'Every service maps to an identity or a documented exception.',
      'p-052', 'Hugo DaSilva', 'active', 7, -7),
    sprint('spr-cost-s2', 'p-cost-opt', 'Cost Optimization',
      'Sprint 24 — Attribution', 'Every running resource carries an initiative tag.',
      'p-017', 'Daniel Chang', 'active', 14, 0),
    // Mia Singh (p-030, u-mia, program-owner) owns Mobile App Redesign, and
    // schema/seed_program.sql gives that initiative a live sprint (steward
    // p-035/Ben Okafor), a $12 envelope (bg-mob-1) and a $15 monthly
    // allocation — the mock fixtures never mirrored it, so every "mine" view
    // read $0/empty for the one persona the operating model is built to demo.
    // program-owner.md defect #1.
    sprint('spr-mob-s1', 'p-mobile-redesign', 'Mobile App Redesign',
      'Sprint 31 — Routing', 'Every marketing link deep-links to a real screen.',
      'p-035', 'Ben Okafor', 'active', 14, 0),
  ];
}

/**
 * The sprint calendar.
 *
 * `default` — schema/seed_program.sql's cadence, dated against the clock.
 * `empty`   — an initiative that has not planned a sprint yet. Declared
 *             explicitly, because that is the state the Sprints page's own
 *             "no sprints" copy is written for, and an undeclared scenario
 *             falls back to `default`.
 *
 * `rows()` is the live array, so `createSprint` pushes here and a reset takes
 * the new sprint back out — which is what makes `POST /api/sprints` replayable
 * offline instead of a write nothing can undo.
 */
export const sprints = defineFixture<MockSprint>({
  key: 'sprints',
  scenarios: {
    default: () => seededSprints(),
    empty: () => [],
  },
});

/** One sprint by id, or null. */
export function mockSprint(sprintId: string | null | undefined): MockSprint | null {
  if (!sprintId) return null;
  return sprints.rows().find((s) => s.id === sprintId) ?? null;
}

/** `starts_on`/`ends_on` for one sprint — the window a grant's burn is bounded
 *  by. Null for a sprint this fixture does not carry, which is unbounded on
 *  both sides in the SQL and in the mock alike. */
export function mockSprintDates(
  sprintId: string | null | undefined,
): { startsOn: string; endsOn: string } | null {
  const s = mockSprint(sprintId);
  if (!s || s.startsOn == null || s.endsOn == null) return null;
  return { startsOn: s.startsOn, endsOn: s.endsOn };
}
