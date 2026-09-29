// Run with:  cd portal && node --test src/lib/__tests__/conversationCallModel.test.ts
//
// The page-agnostic call model: Search's channel (the same people give the
// same channel), where an accepted ring opens, and the Start call label.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  callAvailability,
  callChannelHref,
  callLabel,
  callTargets,
  peopleFromSearchChannel,
  searchCallChannel,
  uniquePeople, peopleFromRecordKeys } from '../conversationCallModel.ts';

test('searchCallChannel is order- and duplicate-insensitive, null with nobody', () => {
  assert.equal(searchCallChannel(['p-004', 'p-002', 'p-004']), 'search:p-002,p-004');
  assert.equal(searchCallChannel(['p-002', 'p-004']), searchCallChannel(['p-004', 'p-002']));
  assert.equal(searchCallChannel([]), null);
  assert.deepEqual(peopleFromSearchChannel('search:p-002,p-004'), ['p-002', 'p-004']);
  assert.deepEqual(peopleFromSearchChannel('initiative:p-soc2'), []);
});

test('callChannelHref opens the initiative, or Search on the same people, or nothing', () => {
  assert.equal(callChannelHref('initiative:p-auth-migration'), '/iq/projects/p-auth-migration');
  assert.equal(
    callChannelHref('search:p-002,p-004'),
    '/iq/search?tab=connections&selection=person%3Ap-002%2Cperson%3Ap-004',
  );
  assert.equal(callChannelHref(null), null);
  assert.equal(callChannelHref('dm:whatever'), null);
});

test('callLabel names one or two, then counts', () => {
  const t = (n: string) => ({ userId: n, displayName: n });
  assert.equal(callLabel([t('Nora')]), 'Call Nora');
  assert.equal(callLabel([t('Nora'), t('Theo')]), 'Call Nora and Theo');
  assert.equal(callLabel([t('Nora'), t('Theo'), t('Vera')]), 'Call Nora and 2 others');
});

test('the page words the nobody-to-call reason', () => {
  const base = { gatewayConfigured: true, connectionState: 'connected', platformApiUrl: 'http://p', signedIn: true, usersLoaded: true, targets: [] };
  assert.deepEqual(callAvailability({ ...base, nobodyReason: 'Select people with a sign-in to call them' }), { ok: false, reason: 'Select people with a sign-in to call them' });
  assert.equal(callAvailability(base).ok, false);
});

test('targets skip yourself and unlinked people; duplicates collapse', () => {
  const people = uniquePeople([{ personId: 'p-002', name: 'Vera' }, { personId: 'p-004', name: 'Nora' }, { personId: 'p-004', name: 'Nora' }, { personId: 'p-051', name: 'Nora Chang' }]);
  const users = [{ personId: 'p-002', userId: 'u-vera', displayName: 'Vera Green' }, { personId: 'p-004', userId: 'u-nora', displayName: 'Nora DaSilva' }];
  const { targets, skipped } = callTargets(people, users, 'u-vera');
  assert.deepEqual(targets, [{ userId: 'u-nora', displayName: 'Nora DaSilva' }]);
  assert.deepEqual(skipped.map((p) => p.personId), ['p-051']);
});

test('peopleFromRecordKeys: selected people then attached ones, named when a record says', async () => {
  const { peopleFromRecordKeys } = await import('../conversationCallModel.ts');
  const people = peopleFromRecordKeys(
    ['person:p-004', 'initiative:p-soc2', 'person:p-002'],
    [{ type: 'person', id: 'p-002', title: 'Vera Green' }, { type: 'person', id: 'p-051', title: 'Nora Chang' }, { type: 'initiative', id: 'p-soc2', title: 'SOC2' }],
  );
  assert.deepEqual(people, [
    { personId: 'p-004', name: 'p-004' },
    { personId: 'p-002', name: 'Vera Green' },
    { personId: 'p-051', name: 'Nora Chang' },
  ]);
});

test('callTargets: only yourself selected reports selfOnly, not "nobody has a sign-in"', () => {
  const users = [{ personId: 'p-1', userId: 'u-me', displayName: 'Me' }, { personId: 'p-2', userId: 'u-you', displayName: 'You' }];
  const selfOnly = callTargets([{ personId: 'p-1', name: 'Me' }], users, 'u-me');
  assert.equal(selfOnly.targets.length, 0);
  assert.equal(selfOnly.selfOnly, true);
  const withOther = callTargets([{ personId: 'p-1', name: 'Me' }, { personId: 'p-2', name: 'You' }], users, 'u-me');
  assert.equal(withOther.selfOnly, false);
  assert.equal(withOther.targets.length, 1);
  const unlinked = callTargets([{ personId: 'p-1', name: 'Me' }, { personId: 'p-9', name: 'Ghost' }], users, 'u-me');
  assert.equal(unlinked.selfOnly, false); // someone was skipped for a real reason
});

test('peopleFromRecordKeys: search results supply names without becoming people', () => {
  const people = peopleFromRecordKeys(['person:p-051'], [], [{ type: 'person', id: 'p-051', title: 'Nora Chang' }, { type: 'person', id: 'p-999', title: 'Not selected' }]);
  assert.deepEqual(people, [{ personId: 'p-051', name: 'Nora Chang' }]);
});
