// Who may change the SDLC rules, and how (DE-43 + DE-46).
//
// The storage is providers/sdlc-policy-sets.ts; this is the rule set around
// writing it, kept out of the route so the legacy POST/DELETE /policies and
// the versioned PUT /policy-sets/:scope cannot drift apart.
//
// Who may edit SDLC policies is an OPEN user decision. What is built is the
// conservative default (docs/local-backlog-goal-2026-10-28.md, "Decisions
// taken by default"):
//   1. Cedar `EditSdlcPolicy` — hr-admin and admin; the sme lost it with the
//      ManageDevbox split (asked at the route, before this file).
//   2. The `org` set needs an org-wide role (org-leader, hr-admin, admin). An
//      initiative set needs the caller on that initiative, and a non-org-wide
//      caller may not make it looser than the org set.
//   3. Self-gate: a user who has caused a change governed by a scope (any
//      change, for `org`) may not edit that scope's rules, nor approve a
//      loosening of them. Admin may pass `override: true`, which is audited.
//   4. Two people to loosen (SDLC_POLICY_TWO_PERSON, on unless set to "off"):
//      a loosening edit is stored as a pending proposal and applies only when
//      a second EditSdlcPolicy holder or an org-leader approves it; the
//      proposer never can. Tightening applies at once.

import {
  looseningChanges, policySetError, normalizePolicy, type SdlcPolicy,
} from './sdlc-policy.js';
import {
  ensureOrgPolicySet, latestPolicySet, writePolicySet, createPolicyProposal, getPolicyProposal,
  closePolicyProposal, ORG_SCOPE, type PolicySetVersion, type PolicyProposal,
} from '../providers/sdlc-policy-sets.js';
import { hasChangesRequestedBy } from '../providers/sdlc.js';
import { ORG_WIDE_INITIATIVE_ROLES, stewardsInitiative } from './initiative-scope.js';
import type { Session } from './session.js';

export function twoPersonRuleOn(): boolean {
  const v = (process.env['SDLC_POLICY_TWO_PERSON'] ?? '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0');
}

const orgWide = (session: Session): boolean => ORG_WIDE_INITIATIVE_ROLES.includes(session.role);

export type PolicyWriteOutcome =
  | { kind: 'applied'; version: PolicySetVersion }
  | { kind: 'pending'; proposal: PolicyProposal }
  | { kind: 'conflict'; currentVersion: number }
  | { kind: 'refused'; status: 400 | 403 | 404 | 409; error: string; gate?: string; code?: string };

/** Parse a submitted set, or say why it is not one. */
export function parsePolicySet(raw: unknown): SdlcPolicy[] | string {
  if (!Array.isArray(raw)) return 'policies must be an array';
  const out: SdlcPolicy[] = [];
  for (const item of raw) {
    const p = normalizePolicy(item);
    if (typeof p === 'string') return p;
    out.push(p);
  }
  return policySetError(out) ?? out;
}

/** The current set of a scope, falling back to `org` for an initiative with none of its own. */
export async function effectivePolicySet(scope: string): Promise<{ own: PolicySetVersion | null; effective: PolicySetVersion }> {
  const org = await ensureOrgPolicySet();
  if (scope === ORG_SCOPE) return { own: org, effective: org };
  const own = await latestPolicySet(scope);
  return { own, effective: own ?? org };
}

/**
 * Rules 2 and 3 for one caller on one scope; null means may edit. Used for
 * both proposing and approving, so a second person who is gated by the same
 * rules cannot wave a loosening through either.
 */
async function editRefusal(session: Session, scope: string, override: boolean): Promise<PolicyWriteOutcome | null> {
  if (scope === ORG_SCOPE) {
    if (!orgWide(session)) {
      return { kind: 'refused', status: 403, gate: 'org-wide-role', error: 'only an org-wide role may edit the org policy set' };
    }
  } else if (!await stewardsInitiative(session, scope)) {
    return { kind: 'refused', status: 403, code: 'NOT_ON_INITIATIVE', error: 'you can only edit the policy set of an initiative you own or contribute to' };
  }
  if (await hasChangesRequestedBy(session.sub, scope)) {
    if (override && session.role === 'admin') return null;
    return {
      kind: 'refused', status: 409, gate: 'self-gated',
      error: 'these rules gate changes you caused, so someone else must change them',
    };
  }
  return null;
}

/**
 * Submit a whole set for a scope, starting from `baseVersion`. Applied at once
 * when it loosens nothing (or the two-person rule is off, or an admin
 * overrides); stored as a pending proposal when it loosens.
 */
