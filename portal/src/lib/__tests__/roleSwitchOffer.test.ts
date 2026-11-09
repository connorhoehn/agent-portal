// G58: held-but-inactive roles. Sienna Garcia holds orgiq org-leader and
// member and lands as member (landingRole, by design); a decision waiting on
// someone else, or the Docs tab's New, offers her the switch instead of a
// silent lock. Nothing when no higher grant is held or it is already worn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roleSwitchOffer } from '../roleSwitchOffer.ts';

const SIENNA = { role: 'member', tenant: 'orgiq', switchable: { orgiq: ['org-leader', 'member'], social: ['participant'] } };

test('a member who holds org-leader here is offered the switch, named for what it unlocks', () => {
  assert.deepEqual(roleSwitchOffer(SIENNA, 'decide'), { role: 'org-leader', label: 'Switch to org-leader to decide' });
  assert.deepEqual(roleSwitchOffer(SIENNA, 'add files'), { role: 'org-leader', label: 'Switch to org-leader to add files' });
});

test('org-leader is offered before admin; an admin grant alone is offered as admin', () => {
  assert.equal(roleSwitchOffer({ ...SIENNA, switchable: { orgiq: ['member', 'admin', 'org-leader'] } }, 'decide')?.role, 'org-leader');
  assert.deepEqual(roleSwitchOffer({ ...SIENNA, role: 'sme', switchable: { orgiq: ['sme', 'admin'] } }, 'add files'), { role: 'admin', label: 'Switch to admin to add files' });
});

test('nothing without such a grant in this tenant, or when it is already worn', () => {
  assert.equal(roleSwitchOffer({ ...SIENNA, switchable: { orgiq: ['member', 'sme', 'program-owner'] } }, 'decide'), null);
  assert.equal(roleSwitchOffer({ ...SIENNA, tenant: 'social' }, 'decide'), null, 'only the tenant in view counts');
  assert.equal(roleSwitchOffer({ ...SIENNA, role: 'org-leader' }, 'decide'), null, 'already acting as org-leader');
  assert.equal(roleSwitchOffer({ ...SIENNA, role: 'org-leader', switchable: { orgiq: ['org-leader', 'admin'] } }, 'add files')?.role, 'admin', 'an org-leader is offered admin only');
  assert.equal(roleSwitchOffer({ ...SIENNA, role: 'admin', switchable: { orgiq: ['org-leader', 'admin'] } }, 'decide'), null, 'admin is offered nothing');
  assert.equal(roleSwitchOffer({ role: 'member', tenant: 'orgiq', switchable: {} }, 'decide'), null);
  assert.equal(roleSwitchOffer(null, 'decide'), null, 'no session');
});
