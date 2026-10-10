import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navigationActivity } from '../navActivity.ts';
const empty = { sections: {}, threads: [] };
const scope = { tenant: 'social', actorId: 'u-reader', hasSocialGrant: true, visiblePaths: ['/social/dms', '/social/channels', '/social/rooms', '/social/teams'] };
const notice = (id: string, channel: string, extra = {}) => ({ id, channel, payload: { tenant: 'social' }, ...extra });
test('current unread notices mark only their known doors; duplicates and read rows do not inflate counts', () => {
  const dm = notice('dm', 'social:dm:u-peer:u-reader');
  assert.deepEqual(navigationActivity(scope, [dm, dm, notice('channel', 'social:ch:general'), notice('read', 'social:ch:general', { read: true }), notice('team', 'social:team:t:general'), notice('room', 'social:room:lounge')], empty), {
    '/social/dms': { label: '1 unread notice in this inbox' }, '/social/channels': { label: '1 unread notice in this inbox' }, '/social/rooms': { label: '1 unread notice in this inbox' }, '/social/teams': { label: '1 unread notice in this inbox' },
  });
});
test('foreign actors/tenants, hidden doors, unsafe actions and unknown activity produce no marker', () => {
  assert.deepEqual(navigationActivity(scope, [notice('other-dm', 'social:dm:u-a:u-b'), notice('external', 'social:ch:general', { action: { href: '//example.com/social/channels' } }), notice('boundary', 'unknown', { action: { href: '/social/channels-elsewhere' } }), notice('foreign', 'social:ch:general', { payload: { tenant: 'assessment' } }), notice('unknown', 'unknown')], empty), {});
  assert.deepEqual(navigationActivity({ ...scope, visiblePaths: ['/social/dms'] }, [notice('channel', 'social:ch:general')], empty), {});
  assert.deepEqual(navigationActivity({ ...scope, actorId: '' }, [notice('channel', 'social:ch:general')], empty), {});
});
test('safe explicit destinations keep records on their current visible tenant route', () => {
  const context = { tenant: 'assessment', actorId: 'u-reader', hasSocialGrant: false, visiblePaths: ['/assessment/teams', '/assessment/workspace'] };
  assert.deepEqual(navigationActivity(context, [{ id: 'team', payload: { tenant: 'assessment' }, action: { href: '/assessment/teams/TEAM-005?tab=documents' } }], empty), { '/assessment/teams': { label: '1 unread notice in this inbox' } });
});
test('communication notices require an existing Social grant; discussion and inbox labels keep their meanings', () => {
  const context = { tenant: 'orgiq', actorId: 'u-reader', hasSocialGrant: true, visiblePaths: ['/iq/projects', '/iq/communication'] };
  const notice = { id: 'social', payload: { tenant: 'social' }, action: { href: '/social/channels/general' } };
  const discussions = { threads: [], sections: { '/iq/projects': 2, '/iq/communication': 1 } };
  assert.deepEqual(navigationActivity(context, [notice], discussions), { '/iq/projects': { label: '2 conversations with unread messages' }, '/iq/communication': { label: '1 conversation with unread messages · 1 unread notice in this inbox' } });
  assert.deepEqual(navigationActivity({ ...context, hasSocialGrant: false }, [notice], empty), {});
  assert.deepEqual(navigationActivity(context, [
    { ...notice, id: 'other-member', channel: 'social:dm:u-a:u-b', action: { href: '/social/dms/social%3Adm%3Au-a%3Au-b' } },
    { ...notice, id: 'unknown-group', channel: 'social:dmg:hash', action: { href: '/social/dms/social%3Admg%3Ahash' } },
  ], empty), {});
  assert.deepEqual(navigationActivity(scope, [
    { ...notice, id: 'other-member-url', action: { href: '/social/dms/social%3Adm%3Au-a%3Au-b' } },
    { ...notice, id: 'unknown-group-url', action: { href: '/social/dms/social%3Admg%3Ahash' } },
  ], empty), {});
});
