// SDLC governance offline: versioned per-initiative policy sets (DE-46) and
// separation of duties (DE-43), through the real providers and fixtures.
//
// Pinned here:
//   * a set's edits are versions with author and reason; a stale base loses;
//   * a change is judged under the set version it was captured under, until
//     someone re-pins it, and both evaluations stay readable;
//   * initiative A's change uses A's set, a codebase with no initiative the org set;
//   * nobody decides a change they caused; an unattributed change and a change
//     to governance code need the configured approver roles;
//   * a loosening edit waits for a second person, its proposer cannot approve
//     it, and evaluation does not move until someone else does;
//   * an initiative steward cannot loosen the org floor; whoever the rules
//     have gated cannot edit them.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true, agentcore: true }, region: 'us-east-1' } }));
// Who is on which initiative, named per case (the directory lookup is not the subject).
const onInitiative = new Map<string, Set<string>>();
jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async (session: { sub: string; role: string } | null, initiativeId: string) =>
    !!session && (['org-leader', 'hr-admin', 'admin'].includes(session.role) || !!onInitiative.get(session.sub)?.has(initiativeId))),
}));

import { sdlcChanges, sdlcChangeGates, sdlcChangeReviews, sdlcPolicyVersions, sdlcPolicyProposals } from '../sdlc.js';
import { agentProjects } from '../agent-projects.js';
import {
  createChangeRequest, decideChange, evaluateChange, getChangeRequest, listEvaluations,
  recordReview, hasChangesRequestedBy,
} from '../../providers/sdlc.js';
import { writePolicySet, latestPolicySet, listPolicySetVersions, getPolicySetVersion } from '../../providers/sdlc-policy-sets.js';
import { submitPolicySet, decidePolicyProposal } from '../../lib/sdlc-policy-governance.js';
import type { SdlcPolicy } from '../../lib/sdlc-policy.js';
import type { Session } from '../../lib/session.js';

const OBSERVABILITY = '4870e01d-9274-5c4a-91af-ea9acb7f857a'; // p-observability
const AUTH_SERVICE = '7aad75a2-a91c-5f87-a312-2b2691b37b8c';  // p-auth-migration
const NEEDS_APPROVAL = '9f2c17a0-5b64-4de1-8a03-6c1de4f27b58';
const UNLINKED = '00000000-0000-4000-8000-0000000000aa';

const session = (sub: string, role: string): Session => ({ sub, role, tenant: 'orgiq' } as unknown as Session);
const HR = session('u-hr', 'hr-admin');
const LEADER = session('u-vera', 'org-leader');
const ADMIN = session('u-admin', 'admin');

beforeEach(() => {
  for (const f of [sdlcPolicyVersions, sdlcPolicyProposals, sdlcChanges, sdlcChangeReviews, sdlcChangeGates, agentProjects]) f.reset('default');
  onInitiative.clear();
  delete process.env['SDLC_POLICY_TWO_PERSON'];
  delete process.env['SDLC_GOVERNANCE_APPROVER_ROLES'];
});

async function orgPolicies(): Promise<SdlcPolicy[]> { return (await latestPolicySet('org'))!.policies; }
const withMaxFiles = (set: SdlcPolicy[], max: number): SdlcPolicy[] =>
  set.map((p) => (p.kind === 'max_files' ? { ...p, config: { max } } : p));

/** A captured, reviewed change of `n` files on a codebase, evaluated once. */
/** mock/agent-project-runs.ts: a run with a recorded cost ($0.42). Without one
 *  the max_cost gate routes every capture to a person (DE-33), which is not
 *  what these cases are about. */
const COSTED_RUN = '1c9b2d5f-3a70-4b62-8d4c-8e2f6b015a22';

async function capture(projectId: string, n: number, requestedBy = 'u-eli'): Promise<string> {
  const files = Array.from({ length: n }, (_, i) => `src/f${i}.ts`);
  // An author on the default devbox profile's list (DE-40): an unrecorded
  // model routes every capture to a person, which these cases are not about.
  const c = await createChangeRequest({ projectId, runId: COSTED_RUN, title: 'wide change', diff: 'd', files, requestedBy, model: 'us.anthropic.claude-sonnet-5' });
  await recordReview({ changeId: c.id, verdict: 'approve', summary: null, findings: [] });
  await evaluateChange(c.id);
  return c.id;
}

