// The registry table's bounded commands: search, the "needs attention" filter
// the toolbar already offers, refresh, and opening one registered knowledge
// base. Nothing here adopts, syncs, uploads or repoints.
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import type { EntryStatusFilter } from './knowledgeFormat.ts';

export interface KnowledgeRegistryRow { id: string | null; name: string }

export const KNOWLEDGE_REGISTRY_SCOPE =
  'Search and the status filter apply to the loaded registry comparison; open shows one registered knowledge base. Commands never adopt, repoint, sync or upload.';

export function knowledgeRegistryAdapter(controls: {
  setSearch(value: string): void;
  setStatus(value: EntryStatusFilter): void;
  refresh(): void;
  /** The currently filtered rows, so `open` never reaches a hidden row. */
  rows: readonly KnowledgeRegistryRow[];
  navigate(path: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'knowledge bases', filters: { 'needs attention': 'attention' } }, {
    setQuery: controls.setSearch,
    setFilter: (value) => controls.setStatus(value === 'attention' ? 'attention' : 'all'),
    refresh: controls.refresh,
    scopeNote: KNOWLEDGE_REGISTRY_SCOPE,
    open(target) {
      // Only registered rows have a detail page; an unregistered live KB has no id.
      const openable = controls.rows.flatMap((row) => (row.id ? [{ id: row.id, title: row.name }] : []));
      const row = resolveCollectionTarget(target, openable);
      controls.navigate(`/admin/knowledge/registry/${encodeURIComponent(row.id)}`);
      return `Opening ${row.title}.`;
    },
  });
}
