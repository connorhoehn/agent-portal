// The in-page role switch, once per page for the demo identity (UX leftovers, 10 November).
//
// The cookie-less demo identity's `switchable` is every role, so every locked
// control offered "Switch to <role>". On in-page controls the first locked
// control carries the offer and the others give their plain reason; a real
// persona, whose switchable roles are grants it holds, is unaffected.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEMO_SUB, SwitchOfferSlots, offerOnThisControl, permissiveSwitchable, roleSwitchOffer } from '../roleSwitchOffer.ts';

const DEMO = { sub: DEMO_SUB, role: 'member', tenant: 'orgiq', switchable: { orgiq: ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'] } };
const SIENNA = { sub: 'u-release', role: 'member', tenant: 'orgiq', switchable: { orgiq: ['org-leader', 'member'] } };

test('only the demo identity counts as permissive; a real persona does not', () => {
  assert.equal(permissiveSwitchable(DEMO), true);
  assert.equal(permissiveSwitchable(SIENNA), false);
  assert.equal(permissiveSwitchable(null), false);
  assert.equal(roleSwitchOffer(DEMO, 'see budgets')?.label, 'Switch to org-leader to see budgets', 'the offer itself is unchanged');
});

test('the demo identity sees the switch on the first locked control only; the rest get the plain reason', () => {
  const slots = new SwitchOfferSlots();
  slots.claim('/iq/projects', 'budget');
  slots.claim('/iq/projects', 'files');
  slots.claim('/iq/projects', 'budget'); // a re-render claims nothing new
  const on = (c: string) => offerOnThisControl(DEMO, slots.claimants('/iq/projects'), c);
  assert.deepEqual([on('budget'), on('files')], [true, false]);
  // The first control goes away: the next one inherits the offer.
  slots.release('/iq/projects', 'budget');
  assert.deepEqual([on('budget'), on('files')], [false, true]);
});

test('a real persona keeps the offer on every locked control', () => {
  assert.equal(offerOnThisControl(SIENNA, ['budget', 'files'], 'files'), true);
  assert.equal(offerOnThisControl(SIENNA, [], 'files'), true, 'no claim needed');
});

test('pages are separate, snapshots are stable, and listeners hear each change', () => {
  const slots = new SwitchOfferSlots();
  let heard = 0;
  const off = slots.subscribe(() => { heard++; });
  slots.claim('/a', 'x');
  const snap = slots.claimants('/a');
  assert.equal(slots.claimants('/a'), snap, 'same array until the list changes');
  assert.deepEqual(slots.claimants('/b'), []);
  slots.claim('/a', 'x');
  slots.release('/a', 'y');
  assert.equal(heard, 1, "a repeat claim or a stranger's release is no change");
  slots.release('/a', 'x');
  assert.deepEqual(slots.claimants('/a'), []);
  off();
  slots.claim('/a', 'z');
  assert.equal(heard, 2);
});
