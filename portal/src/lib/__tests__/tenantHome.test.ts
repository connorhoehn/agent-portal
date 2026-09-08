// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// resolveHome() is the single answer to "where does this identity belong?".
// It is used by `/`, by the tenant switch, by NotFoundPage's home link, and —
// the reason it exists — by every route guard's fallback in App.tsx.
//
// The property that matters most: a guard's fallback must never resolve to a
// route inside the tree that guard protects. When it did, an assessment role
// who typed /iq/projects hit the guard, was redirected to /iq/projects, hit
// the guard again, and sat on a blank page under the orgiq breadcrumb with
// the URL never moving (assessment-journeys/isolation/DEFECTS.md #1).
//
// There is no sessionStorage under node, so hasChosenContext() returns false
// here — which is the interesting case: an un-chosen multi-workspace identity
// must land on the chooser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveHome, tenantHome, TENANT_HOME, CHOOSER } from '../tenantHome.ts';

type Session = Parameters<typeof resolveHome>[0];

function session(over: Partial<NonNullable<Session>>): Session {
  return {
    sub: 'u-test',
    name: 'Test',
    role: 'member',
    tenant: 'orgiq',
    grants: { orgiq: ['member'] },
    switchable: {},
    availableRoles: [],
    availableTenants: ['orgiq'],
    masquerading: null,
    ...over,
  } as NonNullable<Session>;
}

test('a single-workspace identity goes to its own tenant front door', () => {
  assert.equal(resolveHome(session({ tenant: 'orgiq', grants: { orgiq: ['member'] } })), '/iq/projects');
  assert.equal(
    resolveHome(session({ tenant: 'assessment', role: 'member', grants: { assessment: ['assessor'] } })),
    '/assessment/teams',
  );
});

test('an assessment identity is never sent into the orgiq tree', () => {
  const home = resolveHome(session({ tenant: 'assessment', grants: { assessment: ['assessor'] } }));
  assert.ok(!home.startsWith('/iq'), `assessment home must not be an orgiq route, got ${home}`);
  assert.ok(!home.startsWith('/admin'), `assessment home must not be an admin route, got ${home}`);
});

test('the orgiq home is not itself behind a role gate', () => {
  // /iq/projects is open to every orgiq role. If the home route ever moves to
  // a gated surface, a member refused there would bounce between two guards.
  assert.equal(TENANT_HOME.orgiq, '/iq/projects');
});

test('a multi-workspace identity that has not picked lands on the chooser', () => {
  const home = resolveHome(session({ grants: { orgiq: ['member'], assessment: ['assessor'] } }));
  assert.equal(home, CHOOSER);
});

test('a masquerading identity skips the chooser — the operator already chose', () => {
  const home = resolveHome(session({
    grants: { orgiq: ['member'], assessment: ['assessor'] },
    masquerading: { asUser: 'u-asha', actor: 'u-operator' },
  }));
  assert.equal(home, '/iq/projects');
});

test('an identity with no usable workspace gets the chooser, not a product page', () => {
  assert.equal(resolveHome(session({ grants: {} })), CHOOSER);
  assert.equal(resolveHome(null), CHOOSER);
});

test('a cross-tenant admin goes to the front door of the workspace it entered', () => {
  assert.equal(
    resolveHome(session({ role: 'admin', tenant: 'assessment', grants: { assessment: ['admin'] } })),
    '/assessment/teams',
  );
  assert.equal(
    resolveHome(session({ role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } })),
    '/iq/projects',
  );
});

test('tenantHome answers for the switch, and falls back to the chooser', () => {
  assert.equal(tenantHome('orgiq'), '/iq/projects');
  assert.equal(tenantHome('assessment'), '/assessment/teams');
  assert.equal(tenantHome('nope'), CHOOSER);
});

test('the tenant switch and `/` agree — one answer, not two', () => {
  for (const t of ['orgiq', 'assessment'] as const) {
    assert.equal(tenantHome(t), resolveHome(session({ tenant: t, grants: { [t]: ['x'] } })));
  }
});
