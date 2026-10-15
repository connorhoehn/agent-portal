// The three columns the scoring pass writes back onto `people`, keyed by id.
//
// WHY THEY ARE NOT IN mock/people.ts. Two reasons, and they point the same way.
//
// The first is the shape of the real system: `schema/orgiq_schema.sql`'s
// `people` row is written by two different things. The graph builder writes
// who someone is — name, title, team, and the `person_skills` edges beside it.
// The scoring agent writes `expertise_score`, `pagerank_score` and
// `composite_score` back onto the same row, later, and they are nullable until
// it has run. Keeping them apart offline lets the fixture say that: a person
// the scoring pass has not reached reads as zero, exactly the way
// `COALESCE(composite_score, 0)` reads in providers/aurora.ts.
//
// The second is that mock/people.ts's rows ARE the graph wire — the mock
// `/api/graph/entities` node is that object plus a presence string. Hanging
// three more numbers on it would ship them to a surface that has never
// carried them and would pair three seed columns with three mock keys that
// nobody compares (mock/core/parity/columns.ts fails on exactly that).
//
// EVERY NUMBER HERE IS schema/seed.sql'S, on the seed's own 0-100 scale. Read
// them through `scoreColumnsFor`, never by indexing this object directly, so
// an id the scoring pass has never seen answers with zeros rather than
// `undefined`.

export interface PersonScoreColumns {
  /** `people.expertise_score`, 0-100. */
  expertiseScore: number;
  /** `people.pagerank_score`, 0-100. */
  pagerankScore: number;
  /** `people.composite_score`, 0-100 — the seed's blend of the two above. */
  compositeScore: number;
}

const UNSCORED: PersonScoreColumns = { expertiseScore: 0, pagerankScore: 0, compositeScore: 0 };

