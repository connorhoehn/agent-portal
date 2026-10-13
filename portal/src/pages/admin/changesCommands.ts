// The review queue's command composer: search the loaded changes, refresh,
// or open one change's review by exact ID or title. It never approves,
// rejects, delivers, re-reviews or dispatches — those stay explicit buttons.
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export const CHANGES_GRAMMAR: CollectionGrammar = { noun: 'changes' };
export const CHANGES_SCOPE_NOTE = 'Commands search the loaded review queue by title, codebase or initiative, refresh it, or open one change’s review by exact ID or title. They never approve, reject, deliver, re-review or dispatch a change.';

export interface ChangeSearchRow { id: string; title: string; repoFullName: string | null; orgProjectName: string | null }

export function matchesChange(row: ChangeSearchRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.title, row.repoFullName ?? '', row.orgProjectName ?? ''].some(v => v.toLowerCase().includes(q));
}

export function changesCommandAdapter(controls: {
  setQuery(value: string): void;
  refresh(): void;
  rows: readonly ChangeSearchRow[];
  open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter(CHANGES_GRAMMAR, {
    setQuery: controls.setQuery,
    refresh: controls.refresh,
    scopeNote: CHANGES_SCOPE_NOTE,
    open(target) {
      const row = resolveCollectionTarget(target, controls.rows);
      controls.open(row.id);
      return `Opening the review for ${row.title}.`;
    },
  });
}
