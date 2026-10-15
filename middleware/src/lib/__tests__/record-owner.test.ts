// lib/record-owner.ts: a live identity clone owns its persona's records, and
// nothing else changes hands (docs/demo-content-goal.md rule 4).
import { identityClonesFixture } from '../../mock/identity-clones.js';
import { ownsRecord, recordOwnerSender, recordUserId } from '../record-owner.js';

const clone = (id: string, from: string, ttlMs = 3_600_000) => identityClonesFixture.rows().push({
  id, from, label: 'record-owner', displayName: 'Vera Green', email: null, personId: 'p-002', grants: { orgiq: ['org-leader'] },
  epoch: 0, createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString(),
});
afterEach(() => identityClonesFixture.reset());

it('maps a live clone to its persona and leaves every other id alone', () => {
  clone('u-vera-clone-1', 'u-vera');
  expect(recordUserId('u-vera-clone-1')).toBe('u-vera');
  expect(recordUserId('u-vera')).toBe('u-vera');
  expect(recordUserId('u-theo')).toBe('u-theo');
  // A clone-shaped id with no live row (removed, expired, forged) owns nothing.
  expect(recordUserId('u-vera-clone-gone')).toBe('u-vera-clone-gone');
  expect(recordUserId(null)).toBeNull();
});

it('a clone owns its persona\'s rows and never another persona\'s', () => {
  clone('u-vera-clone-1', 'u-vera');
  expect(ownsRecord('u-vera', 'u-vera-clone-1')).toBe(true);
  expect(ownsRecord('u-vera-clone-1', 'u-vera-clone-1')).toBe(true);
  expect(ownsRecord('u-release', 'u-vera-clone-1')).toBe(false);
  // The persona does not own a clone's own rows.
  expect(ownsRecord('u-vera-clone-1', 'u-vera')).toBe(false);
});

it('the chat sender is the persona, with the context\'s name, avatar and org', () => {
  clone('u-vera-clone-1', 'u-vera');
  expect(recordOwnerSender({ userId: 'u-vera-clone-1', displayName: 'Vera Green', org: 'orgiq', epoch: 0 }))
    .toEqual({ userId: 'u-vera', displayName: 'Vera Green', org: 'orgiq' });
  expect(recordOwnerSender({ userId: 'u-theo', name: 'Theo Chang', picture: '/a.jpg' }))
    .toEqual({ userId: 'u-theo', displayName: 'Theo Chang', avatarUrl: '/a.jpg' });
  expect(recordOwnerSender({ displayName: 'nobody' })).toBeNull();
});
