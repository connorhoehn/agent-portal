// Approval chains: which steps a request needs (computed once, at submit) and
// who may decide each step NOW (resolved live on every read and decision,
// decision A4 — a request never caches its approvers, so a demoted approver
// cannot still decide).
//
//   manager       the beneficiary's person's manager (people.manager_id)
//   steward       a tenant role: the tenant's steward role holders
//                 (orgiq hr-admin, assessment program-lead, social
//                 community-admin, pipelines pipeline-admin); an initiative:
//                 its owner (projects.owner_id / project_contributions 'owner');
//                 budget visibility (`budget-owner`): the orgiq budget owner,
//                 `org-leader` — the role that allocates the money it reveals
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

/** The role whose holders steward a `budget-owner` item: orgiq's ManageBudgets holder that allocates (seeds/roles/orgiq/org-leader.cedar). */
export const BUDGET_OWNER_ROLE = { tenant: 'orgiq', role: 'org-leader' } as const;

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
      if (item.stewardRule === 'budget-owner') {
        return dir.users.filter((u) => (u.grants[BUDGET_OWNER_ROLE.tenant] ?? []).includes(BUDGET_OWNER_ROLE.role));
      }
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

/** Who may decide a step now, and — when the step's own candidates could not — why it escalated. */
export interface Eligibility { people: Person[]; escalated: string | null }

const STEP_NOUN: Readonly<Record<StepKind, string>> = { manager: 'manager', steward: 'steward', 'access-admin': 'access admin' };

/**
 * Who may decide a step of this request now, resolved live. Excludes the
 * requester and the beneficiary (A5) and anyone without a deciding role in
 * `access`. A step whose own candidates leave nobody escalates (decided during
 * A0) — at submit and on every later read, so a candidate who becomes
 * ineligible (demoted, or the requester filing for a report) moves the step on:
 *   1. to the access-admin holders, then
 *   2. when every access admin is a party too, to the cross-tenant `admin`
 *      holders standing in `access` — a step nobody may decide is a request
 *      stuck forever.
 * `escalated` names why, for the record page.
 */
export function eligibility(
  kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory,
): Eligibility {
  const beneficiary = dir.users.find((u) => u.id === request.beneficiaryId) ?? null;
  const notParty = (u: DirectoryUser) => u.id !== request.requesterId && u.id !== request.beneficiaryId;
  const raw = stepCandidates(kind, item, beneficiary, dir);
  let who = raw.filter((u) => decidesInAccess(u) && notParty(u));
  let escalated: string | null = null;
  if (who.length === 0) {
    const noun = STEP_NOUN[kind];
    const why = raw.length === 0 ? `no ${noun} is on record`
      : raw.every((u) => !notParty(u)) ? `the ${noun} is a party to this request`
      : `the ${noun} holds no deciding role in Access`;
    if (kind !== 'access-admin') {
      who = accessAdmins(dir).filter(notParty);
      escalated = `Escalated to the access admins: ${why}.`;
    }
    if (who.length === 0) {
      who = dir.users.filter((u) => (u.grants['access'] ?? []).includes('admin') && notParty(u));
      escalated = `Escalated to the platform admins: ${kind === 'access-admin' ? 'every access admin is a party to this request' : `${why}, and every access admin is a party to this request`}.`;
    }
  }
  return { people: who.map(personOf).sort((a, b) => a.displayName.localeCompare(b.displayName)), escalated };
}

/** Who may decide a step of this request now (see `eligibility`). */
export function eligibleDeciders(
  kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory,
): Person[] {
  return eligibility(kind, item, request, dir).people;
}
