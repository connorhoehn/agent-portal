// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// DE-29: the portal's tenant lists now come from tenants/manifest.json via
// ../tenants.generated.ts. The literals here are the hand-kept values before
// the switch (2026-10-29): the five existing tenants keep their order, front
// doors, labels and flags. A new tenant changes this file on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TENANTS, TENANT_DISPLAY_NAMES, TENANT_MANIFEST, ROLES_BY_TENANT, CROSS_TENANT_ROLES } from '../tenants.generated.ts';
import { TENANT_HOME, tenantHome } from '../tenantHome.ts';
import { tenantEnabled } from '../features.ts';
import { DISCUSSION_TENANTS } from '../../components/shell/discussionUnreadModel.ts';

const manifest = JSON.parse(readFileSync(new URL('../../../../tenants/manifest.json', import.meta.url), 'utf8')) as {
  tenants: Array<{ id: string; displayName: string; home: string; portalRoot: string; roles: string[] }>;
};

test('tenant order and the switcher/masquerade labels are unchanged', () => {
  assert.deepEqual([...TENANTS], ['orgiq', 'assessment', 'social', 'pipelines', 'access']);
  assert.deepEqual({ ...TENANT_DISPLAY_NAMES }, { orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines', access: 'Access' });
  // TenantSwitcher walks Object.keys(LABELS): that order is the switcher's tile order.
  assert.deepEqual(Object.keys(TENANT_DISPLAY_NAMES), [...TENANTS]);
});

test('front doors are unchanged', () => {
  assert.deepEqual(TENANT_HOME, {
    orgiq: '/iq/projects',
    assessment: '/assessment/teams',
    social: '/social/channels',
    pipelines: '/pipelines/runs',
    access: '/access/requests',
  });
  assert.equal(tenantHome('nope'), '/workspaces');
});

test('every tenant is enabled with no VITE_ENABLE_* set; unknown ids stay enabled', () => {
  for (const t of TENANTS) assert.equal(tenantEnabled(t), true, t);
  assert.equal(tenantEnabled('admin'), true);
  assert.deepEqual(TENANTS.map(t => TENANT_MANIFEST[t].featureFlag),
    [null, 'VITE_ENABLE_ASSESSMENT', 'VITE_ENABLE_SOCIAL', 'VITE_ENABLE_PIPELINES', 'VITE_ENABLE_ACCESS']);
});

test('discussion tenants are unchanged', () => {
  assert.deepEqual([...DISCUSSION_TENANTS], ['orgiq', 'assessment', 'pipelines']);
});

test('the authz log filters gain access and keep the orgiq role list', () => {
  assert.deepEqual(['', ...TENANTS], ['', 'orgiq', 'assessment', 'social', 'pipelines', 'access']);
  assert.deepEqual(['', ...ROLES_BY_TENANT.orgiq, ...CROSS_TENANT_ROLES], ['', 'member', 'sme', 'program-owner', 'org-leader', 'hr-admin', 'admin']);
});

test('the generated copy matches tenants/manifest.json', () => {
  assert.deepEqual([...TENANTS], manifest.tenants.map(t => t.id));
  for (const t of manifest.tenants) {
    const g = TENANT_MANIFEST[t.id as keyof typeof TENANT_MANIFEST];
    assert.equal(g.displayName, t.displayName);
    assert.equal(g.home, t.home);
    assert.equal(g.portalRoot, t.portalRoot);
  }
});
