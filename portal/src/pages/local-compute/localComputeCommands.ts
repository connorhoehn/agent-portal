// Local compute's command composers: bounded phrases over the same toolbar
// state each table shows (search, one filter, refresh, reset) and `open` by
// exact ID or name over the CURRENT rows. Nothing here pairs, unpairs,
// pauses, dispatches or edits configuration; those stay explicit controls.
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';

/** Presence phrases of the machines filter. */
export const MACHINE_PRESENCE_FILTERS: Record<string, string> = { connected: 'connected', stale: 'stale', offline: 'offline' };

export function machinesCommandAdapter(rows: ReadonlyArray<{ id: string; label: string }>, controls: {
  setQuery(value: string): void;
  setPresence(value: string): void;
  refresh(): void;
  selectMachine(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'machines', filters: MACHINE_PRESENCE_FILTERS }, {
    id: 'local-compute-machines-commands',
    setQuery: controls.setQuery,
    setFilter: controls.setPresence,
    refresh: controls.refresh,
    scopeNote: 'Search matches your loaded machines by name, platform and ID; presence filters them. Open selects one machine by exact ID or name. Commands never pair, unpair, pause or hand work to a machine.',
    open(target) {
      const machine = resolveCollectionTarget(target, rows.map((n) => ({ id: n.id, title: n.label })));
      controls.selectMachine(machine.id);
      return `Selected ${machine.title}.`;
    },
  });
}

/** Status phrases of the runs filter (JobStatus). */
export const RUN_STATUS_FILTERS: Record<string, string> = {
  queued: 'queued', running: 'running', 'awaiting review': 'awaiting_review', done: 'done', failed: 'failed', cancelled: 'cancelled',
};

export function localRunsCommandAdapter(rows: ReadonlyArray<{ id: string; title: string }>, controls: {
  setQuery(value: string): void;
  setStatus(value: string): void;
  refresh(): void;
  openRun(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'runs', filters: RUN_STATUS_FILTERS }, {
    id: 'local-compute-runs-commands',
    setQuery: controls.setQuery,
    setFilter: controls.setStatus,
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded runs by title, kind, machine and ID; status filters them. Open shows one run\'s log by exact ID or title. Commands never queue, retry or cancel a run.',
    open(target) {
      const run = resolveCollectionTarget(target, rows);
      controls.openRun(run.id);
      return `Opened the log for ${run.title}.`;
    },
  });
}
