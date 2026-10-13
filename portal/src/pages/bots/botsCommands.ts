// The bot roster's command composer: the same search, status filter and
// refresh the toolbar offers, plus opening one bot by exact id or name. It
// never runs, pauses, resumes, creates or deletes a bot — those stay buttons.
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import type { BotStatusFilter } from './botsFormat.ts';

export const BOTS_GRAMMAR: CollectionGrammar = { noun: 'bots', filters: { enabled: 'enabled', paused: 'paused' } };
export const BOTS_SCOPE_NOTE = 'Commands search and filter the loaded bot roster, refresh it, or open one bot by exact ID or name. They never run, pause, resume, create or delete a bot.';

export function botsCommandAdapter(controls: {
  setQuery(value: string): void;
  setStatus(value: BotStatusFilter): void;
  refresh(): void;
  /** The rows currently shown (after search and status). */
  rows: readonly { id: string; name: string }[];
  open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter(BOTS_GRAMMAR, {
    setQuery: controls.setQuery,
    setFilter: value => controls.setStatus(value === 'enabled' || value === 'paused' ? value : 'all'),
    refresh: controls.refresh,
    scopeNote: BOTS_SCOPE_NOTE,
    open(target) {
      const bot = resolveCollectionTarget(target, controls.rows.map(row => ({ id: row.id, title: row.name })));
      controls.open(bot.id);
      return `Opening ${bot.title}.`;
    },
  });
}
