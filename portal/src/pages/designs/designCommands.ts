// The Designs register's bounded command grammar: search, the Status rail,
// refresh and opening one design by exact id or title. No React — testable
// under node:test. Nothing here answers, signs off or edits a design.
import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { DesignReview } from './types';

/** The Status rail's views, by their labels (All is `reset`). */
export const DESIGN_GRAMMAR: CollectionGrammar = {
  noun: 'designs',
  filters: { 'needs input': 'awaiting_input', 'awaiting sign-off': 'proposed', ideating: 'ideating', approved: 'approved' },
};

/** What the register's search box (and `search designs for …`) reads. */
export function matchesDesign(review: DesignReview, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [review.id, review.title, review.orgProjectName].some((field) => field.toLowerCase().includes(q));
}