describe('versioned policy sets (DE-46)', () => {
  it('two edits to an initiative set produce versions 2 and 3 with author and reason; a stale base loses', async () => {
    const base = await orgPolicies();
    expect((await writePolicySet({ scope: 'p-auth-migration', policies: base, baseVersion: 0, changedBy: 'u-hr', reason: 'start' })).ok).toBe(true);
    const v2 = await writePolicySet({ scope: 'p-auth-migration', policies: withMaxFiles(base, 30), baseVersion: 1, changedBy: 'u-hr', reason: 'tighter' });
    const v3 = await writePolicySet({ scope: 'p-auth-migration', policies: withMaxFiles(base, 20), baseVersion: 2, changedBy: 'u-vera', reason: 'tighter still' });
    expect(v2).toMatchObject({ ok: true, version: { version: 2, changedBy: 'u-hr', reason: 'tighter', basedOn: 1 } });
    expect(v3).toMatchObject({ ok: true, version: { version: 3, changedBy: 'u-vera', reason: 'tighter still', basedOn: 2 } });
    expect((await listPolicySetVersions('p-auth-migration')).map((v) => v.version)).toEqual([3, 2, 1]);
    expect(await writePolicySet({ scope: 'p-auth-migration', policies: base, baseVersion: 2, changedBy: 'u-hr', reason: 'late' }))
      .toEqual({ ok: false, conflict: true, currentVersion: 3 });
  });

  it('a change keeps the version it was captured under on re-review; repin moves it, and both evaluations are readable', async () => {
    const id = await capture(OBSERVABILITY, 45);
    expect((await getChangeRequest(id))).toMatchObject({ status: 'needs_approval', policyScope: 'org', policyVersion: 1 });

    // Loosen max_files to 100 at org version 2.
    await writePolicySet({ scope: 'org', policies: withMaxFiles(await orgPolicies(), 100), baseVersion: 1, changedBy: 'u-hr', reason: 'loosen' });

    const again = await evaluateChange(id);
    expect(again).toMatchObject({ status: 'needs_approval', policyScope: 'org', policyVersion: 1, repinned: false });

    const repinned = await evaluateChange(id, { repin: true });
    expect(repinned).toMatchObject({ status: 'approved', policyScope: 'org', policyVersion: 2, repinned: true });

    const history = await listEvaluations(id);
    expect(history.map((e) => [e.seq, e.policyVersion])).toEqual([[1, 1], [2, 1], [3, 2]]);
    expect(history[0]!.gates.some((g) => g.kind === 'max_files')).toBe(true);
  });

  it('a change on initiative A uses A\'s set; a codebase with no initiative uses the org set', async () => {
    // A strict set for p-auth-migration only: max 2 files.
    await writePolicySet({ scope: 'p-auth-migration', policies: withMaxFiles(await orgPolicies(), 2), baseVersion: 0, changedBy: 'u-hr', reason: 'strict' });
    const onA = await capture(AUTH_SERVICE, 3);
    expect(await getChangeRequest(onA)).toMatchObject({ status: 'needs_approval', policyScope: 'p-auth-migration', policyVersion: 1 });

    const row = agentProjects.rows().find((p) => p.id === OBSERVABILITY)!;
    agentProjects.rows().push({ ...row, id: UNLINKED, repoFullName: 'o/unlinked', orgProjectId: null });
    const unlinked = await capture(UNLINKED, 3);
    expect(await getChangeRequest(unlinked)).toMatchObject({ status: 'approved', policyScope: 'org', policyVersion: 1 });
  });
});

