// Identity tables' bounded commands. Users: search the loaded users and
// refresh. Roles: search the permission matrix's actions and refresh.
// Neither ever edits grants, creates users or signs in as anyone.
import { collectionCommandAdapter } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';

export interface UserSearchRow { id: string; displayName: string; email: string | null; personId: string | null }

export function matchesUser(row: UserSearchRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.displayName, row.id, row.email, row.personId].filter(Boolean).join(' ').toLowerCase().includes(q);
}

export function matchesAction(action: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || action.toLowerCase().includes(q);
}

export function usersAdapter(controls: { setQuery(value: string): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'users' }, {
    ...controls,
    scopeNote: 'Search uses the loaded users; refresh re-reads users, tenants and roles. Commands never change grants, create users or sign in as anyone.',
  });
}

export function roleActionsAdapter(controls: { setQuery(value: string): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'actions' }, {
    ...controls, label: 'Permission matrix', id: 'role-actions-commands',
    scopeNote: 'Search narrows the permission matrix to matching actions; refresh re-reads roles. Commands never change roles or policies.',
  });
}
