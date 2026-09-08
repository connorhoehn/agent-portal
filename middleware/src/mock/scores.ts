// The expertise leaderboard (providers/aurora.ts's mock score reads).
//
// Two floor rules meet here.
//
// `composite` is DERIVED from the five sub-scores in the same row rather than
// typed beside them — it used to be typed as 0 and patched in by a trailing
// `.map`, which worked but left a literal in the source that reads as data and
// is not. Anyone editing an influence score now moves the composite with it.
//
// `trend` used to call `Math.random()` at module scope. That is two bugs at
// once: the sparkline changed on every process start, so no screenshot could
// be compared with another and no test could assert on it; and it was computed
// at import, which is the same class of mistake as an import-time timestamp.
// It is now a deterministic function of the person id, so p-023's sparkline is
// p-023's sparkline forever, and it is computed inside the rows factory.
//
// personId/name/department must agree with schema/seed.sql's `people` rows —
// this list previously carried a pre-seed cast, so a leaderboard entry for
// p-004 named someone /api/graph/people had never heard of.
// `mock/core/parity/invariants.ts` pins that agreement; it imports `mockScores`
// as an array, which is why the export below stays one.

import { defineFixture } from './core/index.js';
import { liveRows } from './live.js';

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

/** The five axes a composite is the mean of. */
type Axes = Pick<ScoreEntry, 'influence' | 'collaboration' | 'expertise' | 'velocity' | 'quality'>;

/** A person as the fixture stores them: identity plus the five axes. */
type ScoreSeed = Pick<ScoreEntry, 'personId' | 'name' | 'department'> & Axes;

function composite(axes: Axes): number {
  const mean =
    (axes.influence + axes.collaboration + axes.expertise + axes.velocity + axes.quality) / 5;
  return Math.round(mean * 100);
}

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

/** Seven days of composite history, rising toward the person's current score. */
function trend(seed: ScoreSeed): number[] {
  const next = seeded(seed.personId);
  const end = composite(seed);
  return Array.from({ length: 7 }, (_, day) =>
    Math.max(0, Math.min(100, Math.round(end - (6 - day) * 1.5 + (next() - 0.5) * 8))),
  );
}

const SEEDS: ScoreSeed[] = [
  { personId: 'p-023', name: 'Hiro Green', department: 'Data Platform', influence: 0.93, collaboration: 0.88, expertise: 0.96, velocity: 0.72, quality: 0.94 },
  { personId: 'p-010', name: 'Tara Chen', department: 'Platform Engineering', influence: 0.91, collaboration: 0.78, expertise: 0.72, velocity: 0.85, quality: 0.80 },
  { personId: 'p-001', name: 'Theo Chang', department: 'Platform Engineering', influence: 0.89, collaboration: 0.82, expertise: 0.91, velocity: 0.75, quality: 0.88 },
  { personId: 'p-020', name: 'Henry Hassan', department: 'Data Platform', influence: 0.88, collaboration: 0.85, expertise: 0.76, velocity: 0.72, quality: 0.90 },
  { personId: 'p-011', name: 'Eli Garcia', department: 'Platform Engineering', influence: 0.85, collaboration: 0.90, expertise: 0.88, velocity: 0.70, quality: 0.92 },
  { personId: 'p-005', name: 'Sienna Garcia', department: 'Platform Engineering', influence: 0.82, collaboration: 0.88, expertise: 0.70, velocity: 0.80, quality: 0.75 },
  { personId: 'p-015', name: 'Raj Mehta', department: 'Data Platform', influence: 0.79, collaboration: 0.84, expertise: 0.73, velocity: 0.77, quality: 0.81 },
  { personId: 'p-006', name: 'Maria Johnson', department: 'Platform Engineering', influence: 0.76, collaboration: 0.80, expertise: 0.68, velocity: 0.82, quality: 0.74 },
  { personId: 'p-021', name: 'James Thompson', department: 'Data Platform', influence: 0.74, collaboration: 0.77, expertise: 0.82, velocity: 0.70, quality: 0.85 },
  { personId: 'p-002', name: 'Vera Green', department: 'Platform Engineering', influence: 0.72, collaboration: 0.75, expertise: 0.80, velocity: 0.78, quality: 0.82 },
  { personId: 'p-016', name: 'Tara Wright', department: 'Data Platform', influence: 0.71, collaboration: 0.82, expertise: 0.77, velocity: 0.68, quality: 0.86 },
  { personId: 'p-004', name: 'Nora DaSilva', department: 'Platform Engineering', influence: 0.68, collaboration: 0.72, expertise: 0.84, velocity: 0.73, quality: 0.79 },
];

/**
 * Scores.
 *
 * `empty` — nobody has been scored yet. The leaderboard, the cohort
 *           distribution and every person page's score panel have to say so
 *           rather than render an axis with no bars, which is the state a
 *           tenant is in until the scoring agent's first pass.
 */
export const scores = defineFixture<ScoreEntry>({
  key: 'scores',
  scenarios: {
    default: () =>
      SEEDS.map((seed) => ({ ...seed, composite: composite(seed), trend: trend(seed), scoredAt: null })),
    empty: () => [],
  },
});

/** Live view — see mock/live.ts. Consumers keep reading it as an array. */
export const mockScores: ScoreEntry[] = liveRows(scores);
