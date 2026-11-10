// Run with:  cd portal && node --test src/pages/social/__tests__/profileModel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_STATUS_OPTIONS, initialStatus, profileUnavailableReason, roleLine, statusMessageValue } from '../profileModel.ts';

test('status can be set only with a Social grant, a gateway and a connected presence entry; each refusal says why', () => {
  assert.match(profileUnavailableReason({ hasSocialGrant: false, gatewayConfigured: true, presenceReady: true })!, /no Social access/);
  assert.match(profileUnavailableReason({ hasSocialGrant: true, gatewayConfigured: false, presenceReady: false })!, /realtime gateway/);
  assert.match(profileUnavailableReason({ hasSocialGrant: true, gatewayConfigured: true, presenceReady: false })!, /Connecting/);
  assert.equal(profileUnavailableReason({ hasSocialGrant: true, gatewayConfigured: true, presenceReady: true }), null);
});

test('do not disturb is the busy status, and no option names an internal lane', () => {
  assert.equal(PROFILE_STATUS_OPTIONS.find((o) => o.label === 'Do not disturb')?.value, 'busy');
  for (const o of PROFILE_STATUS_OPTIONS) assert.doesNotMatch(`${o.label} ${o.description}`, /\blane\b|coming/i);
});

test('the page starts from what peers see, and the status line is trimmed, capped and cleared when empty', () => {
  assert.equal(initialStatus({ idle: true }), 'away');
  assert.equal(initialStatus(null), 'online');
  assert.equal(statusMessageValue('   '), null);
  assert.equal(statusMessageValue('  out today '), 'out today');
  assert.equal(statusMessageValue('x'.repeat(200))!.length, 120);
  assert.equal(roleLine('community-admin'), 'Community admin in Social');
  assert.equal(roleLine(null), 'No Social role');
});
