// The Computers page's command composer: the search, the kind filter and refresh the toolbar
// offers, plus opening one computer by exact id or name. It never pairs, unpairs, pauses, starts,
// stops or hands work to a computer; those stay explicit controls.
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { KindFilter } from './computersModel.ts';

export const COMPUTERS_GRAMMAR: CollectionGrammar = { noun: 'computers', filters: { 'your machines': 'local', 'lab machines': 'lab' } };
export const COMPUTERS_SCOPE_NOTE = 'Commands search and filter the loaded computers, refresh them, or open one by exact name. They never pair, unpair, pause, start, stop or hand work to a computer.';

export function computersCommandAdapter(rows: ReadonlyArray<{ key: string; name: string }>, controls: {
  setQuery(value: string): void;
  setKind(value: KindFilter): void;
  refresh(): void;
  open(key: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter(COMPUTERS_GRAMMAR, {
    id: 'computers-commands',
    setQuery: controls.setQuery,
    setFilter: (value) => controls.setKind(value === 'local' || value === 'lab' ? value : ''),
    refresh: controls.refresh,
    scopeNote: COMPUTERS_SCOPE_NOTE,
    open(target) {
      const row = resolveCollectionTarget(target, rows.map((r) => ({ id: r.key, title: r.name })));
      controls.open(row.id);
      return `Opened ${row.title}.`;
    },
  });
}
