// A small directory for the access unit tests: the access cast plus the
// stewards the chain resolves, in the shape providers/access.ts builds.
import type { AccessCatalogRow } from '../../../mock/access-catalog.js';
import type { AccessDirectory, DirectoryUser } from '../types.js';

export const user = (id: string, personId: string | null, grants: Record<string, string[]>): DirectoryUser =>
  ({ id, displayName: id, personId, grants });

export function directory(users: DirectoryUser[], managers: Record<string, string> = { 'p-rhea': 'p-omar', 'p-omar': 'p-priya' }): AccessDirectory {
  return {
    users,
    managerOf: (p) => (p ? managers[p] ?? null : null),
    initiative: (id) => (id === 'p-auth-migration' ? { ownerPersonId: 'p-002', memberPersonIds: ['p-002', 'p-051', 'p-004'] } : null),
  };
}

export const CAST = (): DirectoryUser[] => [
  user('u-rhea', 'p-rhea', { access: ['requester'] }),
  user('u-omar', 'p-omar', { access: ['approver'] }),
  user('u-priya', 'p-priya', { access: ['access-admin'] }),
  user('u-hr', null, { orgiq: ['hr-admin'] }),
  user('u-vera', 'p-002', { orgiq: ['org-leader'] }),
];

export const item = (over: Partial<AccessCatalogRow> = {}): AccessCatalogRow => ({
  id: 'role:orgiq:sme', kind: 'tenant-role', tenant: 'orgiq', role: 'sme', projectId: null, title: 'SME in Work',
  description: 'd', sensitive: false, defaultDuration: '30d', stewardRule: 'tenant-steward', ...over,
});
