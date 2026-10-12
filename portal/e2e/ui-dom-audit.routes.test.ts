import assert from 'node:assert/strict';
import test from 'node:test';
import { selectAuditRoutes } from './ui-dom-audit.routes.ts';
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
