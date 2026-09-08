// Run with:  cd portal && node --test 'src/pages/identity/__tests__/*.test.ts'
//
// Plain node:test — identityFormat.ts is pure TypeScript (no DOM, no
// fetch), so Node's type-stripping loader runs it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decisionTone, effectTone, grantChipLabels, inputWiring, matrixActions, rolesForTenantMap, tenantIdProblem, tenantUserCount, toggleGrantSet, truncateId } from '../identityFormat.ts';

test('inputWiring strips labelId but keeps the rest', () => {
  const wiring = { id: 'f-1', labelId: 'f-1-label', 'aria-describedby': 'f-1-desc', 'aria-invalid': undefined };
  const result = inputWiring(wiring);
  assert.deepEqual(result, { id: 'f-1', 'aria-describedby': 'f-1-desc', 'aria-invalid': undefined });
  assert.ok(!('labelId' in result));
});

test('matrixActions prefers the live schema, sorted', () => {
  assert.deepEqual(
    matrixActions(['Search', 'ManageBudgets'], [{ capabilities: ['Search'] }]),
    ['ManageBudgets', 'Search'],
  );
});

test('matrixActions falls back to the union of role capabilities when the schema is empty', () => {
  assert.deepEqual(
    matrixActions([], [{ capabilities: ['Search', 'ViewSalary'] }, { capabilities: ['Search'] }]),
    ['Search', 'ViewSalary'],
  );
});

test('matrixActions is empty when both the schema and the roles are empty', () => {
  assert.deepEqual(matrixActions([], []), []);
});

test('rolesForTenantMap includes a tenant\'s own roles plus cross-tenant roles', () => {
  const tenants = [{ id: 'orgiq' }, { id: 'assessment' }];
  const roles = [
    { id: 'member', tenant: 'orgiq' },
    { id: 'sme', tenant: 'orgiq' },
    { id: 'assessor', tenant: 'assessment' },
    { id: 'admin', tenant: null },
  ];
  const map = rolesForTenantMap(tenants, roles);
  assert.deepEqual(map.get('orgiq')?.map(r => r.id), ['member', 'sme', 'admin']);
  assert.deepEqual(map.get('assessment')?.map(r => r.id), ['assessor', 'admin']);
});

test('grantChipLabels flattens a tenant->roles map into "tenant/role" pairs', () => {
  assert.deepEqual(
    grantChipLabels({ orgiq: ['member', 'org-leader'], assessment: [] }),
    ['orgiq/member', 'orgiq/org-leader'],
  );
});

test('grantChipLabels is empty for no grants', () => {
  assert.deepEqual(grantChipLabels({}), []);
});

test('tenantUserCount counts users with at least one role in the tenant', () => {
  const users: Array<{ grants: Record<string, string[]> }> = [
    { grants: { orgiq: ['member'] } },
    { grants: { orgiq: [] } },
    { grants: { assessment: ['assessor'] } },
  ];
  assert.equal(tenantUserCount('orgiq', users), 1);
  assert.equal(tenantUserCount('assessment', users), 1);
  // A tenant nobody belongs to. Deliberately a made-up id, not a real tenant
  // and not a deleted one: naming a dead tenant reads as if it still existed.
  assert.equal(tenantUserCount('nobody-here', users), 0);
});

test('toggleGrantSet adds a role not yet held', () => {
  assert.deepEqual(toggleGrantSet({}, 'orgiq', 'member'), { orgiq: ['member'] });
});

test('toggleGrantSet removes a role already held, dropping the tenant key when empty', () => {
  assert.deepEqual(toggleGrantSet({ orgiq: ['member'] }, 'orgiq', 'member'), {});
});

test('toggleGrantSet leaves other tenants untouched', () => {
  const next = toggleGrantSet({ orgiq: ['member'], assessment: ['assessor'] }, 'orgiq', 'org-leader');
  assert.deepEqual(next, { orgiq: ['member', 'org-leader'], assessment: ['assessor'] });
});

test('decisionTone: an error is always danger, ALLOW is success, DENY is danger', () => {
  assert.equal(decisionTone('ALLOW', false), 'success');
  assert.equal(decisionTone('DENY', false), 'danger');
  assert.equal(decisionTone(undefined, false), 'danger');
  assert.equal(decisionTone('ALLOW', true), 'danger');
});

test('effectTone maps Cedar effects to chip tones', () => {
  assert.equal(effectTone('permit'), 'success');
  assert.equal(effectTone('forbid'), 'danger');
});

test('truncateId leaves short ids alone and ellipsizes long ones', () => {
  assert.equal(truncateId('short'), 'short');
  assert.equal(truncateId('a-very-long-policy-id-123'), 'a-very-long-…');
  assert.equal(truncateId('exactly12chr'), 'exactly12chr');
});

test('tenantIdProblem says what the server would refuse, in the label\'s own terms', () => {
  assert.equal(tenantIdProblem('assessment'), null);
  assert.equal(tenantIdProblem('field-ops2'), null);
  // The exact string the audit typed: spaces AND uppercase, Create was enabled.
  assert.match(tenantIdProblem('   audit probe TENANT') ?? '', /space/i);
  assert.match(tenantIdProblem('Assessment') ?? '', /lowercase/i);
  assert.match(tenantIdProblem('2fast') ?? '', /letter/i);
  assert.match(tenantIdProblem('a') ?? '', /2 and 31/);
  assert.match(tenantIdProblem('a'.repeat(32)) ?? '', /2 and 31/);
  assert.match(tenantIdProblem('has_underscore') ?? '', /hyphens only/i);
  assert.match(tenantIdProblem('') ?? '', /required/i);
  // Everything it accepts, the server's own regex must accept too.
  for (const ok of ['assessment', 'orgiq', 'field-ops', 'a1', 'a-b-c-9']) {
    assert.equal(tenantIdProblem(ok), null, ok);
    assert.ok(/^[a-z][a-z0-9-]{1,30}$/.test(ok), `server would reject ${ok}`);
  }
});
