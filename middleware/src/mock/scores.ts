// The expertise leaderboard (providers/aurora.ts's mock score reads).
//
// WHERE THE NUMBERS COME FROM. Every row here is a projection of a
// `seededPeople` row in mock/people.ts, which is schema/seed.sql's `people`
// table. Nothing on this surface is typed.
//
// It used to be a hand-written `SEEDS` array of twelve people with five
// invented axes. The names and departments agreed with the seed, so it read as
// the seed's cast — and the numbers beside them were unrelated to
// `people.expertise_score` / `composite_score`. providers/aurora.ts served that
// array offline and the real columns online, so /iq/scores showed two different
// ORDERINGS of the same twelve people depending which mode you were in: the
// fixture ranked p-023 Hiro Green first, the seed ranks him 47th of 56. And it
// contradicted mock/people.ts inside one process — p-023 was `composite` 89 on
// the leaderboard and `influenceScore` 0.47 (= the seed's 46.98) on the graph.
//
// THE SCALE, ONCE, OUT LOUD. The seed stores all three score columns on 0–100.
// This wire carries:
//
//   composite                     0–100  — the seed's `composite_score`, as-is
//   influence                     0–1    — `pagerank_score` / 100
//   expertise                     0–1    — `expertise_score` / 100
//   collaboration/velocity/quality 0–1   — the neutral 0.5 placeholder
//
// `composite` stays 0–100 because everything downstream reads it that way:
// providers/aurora.ts's cohort histogram buckets on `< 20 / < 40 / < 60 / < 80`
// and reports `meanComposite`/`medianComposite`, and realGetLeaderboard sends
// the column unscaled. Rescaling it would silently move every bar on the cohort
// chart. The other four are fractions because that is what the leaderboard
// surface has always carried, what mock/core/parity/entities.ts's
// 'leaderboard people' row compares against (it normalizes the seed side by
// /100 to meet them), and what mock/people.ts's `influenceScore` uses — so
// `composite / 100` on this wire and `influenceScore` on the graph are the
// same number for the same person, which is the whole point.
// The portal's `formatScore` (portal/src/components/scores/scoresFormat.ts)
// renders a value in (0,1) as a percentage and one >= 1 as-is, so both halves
// display as the same 0–100 integer.
//
// The three axes Aurora has no column for — collaboration, velocity, quality —
// are a placeholder on both sides, not data: realGetLeaderboard writes the
// literal 50 into them (0–100), and this writes 0.5 (0–1). Same midpoint, each
// on its own surface's scale.
//
// `trend` used to call `Math.random()` at module scope. That is two bugs at
// once: the sparkline changed on every process start, so no screenshot could
// be compared with another and no test could assert on it; and it was computed
// at import, which is the same class of mistake as an import-time timestamp.
// It is now a deterministic function of the person id, so p-023's sparkline is
// p-023's sparkline forever, and it is computed inside the rows factory.
//
// `scoredAt` stays null offline. The seed writes `NOW()`, which is not a
// literal any fixture can copy, and the wire snapshot in
// mock/core/wire/snapshots/wire.json records this field as null for both the
// leaderboard and `/api/scores/:personId`.

import { defineFixture } from './core/index.js';
import { liveRows } from './live.js';
import { mockPeople, type Person } from './people.js';
import { asFraction, scoreColumnsFor } from './people-scores.js';

export interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  collaboration: number;
  expertise: number;
  velocity: number;
  quality: number;
  composite: number;
  trend: number[];
  scoredAt: string | null;
}

/**
 * The midpoint of an axis the seed has no column for. Aurora's own leaderboard
 * query writes the same neutral value (as 50, on its 0–100 axes) rather than
 * pretending to a measurement it does not have.
 */
const UNMEASURED_AXIS = 0.5;

/**
 * A stable pseudo-random stream seeded by a string. Same person, same
 * sparkline, every process — which is what makes a leaderboard screenshot
 * worth comparing to the one taken yesterday.
 */
function seeded(seed: string): () => number {
  let state = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Seven days of composite history, rising toward the person's current score.
 * Derived from the seeded composite, so a person whose seed row moves takes
 * their sparkline with them.
 */
function trend(personId: string, composite: number): number[] {
  const next = seeded(personId);
  return Array.from({ length: 7 }, (_, day) =>
    Math.max(0, Math.min(100, Math.round(composite - (6 - day) * 1.5 + (next() - 0.5) * 8))),
  );
}

/**
 * One person from mock/people.ts, as the score surface reads them. Identity
 * comes off the graph's own row and the numbers off that person's score
 * columns, so there is no third place for either to drift to.
 */
export function toScoreEntry(person: Person): ScoreEntry {
  const columns = scoreColumnsFor(person.id);
  return {
    personId: person.id,
    name: person.name,
    department: person.department,
    influence: asFraction(columns.pagerankScore),
    collaboration: UNMEASURED_AXIS,
    expertise: asFraction(columns.expertiseScore),
    velocity: UNMEASURED_AXIS,
    quality: UNMEASURED_AXIS,
    composite: columns.compositeScore,
    trend: trend(person.id, columns.compositeScore),
    scoredAt: null,
  };
}

/**
 * Scores.
 *
 * `default` — every one of the seed's 56 people, because that is what
 *           `SELECT ... FROM people ORDER BY composite_score DESC` returns
 *           online. The old twelve-person cast covered two of the six
 *           departments, so the cohort page offline was missing four of them.
 * `empty` — nobody has been scored yet. The leaderboard, the cohort
 *           distribution and every person page's score panel have to say so
 *           rather than render an axis with no bars, which is the state a
 *           tenant is in until the scoring agent's first pass.
 */
export const scores = defineFixture<ScoreEntry>({
  key: 'scores',
  scenarios: {
    default: () => mockPeople.map(toScoreEntry),
    empty: () => [],
  },
});

/** Live view — see mock/live.ts. Consumers keep reading it as an array. */
export const mockScores: ScoreEntry[] = liveRows(scores);