describe('separation of duties on decide (DE-43)', () => {
  it('refuses the requester, and lets a different SME decide', async () => {
    expect(await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-nora', role: 'sme' }))
      .toMatchObject({ ok: false, gate: 'self-approval' });
    expect(await decideChange(NEEDS_APPROVAL, 'reject', { by: 'u-nora', role: 'sme' }))
      .toMatchObject({ ok: false, gate: 'self-approval' });
    expect(await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-eli', role: 'sme' })).toEqual({ ok: true, status: 'approved' });
  });

  it('lets an admin override their own change', async () => {
    sdlcChanges.rows().find((c) => c.id === NEEDS_APPROVAL)!.requestedBy = 'u-admin';
    expect(await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-admin', role: 'admin', override: true })).toEqual({ ok: true, status: 'approved' });
  });

  it('a change with no recorded requester is approved only by org-wide roles, never an SME', async () => {
    sdlcChanges.rows().find((c) => c.id === NEEDS_APPROVAL)!.requestedBy = null;
    expect(await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-eli', role: 'sme' })).toMatchObject({ ok: false, gate: 'unattributed' });
    expect(await decideChange(NEEDS_APPROVAL, 'approve', { by: 'u-hr', role: 'hr-admin' })).toEqual({ ok: true, status: 'approved' });
  });

  it('a change to governance code is approved only by the governance approver roles', async () => {
    const c = await createChangeRequest({ projectId: OBSERVABILITY, title: 'loosen', diff: 'd', files: ['middleware/seeds/roles/orgiq/sme.cedar'], requestedBy: 'u-nora' });
    await recordReview({ changeId: c.id, verdict: 'approve', summary: null, findings: [] });
    expect((await evaluateChange(c.id))?.status).toBe('needs_approval'); // the default sensitive-paths glob now covers it
    expect(await decideChange(c.id, 'approve', { by: 'u-hr', role: 'hr-admin' })).toMatchObject({ ok: false, gate: 'governance-approver' });
    expect(await decideChange(c.id, 'approve', { by: 'u-admin', role: 'admin' })).toEqual({ ok: true, status: 'approved' });
  });

  it('records who caused a change and answers the self-gate question per scope', async () => {
    expect(await hasChangesRequestedBy('u-nora', 'org')).toBe(true);
    expect(await hasChangesRequestedBy('u-nora', 'p-observability')).toBe(true);
    expect(await hasChangesRequestedBy('u-nora', 'p-auth-migration')).toBe(false);
    expect(await hasChangesRequestedBy('u-hr', 'org')).toBe(false);
  });
});

describe('policy edits (DE-43 two-person rule, DE-46 scope rules)', () => {
  it('a loosening edit by hr-admin is pending, changes no evaluation, and only a second person applies it', async () => {
    const loose = withMaxFiles(await orgPolicies(), 500);
    const out = await submitPolicySet({ session: HR, scope: 'org', policies: loose, baseVersion: 1, reason: 'big refactors' });
    expect(out.kind).toBe('pending');
    const proposal = (out as Extract<typeof out, { kind: 'pending' }>).proposal;
    expect(proposal.loosening.join(' ')).toMatch(/raises "Large changes need a human" from 40 to 500/);
    expect((await latestPolicySet('org'))!.version).toBe(1);
    // A new change is still judged by version 1.
    expect((await getChangeRequest(await capture(OBSERVABILITY, 45)))!.status).toBe('needs_approval');

    expect(await decidePolicyProposal({ session: HR, id: proposal.id, decision: 'approve', note: null }))
      .toMatchObject({ kind: 'refused', status: 409, gate: 'self-approval' });
    const applied = await decidePolicyProposal({ session: LEADER, id: proposal.id, decision: 'approve', note: 'ok' });
    expect(applied).toMatchObject({ kind: 'applied', version: { version: 2, changedBy: 'u-hr' } });
    expect((await getChangeRequest(await capture(OBSERVABILITY, 45)))!.status).toBe('approved');
  });

  it('tightening applies at once, and reports no override', async () => {
    const out = await submitPolicySet({ session: HR, scope: 'org', policies: withMaxFiles(await orgPolicies(), 10), baseVersion: 1, reason: 'tighter' });
    expect(out).toMatchObject({ kind: 'applied', version: { version: 2 } });
    expect(out).not.toHaveProperty('overrode');
  });

  it('an admin override of the two-person rule is reported, so the route can audit it', async () => {
    const out = await submitPolicySet({ session: ADMIN, scope: 'org', policies: withMaxFiles(await orgPolicies(), 500), baseVersion: 1, reason: 'x', override: true });
    expect(out).toMatchObject({ kind: 'applied', overrode: true, version: { version: 2, changedBy: 'u-admin' } });
  });

  it('disabling every default is loosening, so it waits; a stale base is a conflict', async () => {
    const off = (await orgPolicies()).map((p) => ({ ...p, enabled: false }));
    expect((await submitPolicySet({ session: HR, scope: 'org', policies: off, baseVersion: 1, reason: 'off' })).kind).toBe('pending');
    expect(await submitPolicySet({ session: HR, scope: 'org', policies: off, baseVersion: 0, reason: 'off' })).toEqual({ kind: 'conflict', currentVersion: 1 });
  });

  it('SDLC_POLICY_TWO_PERSON=off applies a loosening edit at once', async () => {
    process.env['SDLC_POLICY_TWO_PERSON'] = 'off';
    expect((await submitPolicySet({ session: HR, scope: 'org', policies: withMaxFiles(await orgPolicies(), 500), baseVersion: 1, reason: 'x' })).kind).toBe('applied');
  });

  it('whoever the rules have gated cannot edit them (u-nora has changes on p-observability); admin may override', async () => {
    const nora = session('u-nora', 'hr-admin'); // a role that may edit, held by someone the rules gate
    expect(await submitPolicySet({ session: nora, scope: 'org', policies: withMaxFiles(await orgPolicies(), 10), baseVersion: 1, reason: 'x' }))
      .toMatchObject({ kind: 'refused', status: 409, gate: 'self-gated' });
    sdlcChanges.rows()[0]!.requestedBy = 'u-admin';
    expect(await submitPolicySet({ session: ADMIN, scope: 'org', policies: withMaxFiles(await orgPolicies(), 10), baseVersion: 1, reason: 'x' }))
      .toMatchObject({ kind: 'refused', gate: 'self-gated' });
    expect(await submitPolicySet({ session: ADMIN, scope: 'org', policies: withMaxFiles(await orgPolicies(), 10), baseVersion: 1, reason: 'x', override: true }))
      .toMatchObject({ kind: 'applied', overrode: true });
  });

  it('the org set needs an org-wide role; an initiative set needs the caller on it', async () => {
    const steward = session('u-eli', 'sme');
    expect(await submitPolicySet({ session: steward, scope: 'org', policies: await orgPolicies(), baseVersion: 1, reason: 'x' }))
      .toMatchObject({ kind: 'refused', status: 403, gate: 'org-wide-role' });
    expect(await submitPolicySet({ session: steward, scope: 'p-auth-migration', policies: await orgPolicies(), baseVersion: 0, reason: 'x' }))
      .toMatchObject({ kind: 'refused', status: 403, code: 'NOT_ON_INITIATIVE' });
  });

  it('an initiative set that disables an org policy is refused for a non-org-wide role, allowed tightening', async () => {
    const steward = session('u-eli', 'sme');
    onInitiative.set('u-eli', new Set(['p-auth-migration']));
    const disabled = (await orgPolicies()).map((p) => (p.kind === 'max_cost' ? { ...p, enabled: false } : p));
    expect(await submitPolicySet({ session: steward, scope: 'p-auth-migration', policies: disabled, baseVersion: 0, reason: 'x' }))
      .toMatchObject({ kind: 'refused', status: 403, gate: 'loosens-org' });
    expect(await submitPolicySet({ session: steward, scope: 'p-auth-migration', policies: withMaxFiles(await orgPolicies(), 5), baseVersion: 0, reason: 'x' }))
      .toMatchObject({ kind: 'applied', version: { scope: 'p-auth-migration', version: 1 } });
    expect(await getPolicySetVersion('p-auth-migration', 1)).not.toBeNull();
  });
});