export async function submitPolicySet(input: {
  session: Session; scope: string; policies: SdlcPolicy[]; baseVersion: number; reason: string; override?: boolean;
}): Promise<PolicyWriteOutcome> {
  const { session, scope, policies, baseVersion } = input;
  const reason = input.reason.trim();
  if (!reason) return { kind: 'refused', status: 400, error: 'reason is required' };
  const override = input.override === true && session.role === 'admin';
  const refused = await editRefusal(session, scope, override);
  if (refused) return refused;

  const { own, effective } = await effectivePolicySet(scope);
  if ((own?.version ?? 0) !== baseVersion) return { kind: 'conflict', currentVersion: own?.version ?? 0 };

  // An initiative may add policies and tighten; loosening the org floor needs
  // an org-wide role (DE-46 decision, conservative default).
  if (scope !== ORG_SCOPE && !orgWide(session)) {
    const org = await ensureOrgPolicySet();
    const loosensOrg = looseningChanges(org.policies, policies);
    if (loosensOrg.length > 0) {
      return {
        kind: 'refused', status: 403, gate: 'loosens-org',
        error: `an initiative set may not loosen the org policies without an org-wide role: ${loosensOrg.join('; ')}`,
      };
    }
  }

  const loosening = looseningChanges(effective.policies, policies);
  if (loosening.length > 0 && twoPersonRuleOn() && !override) {
    const proposal = await createPolicyProposal({
      scope, baseVersion, policies, loosening, proposedBy: session.sub, reason,
    });
    return { kind: 'pending', proposal };
  }
  const out = await writePolicySet({ scope, policies, baseVersion, changedBy: session.sub, reason });
  return out.ok ? { kind: 'applied', version: out.version } : { kind: 'conflict', currentVersion: out.currentVersion };
}

/**
 * The second person on a loosening proposal. Approving applies it as the
 * next version (or supersedes it when the set moved on since it was made);
 * the proposer may never decide their own proposal, approve or reject.
 * `mayDecide` is the route's answer to "EditSdlcPolicy holder or org-leader".
 */
export async function decidePolicyProposal(input: {
  session: Session; id: string; decision: 'approve' | 'reject'; note: string | null; override?: boolean;
}): Promise<PolicyWriteOutcome | { kind: 'rejected'; proposal: PolicyProposal }> {
  const proposal = await getPolicyProposal(input.id);
  if (!proposal) return { kind: 'refused', status: 404, error: 'No such policy proposal' };
  if (proposal.status !== 'pending') {
    return { kind: 'refused', status: 409, gate: 'not-pending', error: `this proposal is ${proposal.status}` };
  }
  if (proposal.proposedBy === input.session.sub) {
    return { kind: 'refused', status: 409, gate: 'self-approval', error: 'you proposed this edit, so someone else must decide it' };
  }
  const override = input.override === true && input.session.role === 'admin';
  // org-leader may approve an org loosening (DE-43 §4) though it holds no
  // EditSdlcPolicy; the scope rules still apply to it as to anyone.
  const refused = await editRefusal(input.session, proposal.scope, override);
  if (refused) return refused;

  if (input.decision === 'reject') {
    const ok = await closePolicyProposal(proposal.id, { status: 'rejected', decidedBy: input.session.sub, decisionNote: input.note, appliedVersion: null });
    if (!ok) return { kind: 'refused', status: 409, gate: 'not-pending', error: 'this proposal was decided by someone else first' };
    return { kind: 'rejected', proposal: { ...proposal, status: 'rejected', decidedBy: input.session.sub, decisionNote: input.note } };
  }
  const out = await writePolicySet({
    scope: proposal.scope, policies: proposal.policies, baseVersion: proposal.baseVersion,
    changedBy: proposal.proposedBy,
    reason: `${proposal.reason} (loosening approved by ${input.session.sub})`,
  });
  if (!out.ok) {
    await closePolicyProposal(proposal.id, {
      status: 'superseded', decidedBy: input.session.sub,
      decisionNote: `the set moved to version ${out.currentVersion} after this was proposed`, appliedVersion: null,
    });
    return { kind: 'conflict', currentVersion: out.currentVersion };
  }
  await closePolicyProposal(proposal.id, {
    status: 'approved', decidedBy: input.session.sub, decisionNote: input.note, appliedVersion: out.version.version,
  });
  return { kind: 'applied', version: out.version };
}
