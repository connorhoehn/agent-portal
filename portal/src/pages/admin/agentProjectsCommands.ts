// The codebase list's command composer: search the loaded codebases, refresh
// them, or focus one by exact ID or repository name (the same `?project=`
// deep link the change cards use). It never links, unlinks, clones or runs.
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export const CODEBASES_GRAMMAR: CollectionGrammar = { noun: 'codebases' };
export const CODEBASES_SCOPE_NOTE = 'Commands search the loaded codebases by repository, initiative or owner, refresh them, or focus one by exact ID or repository name. They never link, unlink, clone or run anything.';

export interface CodebaseSearchRow {
  id: string;
  repoFullName: string;
  orgProjectName: string | null;
  owners: Array<{ name: string }>;
}

/** Case-insensitive substring over the repository, its initiative and its owners. */
export function matchesCodebase(row: CodebaseSearchRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.repoFullName, row.orgProjectName ?? '', ...row.owners.map(o => o.name)].some(v => v.toLowerCase().includes(q));
}

export function codebasesCommandAdapter(controls: {
  setQuery(value: string): void;
  refresh(): void;
  rows: readonly CodebaseSearchRow[];
  focus(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter(CODEBASES_GRAMMAR, {
    setQuery: controls.setQuery,
    refresh: controls.refresh,
    scopeNote: CODEBASES_SCOPE_NOTE,
    open(target) {
      const row = resolveCollectionTarget(target, controls.rows.map(r => ({ id: r.id, title: r.repoFullName })));
      controls.focus(row.id);
      return `Focused ${row.title}.`;
    },
  });
}
