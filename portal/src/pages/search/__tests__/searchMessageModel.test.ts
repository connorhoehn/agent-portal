import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dmPageHref, messageAvailability } from '../searchMessageModel.ts';

const vera = { personId: 'p-002', name: 'Vera Green' };
const eli = { personId: 'p-011', name: 'Eli Garcia' };
const maya = { personId: 'p-051', name: 'Maya Patel' };
const users = [
  { personId: 'p-002', userId: 'u-vera', displayName: 'Vera Green', social: true },
  { personId: 'p-011', userId: 'u-eli', displayName: 'Eli Garcia', social: false },
  { personId: 'p-001', userId: 'u-theo', displayName: 'Theo Chang', social: true },
];

test('one linked person with a social grant: the sorted social DM lobby', () => {
  const r = messageAvailability({ people: [vera], users, selfUserId: 'u-theo' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.target, { userId: 'u-vera', displayName: 'Vera Green' });
  assert.equal(r.lobby, 'social:dm:u-theo:u-vera');
  assert.equal(dmPageHref(r.lobby), '/social/dms/social%3Adm%3Au-theo%3Au-vera');
});

test('each reason the button is off is said in the person\'s name', () => {
  const off = (people: typeof vera[], u = users, self: string | null = 'u-theo') => {
    const r = messageAvailability({ people, users: u, selfUserId: self });
    assert.equal(r.ok, false);
    return r.reason;
  };
  assert.match(off([]), /Select a person/);
  assert.match(off([vera, eli]), /one-to-one/);
  assert.match(off([vera], null as unknown as typeof users), /Looking up/);
  assert.match(off([maya]), /Maya Patel has no Work sign-in/);
  assert.match(off([eli]), /Eli Garcia is not in Social/);
  assert.match(off([{ personId: 'p-001', name: 'Theo Chang' }]), /only person selected/);
});

test('a roster without the social flag (caller not in Social) does not claim anyone is outside it', () => {
  const r = messageAvailability({ people: [eli], users: users.map(({ social: _s, ...u }) => u), selfUserId: 'u-theo' });
  assert.equal(r.ok, true);
});
