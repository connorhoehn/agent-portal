import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showSocialTenantDoor, socialActivityPath, socialEntryTarget } from '../socialEntryModel.ts';

test('orgiq, assessment and pipelines open their Communication plane', () => {
  assert.deepEqual(socialEntryTarget({ tenant: 'orgiq', hasSocialGrant: true, pathname: '/iq/projects' }), { kind: 'navigate', path: '/iq/communication/channels' });
  assert.deepEqual(socialEntryTarget({ tenant: 'assessment', hasSocialGrant: true, pathname: '/assessment/runs' }), { kind: 'navigate', path: '/assessment/communication/channels' });
  assert.deepEqual(socialEntryTarget({ tenant: 'pipelines', hasSocialGrant: true, pathname: '/pipelines/runs' }), { kind: 'navigate', path: '/pipelines/communication/channels' });
});

test('the page\'s bound channel opens as the conversation', () => {
  assert.deepEqual(socialEntryTarget({ tenant: 'orgiq', hasSocialGrant: true, pageChannelSlug: 'auth team', pathname: '/iq/projects/p-1' }),
    { kind: 'navigate', path: '/iq/communication/channels/auth%20team' });
});

test('already inside the workspace stays put', () => {
  assert.deepEqual(socialEntryTarget({ tenant: 'orgiq', hasSocialGrant: true, pathname: '/iq/communication/dms/x' }), { kind: 'here' });
  assert.deepEqual(socialEntryTarget({ tenant: 'social', hasSocialGrant: true, pathname: '/social/channels/general' }), { kind: 'here' });
});

test('Social itself opens channels from elsewhere, even from another Social page', () => {
  assert.deepEqual(socialEntryTarget({ tenant: 'social', hasSocialGrant: true, pathname: '/social/people' }), { kind: 'navigate', path: '/social/channels' });
  assert.deepEqual(socialEntryTarget({ tenant: 'social', hasSocialGrant: true, pathname: '/settings' }), { kind: 'navigate', path: '/social/channels' });
});

test('no grant keeps the panel; an unknown tenant too', () => {
  assert.deepEqual(socialEntryTarget({ tenant: 'orgiq', hasSocialGrant: false, pathname: '/iq' }), { kind: 'panel' });
  assert.deepEqual(socialEntryTarget({ tenant: 'mystery', hasSocialGrant: true, pathname: '/' }), { kind: 'panel' });
});

test('the tenant door needs a grant and hides inside Social', () => {
  assert.equal(showSocialTenantDoor('orgiq', true), true);
  assert.equal(showSocialTenantDoor('orgiq', false), false);
  assert.equal(showSocialTenantDoor('social', true), false);
});

test('the footer bell\'s "See all activity" opens the workspace Activity view where one exists', () => {
  assert.equal(socialActivityPath('orgiq', true), '/iq/communication/channels?shelf=activity');
  assert.equal(socialActivityPath('social', true), '/social/channels?shelf=activity');
  assert.equal(socialActivityPath('orgiq', false), null);
  assert.equal(socialActivityPath('unknown', true), null);
});
