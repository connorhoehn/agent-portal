// The access tenant's pages, as data (docs/access-tenant-design.md §6,
// docs/access-tenant-goal.md "Pages").
//
// One row per page: its title and line, the lane that fills it, and — for a
// page whose data is not here yet — what it will hold. Pure data, no React, so
// `__tests__/accessSurfaces.test.ts` runs under plain `node --test` and the
// route inventory can import it. Every list page is a collection on the house
// frame from registration day (decision A9); `settings` is the one registered
// placeholder.

export type AccessSurfaceId =
  | 'catalog' | 'requests' | 'new-request' | 'request' | 'approvals'
  | 'policies' | 'reviews' | 'audit' | 'configuration' | 'settings';

export type AccessGroup = 'Request' | 'Approve' | 'Govern' | 'System';
export type AccessPhase = 'A0' | 'A1' | 'A2';

export interface AccessSurface {
  id: AccessSurfaceId;
  /** The route under /access (`:id` for the record). */
  path: string;
  group: AccessGroup;
  /** Page title — the rail and palette label. */
  title: string;
  /** One line under the title: what this page is for. */
  description: string;
  /** The lane (design §8) that brings this page its data. */
  phase: AccessPhase;
  /** The composer policy the DOM audit holds it to (decision A9). */
  composer: 'required' | 'exempt';
  /** Shown while the surface is registered but its data is not here yet. */
  emptyTitle?: string;
  emptyBody?: string;
  next?: string;
}

export const ACCESS_SURFACES: Record<AccessSurfaceId, AccessSurface> = {
  catalog: {
    id: 'catalog', path: '/access/catalog', group: 'Request', phase: 'A0', composer: 'required',
    title: 'Catalog',
    description: 'What can be requested: workspace roles and initiative memberships, with what you already hold.',
  },
  requests: {
    id: 'requests', path: '/access/requests', group: 'Request', phase: 'A0', composer: 'required',
    title: 'Requests',
    description: 'Your access requests — and, for approvers, your reports’ — with where each one stands.',
  },
  'new-request': {
    id: 'new-request', path: '/access/requests/new', group: 'Request', phase: 'A0', composer: 'exempt',
    title: 'New request',
    description: 'Who it is for, what, why and for how long. The approval chain is computed when you submit.',
  },
  request: {
    id: 'request', path: '/access/requests/:id', group: 'Request', phase: 'A0', composer: 'required',
    title: 'Request',
    description: 'One request: its approval chain, decisions, policy check and audit trail.',
  },
  approvals: {
    id: 'approvals', path: '/access/approvals', group: 'Approve', phase: 'A0', composer: 'required',
    title: 'Approvals',
    description: 'Requests whose current step you may decide now, resolved live from the directory.',
  },
  policies: {
    id: 'policies', path: '/access/policies', group: 'Govern', phase: 'A0', composer: 'required',
    title: 'Policies',
    description: 'Separation-of-duties rules: two roles nobody may hold together.',
  },
  reviews: {
    id: 'reviews', path: '/access/reviews', group: 'Govern', phase: 'A2', composer: 'required',
    title: 'Reviews',
    description: 'Access review campaigns: periodic certification of standing grants.',
    emptyTitle: 'No review campaigns yet',
    emptyBody: 'A review asks a reviewer to keep or revoke each standing grant in one workspace.',
    next: 'Lane A2 brings campaigns; a revoke decision becomes a pre-approved revocation request.',
  },
  audit: {
    id: 'audit', path: '/access/audit', group: 'Govern', phase: 'A0', composer: 'required',
    title: 'Audit',
    description: 'Every request transition, with who acted and why. Approvers see every event; others their own.',
  },
  configuration: {
    id: 'configuration', path: '/access/configuration', group: 'System', phase: 'A0', composer: 'exempt',
    title: 'Configuration',
    description: 'Default durations, who stewards each kind of item, and which items are sensitive.',
    next: 'Read-only in A0: the values the catalog is seeded with. Editing arrives with the catalog writes.',
  },
  settings: {
    id: 'settings', path: '/access/settings', group: 'System', phase: 'A1', composer: 'exempt',
    title: 'Access settings',
    description: 'Your own request notifications and default views.',
    emptyTitle: 'No preferences to set yet',
    emptyBody: 'Request and decision notifications arrive with the activity bell; your defaults will be kept here.',
    next: 'Lane A1 brings bell items for submissions, decisions and expiry warnings you can tune.',
  },
};

export const ACCESS_SURFACE_IDS = Object.keys(ACCESS_SURFACES) as AccessSurfaceId[];
