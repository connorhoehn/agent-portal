import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBreadcrumbs } from '../breadcrumbResolve.ts';

// Every shell-rail path (Layout.tsx NAV_ITEMS) plus the routes the rails open.
// A route that resolves to fewer than two crumbs renders NO trail, and the
// header rhythm (title 16px under the trail) breaks on that page alone.
const RAIL_PATHS = [
  '/iq/projects', '/iq/projects/p-observability', '/iq/sprints', '/iq/work', '/iq/work/findings', '/iq/work/queue',
  '/iq/distillation', '/iq/distillation/overview', '/iq/local-compute', '/iq/invoke', '/iq/explore', '/iq/scores', '/iq/scores/cohorts',
  '/iq/library', '/iq/library/lib-stakeholder-email', '/iq/promotions', '/iq/designs', '/iq/designs/dr-1',
  '/iq/release', '/iq/agents', '/iq/prompts', '/iq/history', '/iq/diff', '/iq/evaluations', '/iq/canary', '/iq/prompt-ops',
  '/admin/budgets', '/admin/projects', '/admin/devbox', '/admin/observability', '/admin/observability/invocations',
  '/admin/knowledge', '/admin/capabilities', '/admin/identity', '/admin/identity/users', '/admin/bots', '/admin/changes',
  '/assessment/teams', '/assessment/teams/t-1', '/assessment/submissions', '/assessment/reports', '/assessment/feedback',
  '/assessment/enterprise', '/assessment/workspace', '/assessment/prompts', '/assessment/rules', '/assessment/runs',
  '/assessment/configuration',
  '/social/channels', '/social/dms', '/social/calls', '/social/rooms', '/social/contacts', '/social/teams',
  '/social/recordings', '/social/configuration',
  '/pipelines/definitions', '/pipelines/runbooks', '/pipelines/runs', '/pipelines/approvals', '/pipelines/artifacts',
  '/pipelines/agents', '/pipelines/bots', '/pipelines/commands', '/pipelines/configuration',
  '/settings',
];

test('every rail path resolves to a section and a page', () => {
  for (const path of RAIL_PATHS) {
    const crumbs = resolveBreadcrumbs(path);
    assert.ok(crumbs.length >= 2, `${path} → ${JSON.stringify(crumbs)}`);
  }
});

test('configuration lives beneath Local compute, including its legacy address', () => {
  for (const path of ['/iq/local-compute/configuration', '/iq/release']) {
    assert.deepEqual(resolveBreadcrumbs(path).map((c) => c.label), ['Build', 'Local compute', 'Configuration']);
    assert.equal(resolveBreadcrumbs(path)[1]?.path, '/iq/local-compute');
  }
});

test('the Design rail pages sit under Design, and a library asset gets a third crumb', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/library').map((c) => c.label), ['Build', 'Agent library']);
  assert.deepEqual(resolveBreadcrumbs('/iq/promotions').map((c) => c.label), ['Build', 'Distillation', 'Review', 'Asset promotions']);
  assert.equal(resolveBreadcrumbs('/iq/library/lib-stakeholder-email')[1]!.path, '/iq/library');
});

test('entity crumbs carry the id so a mounted page can supply the title', () => {
  const cases: Array<[string, string]> = [
    ['/iq/designs/des-auth-rotation', 'des-auth-rotation'],
    ['/iq/library/lib-stakeholder-email', 'lib-stakeholder-email'],
    ['/iq/work/job-0123456789abcdef', 'job-0123456789abcdef'],
    ['/admin/bots/bot-nightly-lint', 'bot-nightly-lint'],
  ];
  for (const [path, id] of cases) {
    const last = resolveBreadcrumbs(path).at(-1);
    assert.equal(last?.id, id, `${path} → ${JSON.stringify(last)}`);
  }
});
