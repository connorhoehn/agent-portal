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
//                 `org-leader` — the role that allocates the money it reveals;
//                 a sprint envelope (`budget-holder`, 2026-10-28): whoever set
//                 the initiative's allocation, else the org-leaders
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
//
// Escalation timers (2026-10-14, lib/access-escalation.ts): a step left
// undecided past its SLA moves up a tier — level 1 adds the access admins,
// level 2 the `admin` holders standing in `access` (an access-admin step's
// first tier is already the access admins, so its level 1 adds the admins).
// A timer escalation ADDS deciders; the step's own keep their right.
//
// Delegation (2026-10-14): an approver may hand their decisions to another
// approver for a window. A delegate in force is eligible for exactly the steps
// their delegator is eligible for now, with three limits that keep separation
// of duties: never a request they submitted or benefit from (A5), never an
// access-admin step unless they hold access-admin themselves, and never
// through a second delegation (a delegate's delegate decides nothing here).

import type { AccessDirectory, DirectoryUser, EligiblePerson, Person, StepKind } from './types.js';
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
      if (item.stewardRule === 'budget-holder') {
        // The sprint envelope's steward (2026-10-28): the person who set the
        // initiative's allocation (initiative_budgets.updated_by) — the money
        // the envelope comes out of is theirs to hand out. Conservative on
        // purpose: that one person when they can decide in Access; otherwise
        // the org-leaders (the budget-owner rule), who allocate across the
        // program. A holder who is not in the directory, or holds no deciding
        // role, is not asked and does not block: the fallback decides.
        const holderId = item.projectId ? dir.budgetHolderOf?.(item.projectId) ?? null : null;
        const holder = holderId ? dir.users.filter((u) => u.id === holderId && decidesInAccess(u)) : [];
        if (holder.length > 0) return holder;
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

/** Who may decide a step now, and — when the step's own candidates could not, or a timer moved it — why it escalated. */
export interface Eligibility { people: EligiblePerson[]; escalated: string | null }

/** The highest timer escalation level (lib/access-escalation.ts). */
export const MAX_ESCALATION_LEVEL = 2;

const adminHolders = (dir: AccessDirectory): DirectoryUser[] => dir.users.filter((u) => (u.grants['access'] ?? []).includes('admin'));

/** The tier a timer escalation to `level` adds for a step of `kind`, with its noun. */
function timerTier(kind: StepKind, level: number, dir: AccessDirectory): { users: DirectoryUser[]; noun: string } | null {
  if (level <= 0) return null;
  if (kind !== 'access-admin' && level === 1) return { users: accessAdmins(dir), noun: 'the access admins' };
  return { users: adminHolders(dir), noun: 'the platform admins' };
}

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
  level = 0,
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
  // Timer escalations (lib/access-escalation.ts) add each tier up to `level`.
  for (let n = 1; n <= Math.min(level, MAX_ESCALATION_LEVEL); n++) {
    const tier = timerTier(kind, n, dir);
    if (!tier) continue;
    const added = tier.users.filter((u) => notParty(u) && !who.some((w) => w.id === u.id));
    if (added.length === 0) continue;
    who = [...who, ...added];
    escalated = `No decision in time: escalated to ${tier.noun}.`;
  }
  const people: EligiblePerson[] = who.map(personOf);
  // Delegates in force decide for their delegator (never transitively).
  for (const d of dir.activeDelegations ?? []) {
    if (!who.some((w) => w.id === d.delegatorId)) continue;
    const delegate = dir.users.find((u) => u.id === d.delegateId);
    if (!delegate || !notParty(delegate) || !decidesInAccess(delegate)) continue;
    if (kind === 'access-admin' && !(delegate.grants['access'] ?? []).includes(ACCESS_ADMIN_ROLE)) continue;
    if (people.some((p) => p.id === delegate.id)) continue;
    const delegator = who.find((w) => w.id === d.delegatorId)!;
    people.push({ ...personOf(delegate), onBehalfOf: personOf(delegator) });
  }
  return { people: people.sort((a, b) => a.displayName.localeCompare(b.displayName)), escalated };
}

/**
 * The level a timer escalation of an undecided step at `level` moves to: the
 * next one that adds somebody who may not decide it yet, or null when no tier
 * above adds anyone (the step stays where it is — escalating to nobody new is
 * not an escalation).
 */
export function nextEscalationLevel(
  kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory, level: number,
): number | null {
  const now = new Set(eligibility(kind, item, request, dir, level).people.filter((p) => !p.onBehalfOf).map((p) => p.id));
  for (let n = level + 1; n <= MAX_ESCALATION_LEVEL; n++) {
    if (eligibility(kind, item, request, dir, n).people.some((p) => !p.onBehalfOf && !now.has(p.id))) return n;
  }
  return null;
}

/** The delegation a decider acts under on this step now, or null when they may decide it in their own right. */
export function decidingOnBehalfOf(
  actorId: string, kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory, level = 0,
): Person | null {
  return eligibility(kind, item, request, dir, level).people.find((p) => p.id === actorId)?.onBehalfOf ?? null;
}

/** Who may decide a step of this request now (see `eligibility`). */
export function eligibleDeciders(
  kind: StepKind, item: AccessCatalogRow, request: { requesterId: string; beneficiaryId: string }, dir: AccessDirectory, level = 0,
): EligiblePerson[] {
  return eligibility(kind, item, request, dir, level).people;
}
