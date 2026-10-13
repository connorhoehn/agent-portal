// Approval chains: which steps a request needs (computed once, at submit) and
// who may decide each step NOW (resolved live on every read and decision,
// decision A4 — a request never caches its approvers, so a demoted approver
// cannot still decide).
//
//   manager       the beneficiary's person's manager (people.manager_id)
//   steward       a tenant role: the tenant's steward role holders
//                 (orgiq hr-admin, assessment program-lead, social
//                 community-admin, pipelines pipeline-admin); an initiative:
//                 its owner (projects.owner_id / project_contributions 'owner')
//   access-admin  the access tenant's access-admin holders (sensitive items)
//
// Two live rules sit on top of the raw candidates:
//   * Only someone who can act in the access tenant decides here: a candidate
//     must hold `approver` or `access-admin` in `access` (the roles carrying
//     DecideAccess). A steward with no access grant cannot open the inbox.
//   * Nobody decides a request they submitted or benefit from (A5).
// When those leave a manager/steward step with nobody, the step escalates to
// the access-admin holders — a step nobody may decide is a request stuck
// forever, and "who escalates" is the access-admin's job. That escalation is a
// decision recorded here, not in the design doc (see the A0 report).

import type { AccessDirectory, DirectoryUser, Person, StepKind } from './types.js';
import type { AccessCatalogRow } from '../../mock/access-catalog.js';

/** The role whose holders steward a tenant's roles (design decision A4). */
export const TENANT_STEWARD_ROLE: Readonly<Record<string, string>> = {
  orgiq: 'hr-admin',
  assessment: 'program-lead',
  social: 'community-admin',
  pipelines: 'pipeline-admin',
};

/** Roles in `access` that carry DecideAccess (seeds/roles/access/*.cedar). */
export const ACCESS_DECIDER_ROLES: ReadonlySet<string> = new Set(['approver', 'access-admin']);
export const ACCESS_ADMIN_ROLE = 'access-admin';

export const personOf = (u: DirectoryUser): Person => ({ id: u.id, displayName: u.displayName, personId: u.personId });

export function personFor(dir: AccessDirectory, userId: string | null | undefined): Person | null {
  if (!userId) return null;
  const u = dir.users.find((x) => x.id === userId);
  return u ? personOf(u) : { id: userId, displayName: userId, personId: null };
}

const decidesInAccess = (u: DirectoryUser): boolean => (u.grants['access'] ?? []).some((r) => ACCESS_DECIDER_ROLES.has(r));
const accessAdmins = (dir: AccessDirectory): DirectoryUser[] => dir.users.filter((u) => (u.grants['access'] ?? []).includes(ACCESS_ADMIN_ROLE));

/** The step kinds a request for `item` on behalf of `beneficiary` needs, in order. */
export function planChain(item: Pick<AccessCatalogRow, 'sensitive'>, beneficiary: Pick<DirectoryUser, 'personId'> | null, dir: AccessDirectory): StepKind[] {
  const kinds: StepKind[] = [];
  if (dir.managerOf(beneficiary?.personId ?? null)) kinds.push('manager');
  kinds.push('steward');
  if (item.sensitive) kinds.push('access-admin');
  return kinds;
}

/** Raw candidates for a step kind, before the access-grant and self rules. */
export function stepCandidates(kind: StepKind, item: AccessCatalogRow, beneficiary: DirectoryUser | null, dir: AccessDirectory): DirectoryUser[] {
  switch (kind) {
    case 'manager': {
      const manager = dir.managerOf(beneficiary?.personId ?? null);
      return manager ? dir.users.filter((u) => u.personId === manager) : [];
    }
    case 'steward': {
      if (item.stewardRule === 'initiative-owner') {
        const owner = item.projectId ? dir.initiative(item.projectId)?.ownerPersonId ?? null : null;
        return owner ? dir.users.filter((u) => u.personId === owner) : [];
      }
      const role = TENANT_STEWARD_ROLE[item.tenant];
      return role ? dir.users.filter((u) => (u.grants[item.tenant] ?? []).includes(role)) : [];
    }
    case 'access-admin':
      return accessAdmins(dir);
  }
}

/**
 * Who may decide a step of this request now. Excludes the requester and the
 * beneficiary (A5) and anyone without a deciding role in `access`; an empty
 * manager/steward step escalates to the access-admin holders (same exclusions).
 */
export function eligibleDeciders(
  kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory,
): Person[] {
  const beneficiary = dir.users.find((u) => u.id === request.beneficiaryId) ?? null;
  const notParty = (u: DirectoryUser) => u.id !== request.requesterId && u.id !== request.beneficiaryId;
  let who = stepCandidates(kind, item, beneficiary, dir).filter((u) => decidesInAccess(u) && notParty(u));
  if (who.length === 0 && kind !== 'access-admin') who = accessAdmins(dir).filter(notParty);
  return who.map(personOf).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
