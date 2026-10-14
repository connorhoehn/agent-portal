// Delegation and timer escalation in the live resolver (lib/access/chain.ts)
// and the delegation rules (lib/access/delegation.ts), 2026-10-14.
import { decidingOnBehalfOf, eligibility, nextEscalationLevel } from '../chain.js';
import { delegationRefusal, delegationState } from '../delegation.js';
import type { AccessDelegationRow } from '../../../mock/access-delegations.js';
import { CAST, directory, item, user } from './fixtures.js';

const NOW = '2026-10-14T09:00:00.000Z';
const H = (h: number) => new Date(Date.parse(NOW) + h * 3_600_000).toISOString();
const fromRhea = { requesterId: 'u-rhea', beneficiaryId: 'u-rhea' };
const withOperator = () => [...CAST(), user('u-operator', null, { access: ['admin'] }), user('u-ana', 'p-ana', { access: ['approver'] })];
const ids = (e: { people: Array<{ id: string }> }) => e.people.map((p) => p.id);
const row = (over: Partial<AccessDelegationRow> = {}): AccessDelegationRow => ({
  id: 'dlg-x', delegatorId: 'u-omar', delegateId: 'u-priya', startsAt: H(-1), endsAt: H(24), reason: 'Out of office.', createdAt: H(-2), endedAt: null, endedBy: null, ...over,
});

describe('timer escalation tiers', () => {
  it('level 1 adds the access admins, level 2 the platform admins; the own decider stays', () => {
    const dir = directory(withOperator());
    expect(ids(eligibility('manager', item(), fromRhea, dir, 0))).toEqual(['u-omar']);
    expect(ids(eligibility('manager', item(), fromRhea, dir, 1))).toEqual(['u-omar', 'u-priya']);
    expect(ids(eligibility('manager', item(), fromRhea, dir, 2))).toEqual(['u-omar', 'u-operator', 'u-priya']);
    expect(eligibility('manager', item(), fromRhea, dir, 1).escalated).toBe('No decision in time: escalated to the access admins.');
  });
  it('an access-admin step escalates straight to the platform admins', () => {
    const dir = directory(withOperator());
    expect(ids(eligibility('access-admin', item(), fromRhea, dir, 1))).toEqual(['u-operator', 'u-priya']);
    expect(nextEscalationLevel('access-admin', item(), fromRhea, dir, 0)).toBe(1);
    expect(nextEscalationLevel('access-admin', item(), fromRhea, dir, 1)).toBeNull();
  });
  it('skips a tier that reaches nobody new, and stops at the top', () => {
    // The steward (hr-admin) decides nothing in Access, so level 0 already reached the access admins.
    const dir = directory(withOperator());
    expect(nextEscalationLevel('steward', item(), fromRhea, dir, 0)).toBe(2);
    expect(nextEscalationLevel('steward', item(), fromRhea, dir, 2)).toBeNull();
    // Nobody above at all: no escalation.
    expect(nextEscalationLevel('manager', item(), fromRhea, directory(CAST().filter((u) => u.id !== 'u-priya')), 0)).toBeNull();
  });
  it('never escalates to a party', () => {
    const dir = directory(withOperator());
    expect(ids(eligibility('manager', item(), { requesterId: 'u-priya', beneficiaryId: 'u-rhea' }, dir, 2))).toEqual(['u-omar', 'u-operator']);
  });
});

