// Approval chains (lib/access/chain.ts): the steps planned at submit and who
// may decide each step NOW, resolved live from the directory (decision A4).
import { eligibleDeciders, planChain, stepCandidates } from '../chain.js';
import { CAST, directory, item, user } from './fixtures.js';

const ids = (people: Array<{ id: string }>) => people.map((p) => p.id);
const fromRhea = { requesterId: 'u-rhea', beneficiaryId: 'u-rhea' };

describe('planChain', () => {
  it('manager, then steward, when the beneficiary has a manager', () => {
    const dir = directory(CAST());
    expect(planChain(item(), { personId: 'p-rhea' }, dir)).toEqual(['manager', 'steward']);
  });
  it('drops the manager step when people.manager_id is empty', () => {
    expect(planChain(item(), { personId: 'p-priya' }, directory(CAST()))).toEqual(['steward']);
    expect(planChain(item(), { personId: null }, directory(CAST()))).toEqual(['steward']);
  });
  it('adds an access-admin step for a sensitive item', () => {
    expect(planChain(item({ sensitive: true }), { personId: 'p-rhea' }, directory(CAST()))).toEqual(['manager', 'steward', 'access-admin']);
  });
});

describe('stepCandidates (before the access-grant and self rules)', () => {
  const dir = directory(CAST());
  const rhea = CAST()[0]!;
  it('manager resolves through people.manager_id with no fixture-specific code', () => {
    expect(ids(stepCandidates('manager', item(), rhea, dir))).toEqual(['u-omar']);
  });
  it('a tenant role is stewarded by that tenant\'s steward role holders', () => {
    expect(ids(stepCandidates('steward', item(), rhea, dir))).toEqual(['u-hr']);
  });
  it('an initiative is stewarded by its owner', () => {
    const it = item({ id: 'initiative:p-auth-migration', kind: 'initiative-membership', role: null, projectId: 'p-auth-migration', stewardRule: 'initiative-owner' });
    expect(ids(stepCandidates('steward', it, rhea, dir))).toEqual(['u-vera']);
  });
});

describe('eligibleDeciders', () => {
  it('the manager decides the manager step when they hold a deciding role in access', () => {
    expect(ids(eligibleDeciders('manager', item(), fromRhea, directory(CAST())))).toEqual(['u-omar']);
  });
  it('a steward with no access grant cannot decide; the step escalates to access-admin', () => {
    expect(ids(eligibleDeciders('steward', item(), fromRhea, directory(CAST())))).toEqual(['u-priya']);
  });
  it('a steward who holds approver in access decides it themself', () => {
    const cast = CAST().map((u) => (u.id === 'u-hr' ? user('u-hr', null, { orgiq: ['hr-admin'], access: ['approver'] }) : u));
    expect(ids(eligibleDeciders('steward', item(), fromRhea, directory(cast)))).toEqual(['u-hr']);
  });
  it('is live: demoting the manager moves the step to access-admin at once', () => {
    const cast = CAST().map((u) => (u.id === 'u-omar' ? user('u-omar', 'p-omar', {}) : u));
    expect(ids(eligibleDeciders('manager', item(), fromRhea, directory(cast)))).toEqual(['u-priya']);
  });
  it('never lists the requester or the beneficiary, even through escalation', () => {
    // Omar files for Rhea: he is her manager but the requester, so the manager step escalates.
    expect(ids(eligibleDeciders('manager', item(), { requesterId: 'u-omar', beneficiaryId: 'u-rhea' }, directory(CAST())))).toEqual(['u-priya']);
    // Priya's own request: nobody else holds access-admin, so the access-admin step has nobody.
    expect(ids(eligibleDeciders('access-admin', item(), { requesterId: 'u-priya', beneficiaryId: 'u-priya' }, directory(CAST())))).toEqual([]);
  });
});
