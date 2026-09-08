// providers/sprintWindows.ts
//
// The mock sprint CALENDAR — `sprint id → [starts_on, ends_on)`, and nothing
// else. The table itself is now the registered `sprints` fixture (mock/sprints.ts);
// this module is the seam that keeps two providers off each other.
//
// WHY THE SEAM IS STILL HERE. Two readers need a sprint's dates and they cannot
// both own them:
//
//   sprints.ts  renders the sprint row itself (name, steward, rollups)
//   budgets.ts  windows a grant's burn on the sprint that funds it
//
// and sprints.ts already imports budgets.ts (`mockInitiativeWindowSpendUsd`,
// `spendPredicateSql`), so budgets.ts importing sprints.ts back would close a
// cycle. Same reasoning that carved out providers/grantOverlay.ts. This module
// imports the fixture and nothing else, so both can depend on it and neither
// depends on the other.
//
// WHY IT EXISTS AT ALL. `MOCK_GRANTS` in providers/budgets.ts used to carry
// `startsOn: null, endsOn: null` on every row. A null bound is *unbounded* in
// both the Aurora subquery and its mock analogue, so a grant's
// "initiativeSpendInWindowUsd" — the number a sprint envelope is judged against,
// and the number lib/bot-runner.ts's envelope brake burns down — was really the
// initiative's LIFETIME spend. The sprint page beside it already windowed the
// same money correctly, so one envelope reported two figures depending on which
// page you opened. The dates were never missing; they were on the sprint.
//
// Every date is derived from the clock (contract.ts bug #3), so a frozen test
// sees a frozen calendar and a process that boots near UTC midnight does not
// bake yesterday's window into a module constant. A sprint CREATED in-process
// is a row in the same fixture, so it has a window here too — it used to have
// none, which silently unbounded every envelope granted on it.

export type { MockSprint } from '../mock/sprints.js';
export { mockDateDaysAgo, mockSprint, mockSprintDates, sprints } from '../mock/sprints.js';

/** `starts_on`/`ends_on` are DATEs in the schema, so these are day strings. */
export interface MockSprintDates {
  startsOn: string;
  endsOn: string;
}
