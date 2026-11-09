// UX walk, 9 November 2026, defect 1: a page this role cannot open says so in
// place and names the next step — switch, request, or ask — and the palette,
// rail and voice `open` agree with it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REQUESTABLE_ROLES, accessNextStep, noAccessReason, offerPage, roleOpens, rolesPhrase } from '../pageAccess.ts';
import { pageRefusal } from '../voice/tools.ts';
import { refusalNext } from '../voice/refusals.ts';

const PLATFORM = ['org-leader', 'hr-admin'];
const BOTS = ['sme', 'program-owner', 'org-leader', 'hr-admin'];
const BUILD = ['hr-admin'];
const DEMO = { role: 'member', tenant: 'orgiq', switchable: { orgiq: ['member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin'] } };
const THEO = { role: 'member', tenant: 'orgiq', switchable: { orgiq: ['member'], social: ['participant'] } };
const SIENNA = { role: 'member', tenant: 'orgiq', switchable: { orgiq: ['org-leader', 'member'] } };

test('a role that opens the page has no next step; admin passes every gate', () => {
  assert.equal(accessNextStep({ role: 'org-leader', tenant: 'orgiq' }, PLATFORM), null);
  assert.equal(accessNextStep({ role: 'admin', tenant: 'orgiq' }, BUILD), null);
  assert.equal(accessNextStep({ role: 'member', tenant: 'orgiq' }, undefined), null);
  assert.equal(roleOpens('member', []), true);
});

test('the session holds a role that opens it: switch to the least privileged one', () => {
  assert.deepEqual(accessNextStep(DEMO, PLATFORM), { kind: 'switch', role: 'org-leader', label: 'Switch to org-leader' });
  assert.deepEqual(accessNextStep(DEMO, BOTS), { kind: 'switch', role: 'sme', label: 'Switch to sme' });
  assert.deepEqual(accessNextStep(DEMO, BUILD), { kind: 'switch', role: 'hr-admin', label: 'Switch to hr-admin' });
  assert.equal(accessNextStep(SIENNA, PLATFORM)?.kind, 'switch');
});

test('nothing to switch to: request the least privileged requestable role, unless the viewer cannot file', () => {
  assert.deepEqual(accessNextStep(THEO, BOTS), { kind: 'request', role: 'sme', itemId: 'role:orgiq:sme', label: 'Request sme access' });
  assert.deepEqual(accessNextStep(THEO, PLATFORM), { kind: 'request', role: 'org-leader', itemId: 'role:orgiq:org-leader', label: 'Request org-leader access' });
  assert.deepEqual(accessNextStep(THEO, PLATFORM, { canRequest: false }), { kind: 'ask', label: 'Ask an org-leader for org-leader or hr-admin' });
});

test('nothing requestable opens it: ask an org-leader', () => {
  assert.deepEqual(accessNextStep(THEO, BUILD), { kind: 'ask', label: 'Ask an org-leader for hr-admin' });
  assert.deepEqual(accessNextStep(THEO, ['hr-admin', 'program-owner']), { kind: 'ask', label: 'Ask an org-leader for program-owner or hr-admin' });
});

test('palette and rail offer a gated page only when the session can switch into it', () => {
  assert.deepEqual(offerPage(THEO, PLATFORM), { offer: false, switchTo: null });
  assert.deepEqual(offerPage(DEMO, PLATFORM), { offer: true, switchTo: 'org-leader' });
  assert.deepEqual(offerPage({ role: 'org-leader', tenant: 'orgiq' }, PLATFORM), { offer: true, switchTo: null });
  assert.deepEqual(offerPage(null, PLATFORM), { offer: false, switchTo: null });
});

test('copy: the roles least privileged first, the reason naming the page and the current role', () => {
  assert.equal(rolesPhrase(['hr-admin', 'org-leader', 'admin']), 'org-leader or hr-admin');
  assert.equal(rolesPhrase(BOTS), 'sme, program-owner, org-leader or hr-admin');
  assert.equal(noAccessReason('Budgets', 'member', ['org-leader', 'hr-admin', 'program-owner']), 'Budgets opens for program-owner, org-leader or hr-admin; you are signed in as member.');
});

test('the requestable roles mirror the Access catalog seed (middleware/src/mock/access-catalog.ts)', () => {
  const src = readFileSync(new URL('../../../../middleware/src/mock/access-catalog.ts', import.meta.url), 'utf8');
  const seeded: Record<string, string[]> = {};
  for (const m of src.matchAll(/role\('([a-z]+)', '([a-z-]+)'/g)) (seeded[m[1]!] ??= []).push(m[2]!);
  assert.deepEqual(Object.fromEntries(Object.entries(REQUESTABLE_ROLES).map(([t, r]) => [t, [...r]])), seeded);
});

test('voice open refuses with the same next step, coded as a role refusal', () => {
  const budgets = { label: 'Budgets', path: '/admin/budgets', tenant: 'admin', roles: ['program-owner', 'org-leader', 'hr-admin'], pageId: 'budgets' };
  const sw = pageRefusal(budgets, { tenant: 'orgiq', role: 'member', switchable: DEMO.switchable.orgiq }).output;
  assert.equal(sw['code'], 'role');
  assert.equal(sw['switchRole'], 'program-owner');
  assert.match(String(sw['reason']), /^Budgets opens for program-owner, org-leader or hr-admin; you are signed in as member\. You also hold program-owner here/);
  assert.match(refusalNext('open', sw, { tenant: 'orgiq' }), /switch to program-owner from the header's role menu/);

  const scores = { label: 'Scores', path: '/iq/scores', tenant: 'orgiq', roles: PLATFORM, pageId: 'scores' };
  const rq = pageRefusal(scores, { tenant: 'orgiq', role: 'member', switchable: ['member'] }).output;
  assert.equal(rq['requestItemId'], 'role:orgiq:org-leader');
  assert.match(refusalNext('open', rq, { tenant: 'orgiq' }), /role:orgiq:org-leader/);

  const identity = { label: 'Identity', path: '/admin/identity', tenant: 'admin', roles: BUILD, pageId: 'identity' };
  const ask = pageRefusal(identity, { tenant: 'orgiq', role: 'member', switchable: null }).output;
  assert.equal(ask['reason'], 'Identity opens for hr-admin; you are signed in as member. Ask an org-leader for hr-admin.');
});
