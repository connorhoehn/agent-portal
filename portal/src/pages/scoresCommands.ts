// The Scores leaderboard's bounded command grammar. Search is the toolbar's
// skill search (it re-ranks by that skill), the filters are the Department
// select's options, and `open` selects one person's detail card. No React —
// testable under node:test. Nothing here changes a score or the weighting.
import type { CollectionGrammar } from '../components/collections/collectionCommands.ts';
import type { ScoreEntry } from '../components/scores/types';

export function scoresGrammar(departments: readonly string[]): CollectionGrammar {
  return { noun: 'people', filters: Object.fromEntries(departments.map((department) => [department.toLowerCase(), department])) };
}

/** The rows `open` may resolve: the people the leaderboard currently shows. */
export const scoreTargets = (entries: readonly Pick<ScoreEntry, 'personId' | 'name'>[]) =>
  entries.map((entry) => ({ id: entry.personId, title: entry.name }));