describe('delegates in the resolver', () => {
  const dirWith = (delegations: Array<{ delegatorId: string; delegateId: string }>, users = withOperator()) =>
    ({ ...directory(users), activeDelegations: delegations.map((d, i) => ({ id: `dlg-${i}`, ...d })) });

  it('a delegate decides exactly the delegator\'s steps, marked on behalf of them', () => {
    const dir = dirWith([{ delegatorId: 'u-omar', delegateId: 'u-ana' }]);
    const e = eligibility('manager', item(), fromRhea, dir);
    expect(e.people).toEqual([
      { id: 'u-ana', displayName: 'u-ana', personId: 'p-ana', onBehalfOf: { id: 'u-omar', displayName: 'u-omar', personId: 'p-omar' } },
      { id: 'u-omar', displayName: 'u-omar', personId: 'p-omar' },
    ]);
    expect(decidingOnBehalfOf('u-ana', 'manager', item(), fromRhea, dir)?.id).toBe('u-omar');
    expect(decidingOnBehalfOf('u-omar', 'manager', item(), fromRhea, dir)).toBeNull();
    // Not a step Omar may decide (the access-admin step): the delegate gets nothing.
    expect(ids(eligibility('access-admin', item(), fromRhea, dir))).toEqual(['u-priya']);
  });
  it('never a request the delegate is a party to', () => {
    const dir = dirWith([{ delegatorId: 'u-omar', delegateId: 'u-ana' }]);
    expect(ids(eligibility('manager', item(), { requesterId: 'u-ana', beneficiaryId: 'u-rhea' }, dir))).toEqual(['u-omar']);
  });
  it('an access-admin step only to a delegate who holds access-admin', () => {
    expect(ids(eligibility('access-admin', item(), fromRhea, dirWith([{ delegatorId: 'u-priya', delegateId: 'u-ana' }])))).toEqual(['u-priya']);
    const admin2 = [...withOperator(), user('u-zed', null, { access: ['access-admin'] })];
    // u-zed is an access admin already; a delegation to them adds nothing new.
    expect(ids(eligibility('access-admin', item(), fromRhea, dirWith([{ delegatorId: 'u-priya', delegateId: 'u-zed' }], admin2)))).toEqual(['u-priya', 'u-zed']);
  });
  it('never transitively, and never to someone with no deciding role', () => {
    const dir = dirWith([{ delegatorId: 'u-omar', delegateId: 'u-ana' }, { delegatorId: 'u-ana', delegateId: 'u-priya' }, { delegatorId: 'u-omar', delegateId: 'u-rhea' }]);
    // u-priya reaches the manager step only through a second hop; u-rhea holds no deciding role (and is a party).
    expect(ids(eligibility('manager', item(), fromRhea, dir))).toEqual(['u-ana', 'u-omar']);
  });
});

describe('delegation rules', () => {
  const dir = directory(withOperator());
  const ok = { delegateId: 'u-ana', startsAt: NOW, endsAt: H(48), reason: 'Out of office at the summit.' };
  it('state follows the window and an early end', () => {
    expect(delegationState(row({ startsAt: H(1) }), NOW)).toBe('scheduled');
    expect(delegationState(row(), NOW)).toBe('active');
    expect(delegationState(row({ endsAt: NOW }), NOW)).toBe('ended');
    expect(delegationState(row({ endedAt: H(-0.5) }), NOW)).toBe('ended');
  });
  it('accepts an eligible approver for a bounded window', () => {
    expect(delegationRefusal('u-omar', ok, dir, [], [], NOW)).toBeNull();
  });
  it.each([
    ['self', { delegateId: 'u-omar' }, 403, /yourself/],
    ['unknown', { delegateId: 'u-nobody' }, 400, /Unknown delegate/],
    ['no deciding role', { delegateId: 'u-rhea' }, 409, /no deciding role/],
    ['inverted window', { endsAt: H(-1), startsAt: NOW }, 400, /after startsAt/],
    ['already over', { startsAt: H(-10), endsAt: H(-1) }, 400, /already ended/],
    ['too long', { endsAt: H(24 * 31) }, 400, /at most 30 days/],
    ['short reason', { reason: 'away' }, 400, /reason/],
  ])('refuses %s', (_name, over, status, error) => {
    expect(delegationRefusal('u-omar', { ...ok, ...over }, dir, [], [], NOW)).toMatchObject({ status, error: expect.stringMatching(error) });
  });
  it('refuses an overlapping window of one\'s own and a chain, but not an ended one', () => {
    expect(delegationRefusal('u-omar', ok, dir, [row({ delegateId: 'u-priya' })], [], NOW)?.error).toMatch(/already hands your decisions/);
    expect(delegationRefusal('u-omar', ok, dir, [row({ delegatorId: 'u-ana', delegateId: 'u-priya' })], [], NOW)?.error).toMatch(/never passed on/);
    expect(delegationRefusal('u-omar', ok, dir, [row({ delegateId: 'u-priya', endedAt: H(-0.5) })], [], NOW)).toBeNull();
  });
  it('refuses a delegate who is a party to a request waiting on the delegator', () => {
    expect(delegationRefusal('u-omar', ok, dir, [], [{ id: 'req-9', requesterId: 'u-rhea', beneficiaryId: 'u-ana' }], NOW))
      .toEqual({ status: 409, error: 'u-ana is a party to req-9, which waits on your decision; delegate to someone else' });
  });
});
