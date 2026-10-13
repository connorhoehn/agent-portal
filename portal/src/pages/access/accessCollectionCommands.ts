// The command composer's grammar for each access collection page — the one
// bounded grammar (components/collections/collectionCommands.ts): search, at
// most one existing filter, reset, refresh and `open <exact ID or title>`
// over the rows currently shown. Nothing here decides, withdraws or submits a
// request; those stay explicit, permission-checked controls on the record.

import { collectionCommandAdapter, resolveCollectionTarget, type CollectionControls, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export type AccessCollection = 'catalog' | 'requests' | 'approvals' | 'policies' | 'reviews' | 'audit';

/** Explicit phrase → the toolbar filter value it sets (never a mutation). */
export const ACCESS_GRAMMARS: Readonly<Record<AccessCollection, CollectionGrammar>> = {
  catalog: { noun: 'catalog items', filters: { work: 'orgiq', assessment: 'assessment', social: 'social', pipelines: 'pipelines' } },
  requests: { noun: 'requests', filters: { open: 'open', approved: 'approved', active: 'active', closed: 'closed' } },
  approvals: { noun: 'approvals' },
  policies: { noun: 'policies', filters: { blocking: 'block', warning: 'warn' } },
  reviews: { noun: 'reviews' },
  audit: {
    noun: 'events',
    filters: { submitted: 'submitted', approved: 'approved', rejected: 'step-rejected', withdrawn: 'withdrawn', override: 'sod-override' },
  },
};

/** What each page's help popover says the commands touch, and never do. */
export const ACCESS_SCOPE_NOTES: Readonly<Record<AccessCollection, string>> = {
  catalog: 'Search and the workspace filter apply to the loaded catalog. Open starts a request for one exact item in the wizard; nothing is submitted until you press Submit there.',
  requests: 'Search and the status filter apply to the loaded requests. Open shows one exact request. Commands never withdraw, approve or reject anything.',
  approvals: 'Search applies to the requests waiting on you. Open shows one exact request; approve, reject and request information stay explicit controls on that page. This input records no decision.',
  policies: 'Search and the severity filter apply to the loaded policies. Open shows one policy. Commands never change a policy.',
  reviews: 'Search applies to loaded review campaigns. Commands never start, decide or close a review.',
  audit: 'Search and the event filter apply to the loaded events. Open shows the request an exact event belongs to. The audit trail is append-only; commands change nothing.',
};

/** Build the adapter for one access collection page. */
export function accessCollectionAdapter(collection: AccessCollection, controls: Omit<CollectionControls, 'scopeNote' | 'id'> & { scopeNote?: string }): CollectionCommandAdapter {
  return collectionCommandAdapter(ACCESS_GRAMMARS[collection], {
    ...controls,
    id: `access-${collection}-commands`,
    scopeNote: controls.scopeNote ?? ACCESS_SCOPE_NOTES[collection],
  });
}

/** Resolve one row of the rows currently shown (exact id, or a unique exact title). */
export const resolveAccessTarget = resolveCollectionTarget;