export const personScoreColumns: Record<string, PersonScoreColumns> = {
  'p-001': { expertiseScore: 64.46, pagerankScore: 91.55, compositeScore: 79.36 },
  'p-002': { expertiseScore: 40.56, pagerankScore: 80.31, compositeScore: 62.42 },
  'p-003': { expertiseScore: 47.79, pagerankScore: 77.32, compositeScore: 64.03 },
  'p-004': { expertiseScore: 77.11, pagerankScore: 85.71, compositeScore: 81.84 },
  'p-005': { expertiseScore: 40.36, pagerankScore: 41.35, compositeScore: 40.9 },
  'p-006': { expertiseScore: 69.08, pagerankScore: 98.1, compositeScore: 85.04 },
  'p-007': { expertiseScore: 77.31, pagerankScore: 95.0, compositeScore: 87.04 },
  'p-008': { expertiseScore: 70.88, pagerankScore: 64.8, compositeScore: 67.54 },
  'p-009': { expertiseScore: 26.31, pagerankScore: 61.68, compositeScore: 45.76 },
  'p-010': { expertiseScore: 43.37, pagerankScore: 72.12, compositeScore: 59.18 },
  'p-011': { expertiseScore: 62.65, pagerankScore: 69.38, compositeScore: 66.35 },
  'p-012': { expertiseScore: 67.67, pagerankScore: 68.47, compositeScore: 68.11 },
  'p-013': { expertiseScore: 76.51, pagerankScore: 88.13, compositeScore: 82.9 },
  'p-014': { expertiseScore: 24.7, pagerankScore: 71.69, compositeScore: 50.54 },
  'p-015': { expertiseScore: 80.72, pagerankScore: 49.64, compositeScore: 63.63 },
  'p-016': { expertiseScore: 60.44, pagerankScore: 62.03, compositeScore: 61.31 },
  'p-017': { expertiseScore: 100.0, pagerankScore: 78.91, compositeScore: 88.4 },
  'p-018': { expertiseScore: 52.81, pagerankScore: 72.12, compositeScore: 63.43 },
  'p-019': { expertiseScore: 89.76, pagerankScore: 89.79, compositeScore: 89.78 },
  'p-020': { expertiseScore: 93.37, pagerankScore: 63.85, compositeScore: 77.13 },
  'p-021': { expertiseScore: 39.96, pagerankScore: 55.28, compositeScore: 48.39 },
  'p-022': { expertiseScore: 95.58, pagerankScore: 86.54, compositeScore: 90.61 },
  'p-023': { expertiseScore: 33.53, pagerankScore: 57.99, compositeScore: 46.98 },
  'p-024': { expertiseScore: 84.94, pagerankScore: 82.6, compositeScore: 83.65 },
  'p-025': { expertiseScore: 27.71, pagerankScore: 55.8, compositeScore: 43.16 },
  'p-026': { expertiseScore: 99.4, pagerankScore: 54.26, compositeScore: 74.57 },
  'p-027': { expertiseScore: 54.62, pagerankScore: 59.0, compositeScore: 57.03 },
  'p-028': { expertiseScore: 91.16, pagerankScore: 100.0, compositeScore: 96.02 },
  'p-029': { expertiseScore: 52.21, pagerankScore: 42.6, compositeScore: 46.92 },
  'p-030': { expertiseScore: 40.96, pagerankScore: 56.48, compositeScore: 49.5 },
  'p-031': { expertiseScore: 48.8, pagerankScore: 73.91, compositeScore: 62.61 },
  'p-032': { expertiseScore: 59.44, pagerankScore: 84.13, compositeScore: 73.02 },
  'p-033': { expertiseScore: 79.32, pagerankScore: 45.23, compositeScore: 60.57 },
  'p-034': { expertiseScore: 70.28, pagerankScore: 34.98, compositeScore: 50.87 },
  'p-035': { expertiseScore: 77.71, pagerankScore: 57.69, compositeScore: 66.7 },
  'p-036': { expertiseScore: 43.37, pagerankScore: 49.67, compositeScore: 46.84 },
  'p-037': { expertiseScore: 67.47, pagerankScore: 50.28, compositeScore: 58.02 },
  'p-038': { expertiseScore: 49.0, pagerankScore: 67.11, compositeScore: 58.96 },
  'p-039': { expertiseScore: 49.4, pagerankScore: 88.83, compositeScore: 71.09 },
  'p-040': { expertiseScore: 50.8, pagerankScore: 37.84, compositeScore: 43.67 },
  'p-041': { expertiseScore: 61.04, pagerankScore: 77.32, compositeScore: 69.99 },
  'p-042': { expertiseScore: 82.33, pagerankScore: 70.06, compositeScore: 75.58 },
  'p-043': { expertiseScore: 60.44, pagerankScore: 89.04, compositeScore: 76.17 },
  'p-044': { expertiseScore: 36.95, pagerankScore: 51.92, compositeScore: 45.18 },
  'p-045': { expertiseScore: 72.89, pagerankScore: 77.55, compositeScore: 75.45 },
  'p-046': { expertiseScore: 60.44, pagerankScore: 58.4, compositeScore: 59.32 },
  'p-047': { expertiseScore: 45.98, pagerankScore: 76.12, compositeScore: 62.56 },
  'p-048': { expertiseScore: 62.45, pagerankScore: 38.5, compositeScore: 49.28 },
  'p-049': { expertiseScore: 46.39, pagerankScore: 51.24, compositeScore: 49.06 },
  'p-050': { expertiseScore: 74.3, pagerankScore: 59.5, compositeScore: 66.16 },
  'p-051': { expertiseScore: 94.18, pagerankScore: 30.37, compositeScore: 59.08 },
  'p-052': { expertiseScore: 60.24, pagerankScore: 81.04, compositeScore: 71.68 },
  'p-053': { expertiseScore: 51.2, pagerankScore: 40.71, compositeScore: 45.43 },
  'p-054': { expertiseScore: 75.3, pagerankScore: 85.78, compositeScore: 81.06 },
  'p-055': { expertiseScore: 70.08, pagerankScore: 51.84, compositeScore: 60.05 },
  'p-056': { expertiseScore: 55.42, pagerankScore: 35.2, compositeScore: 44.3 },
  'p-priya': { expertiseScore: 71.4, pagerankScore: 58.2, compositeScore: 64.14 },
  'p-omar': { expertiseScore: 64.2, pagerankScore: 49.6, compositeScore: 56.17 },
  'p-rhea': { expertiseScore: 58.7, pagerankScore: 33.9, compositeScore: 45.06 },
};

/**
 * One person's score columns, or zeros for someone the scoring pass has never
 * reached — the offline reading of `COALESCE(expertise_score, 0)` and friends.
 */
export function scoreColumnsFor(personId: string): PersonScoreColumns {
  return personScoreColumns[personId] ?? UNSCORED;
}

/**
 * One of the 0-100 columns above, as the 0-1 fraction the graph node and the
 * leaderboard's non-composite axes carry.
 *
 * The rounding is not a scale change, it is the removal of binary-float noise:
 * the seed writes two decimals, so the fraction has four, and `86.54 / 100`
 * evaluates to 0.8654000000000001 — the same number and an uglier wire. Every
 * surface that needs the fraction divides here, so they all divide the same way.
 */
export const asFraction = (score: number): number => Math.round(score * 100) / 10000;
