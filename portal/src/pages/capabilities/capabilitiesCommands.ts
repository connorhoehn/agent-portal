// Capability status table commands: search the seven loaded rows and refresh
// the reconcile read. There is no per-capability record and no filter.
import { collectionCommandAdapter } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export interface CapabilitySearchRow { label: string; configuredId: string | null; envVar: string; state: string }

export function matchesCapability(row: CapabilitySearchRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.label, row.configuredId, row.envVar, row.state].filter(Boolean).join(' ').toLowerCase().includes(q);
}

export function capabilitiesAdapter(controls: { setQuery(value: string): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'capabilities' }, {
    ...controls,
    scopeNote: 'Search uses the loaded capability status; refresh re-checks configured ids against the account. Commands never change configuration or start a capability.',
  });
}
