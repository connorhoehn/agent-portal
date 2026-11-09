import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAuditRoutes, matchesAuditLocation } from './ui-dom-audit.routes.ts';
import { staticInventory } from './route-inventory.ts';

test('table requirements belong to the URL that actually opens the table view', () => {
  const inventory = staticInventory();
  assert.equal(inventory.find(route => route.path === '/iq/work/findings')?.judges?.includes('table'), false);
  assert.equal(inventory.find(route => route.path === '/iq/work/findings?view=failed')?.judges?.includes('table'), true);
  assert.equal(inventory.find(route => route.path === '/iq/projects?scope=all&view=table')?.judges?.includes('table'), true);
});
const routes = [
  { path: '/pipelines/runs', source: 'static' },
  { path: '/pipelines/runs/seed', pattern: '/pipelines/runs/:id', source: 'param' },
  { path: '/iq/projects?view=table', source: 'static' },
  { path: '/iq/projects?view=cards', source: 'static' },
  { path: '/iq/projects/seed', pattern: '/iq/projects/:id', source: 'param' },
];
test('exact static path cannot pull adjacent detail routes', () => {
  assert.deepEqual(selectAuditRoutes(routes, '/pipelines/runs').map(r => r.path), ['/pipelines/runs']);
});
test('exact concrete record and query survive fixture resolution', () => {
  const [selected] = selectAuditRoutes(routes, '/iq/projects/actual?tab=work&item=wi-123');
  assert.equal(selected.path, '/iq/projects/actual?tab=work&item=wi-123');
  assert.equal(selected.auditPreservePath, true);
});
test('exact static query chooses matching inventory variant and remains exact', () => {
  const [selected] = selectAuditRoutes(routes, '/iq/projects?view=cards');
  assert.equal(selected.path, '/iq/projects?view=cards');
  assert.equal(selected.auditPreservePath, true);
});
test('absolute miss selects zero cases instead of broadening scope', () => {
  assert.deepEqual(selectAuditRoutes(routes, '/pipelines/run'), []);
});
test('explicit parameterized template retains normal fixture resolution', () => {
  const selected = selectAuditRoutes(routes, '/pipelines/runs/:id');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].path, '/pipelines/runs/seed');
  assert.equal(selected[0].auditPreservePath, undefined);
});
test('non-slash substring filter intentionally selects list and record', () => {
  assert.equal(selectAuditRoutes(routes, 'runs').length, 2);
});
test('colon in concrete query does not turn path into template selection', () => {
  const [selected] = selectAuditRoutes(routes, '/pipelines/runs?query=state:failed');
  assert.equal(selected.path, '/pipelines/runs?query=state:failed');
  assert.equal(selected.auditPreservePath, true);
});

test('route readiness preserves requested views and selections', () => {
  assert.equal(matchesAuditLocation('/pipelines/definitions?open=agent%3Aone', 'http://localhost/pipelines/definitions?open=agent%3Aone&sort=name'), true);
  assert.equal(matchesAuditLocation('/pipelines/definitions?open=agent%3Aone', '/pipelines/definitions'), false);
  assert.equal(matchesAuditLocation('/pipelines/communication?view=shared', '/pipelines/communication?view=chat'), false);
  assert.equal(matchesAuditLocation('/pipelines/runs?state=failed&state=running', '/pipelines/runs?state=failed'), false);
});
test('only the documented tenant root alias is allowed, including its query', () => {
  assert.equal(matchesAuditLocation('/pipelines?status=failed', '/pipelines/runs?status=failed'), true);
  assert.equal(matchesAuditLocation('/pipelines?status=failed', '/pipelines/runs'), false);
  assert.equal(matchesAuditLocation('/pipelines/configuration', '/pipelines/runs'), false);
});
test('every documented alias is an App.tsx index/Navigate door and nothing else redirects', () => {
  assert.equal(matchesAuditLocation('/iq', 'http://localhost/iq/work'), true);
  assert.equal(matchesAuditLocation('/assessment', '/assessment/teams'), true);
  assert.equal(matchesAuditLocation('/social', '/social/channels'), true);
  assert.equal(matchesAuditLocation('/admin/identity', '/admin/identity/roles'), true);
  assert.equal(matchesAuditLocation('/admin/observability', '/admin/observability/summary'), true);
  assert.equal(matchesAuditLocation('/iq/scores/compare', '/iq/scores'), true);
  assert.equal(matchesAuditLocation('/iq/decisions/d-aurora', '/iq/decisions/d-aurora'), true);
  // The alias target is exact: a door cannot certify a sibling page.
  assert.equal(matchesAuditLocation('/iq', '/iq/projects'), false);
  assert.equal(matchesAuditLocation('/admin/identity', '/admin/identity/users'), false);
  // Logging lands on Voice or its newest session, and nowhere else.
  assert.equal(matchesAuditLocation('/iq/logging', '/iq/logging/voice'), true);
  assert.equal(matchesAuditLocation('/iq/logging', '/iq/logging/voice/vs-123'), true);
  assert.equal(matchesAuditLocation('/pipelines/logging', '/pipelines/logging/voice/vs-123'), true);
  assert.equal(matchesAuditLocation('/iq/logging', '/iq/logging/agents/bot-runs/br-1'), false);
  assert.equal(matchesAuditLocation('/iq/logging', '/iq/work'), false);
  // An undocumented redirect still fails readiness.
  assert.equal(matchesAuditLocation('/iq/scores/cohorts', '/iq/scores'), false);
  assert.equal(matchesAuditLocation('/assessment/teams', '/assessment/teams/TEAM-001'), false);
});
