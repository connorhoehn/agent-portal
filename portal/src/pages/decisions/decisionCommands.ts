// The Decisions register's bounded command grammar: search, the Status rail,
// refresh and opening one decision by exact id or topic. No React — testable
// under node:test. Nothing here decides, escalates or edits a decision.
import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';

/** The Status rail's views, by their labels (All is `reset`). */
export const DECISION_GRAMMAR: CollectionGrammar = {
  noun: 'decisions',
  filters: { waiting: 'waiting', escalated: 'escalated', open: 'open', decided: 'resolved' },
};
