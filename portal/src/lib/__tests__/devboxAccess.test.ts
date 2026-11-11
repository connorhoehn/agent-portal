// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// `MachinePresenceMenu` renders this action as "Open Computer Lab" and the
// portal wired it to `/iq/local-compute` — a different page. Standing on Local
// compute (where you are the moment you have paired a machine) clicking it
// navigated to the route already open, so nothing happened at all.
//
// Computer Lab is where a machine belongs: LocalMachinesLab renders the paired
// laptops beside the microVM fleet, with presence, what each is running, and a
// tailable log.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPUTER_LAB_PATH,
  FLEET_READ_ROLES,
  LOCAL_COMPUTE_PATH,
  canOpenComputerLab,
} from '../devboxAccess.ts';

test('both destinations are the one Computers page', () => {
  assert.equal(COMPUTER_LAB_PATH, LOCAL_COMPUTE_PATH);
  assert.equal(COMPUTER_LAB_PATH, '/iq/computers');
});

test('the write capability opens the Lab whatever the role', () => {
  assert.equal(canOpenComputerLab(true, 'member'), true);
  assert.equal(canOpenComputerLab(true, null), true);
});

test('the server read tier opens the Lab without the write capability', () => {
  for (const role of FLEET_READ_ROLES) {
    assert.equal(canOpenComputerLab(false, role), true, `${role} should reach Computer Lab read-only`);
  }
});

test('org-leader specifically — the role devbox-visibility treats as fleet-wide', () => {
  // This is the regression the whole nav-parity validator was built around:
  // org-leader sees every computer server-side and could not open the page.
  assert.equal(canOpenComputerLab(false, 'org-leader'), true);
});

test('a role with neither gets sent to Local compute, not bounced off RequireRole', () => {
  assert.equal(canOpenComputerLab(false, 'member'), false);
  assert.equal(canOpenComputerLab(false, undefined), false);
});
