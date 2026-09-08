import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBreadcrumbs } from '../breadcrumbResolve.ts';

// Every shell-rail path (Layout.tsx NAV_ITEMS) plus the routes the rails open.
// A route that resolves to fewer than two crumbs renders NO trail, and the
// header rhythm (title 16px under the trail) breaks on that page alone.
const RAIL_PATHS = [
  '/iq/projects', '/iq/projects/p-observability', '/iq/sprints', '/iq/work', '/iq/work/findings', '/iq/work/queue',
  '/iq/distillation', '/iq/distillation/overview', '/iq/invoke', '/iq/explore', '/iq/scores', '/iq/scores/cohorts',
  '/iq/library', '/iq/library/lib-stakeholder-email', '/iq/promotions', '/iq/designs', '/iq/designs/dr-1',
  '/iq/release', '/iq/agents', '/iq/prompts', '/iq/history', '/iq/diff', '/iq/evaluations', '/iq/canary', '/iq/prompt-ops',
  '/admin/budgets', '/admin/projects', '/admin/devbox', '/admin/observability', '/admin/observability/invocations',
  '/admin/knowledge', '/admin/capabilities', '/admin/identity', '/admin/identity/users', '/admin/bots', '/admin/changes',
  '/assessment/teams', '/assessment/teams/t-1', '/assessment/submissions', '/assessment/reports', '/assessment/feedback',
  '/assessment/enterprise', '/assessment/workspace', '/assessment/prompts', '/assessment/rules', '/assessment/runs',
  '/assessment/configuration', '/settings',
];

test('every rail path resolves to a section and a page', () => {
  for (const path of RAIL_PATHS) {
    const crumbs = resolveBreadcrumbs(path);
    assert.ok(crumbs.length >= 2, `${path} → ${JSON.stringify(crumbs)}`);
  }
});

test('the Design rail pages sit under Design, and a library asset gets a third crumb', () => {
  assert.deepEqual(resolveBreadcrumbs('/iq/library').map((c) => c.label), ['Design', 'Library']);
  assert.deepEqual(resolveBreadcrumbs('/iq/promotions').map((c) => c.label), ['Design', 'Promotions']);
  assert.equal(resolveBreadcrumbs('/iq/library/lib-stakeholder-email')[1]!.path, '/iq/library');
});
