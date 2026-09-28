import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBuildNavActive } from '../buildNavigation.ts';
import { resolveBreadcrumbs } from '../breadcrumbResolve.ts';

test('run deep links select Runs without lighting Inbox or adjacent work views', () => {
  for (const path of ['/iq/work/job-123', '/iq/work/job-123/']) {
    assert.equal(isBuildNavActive('/iq/work/queue', path), true);
    assert.equal(isBuildNavActive('/iq/work', path), false);
    assert.equal(isBuildNavActive('/iq/work/changes', path), false);
  }
  for (const path of ['/iq/work/findings', '/iq/work/changes', '/iq/work']) assert.equal(isBuildNavActive('/iq/work/queue', path), false);
  assert.equal(isBuildNavActive('/iq/work', '/iq/work/'), true);
  assert.deepEqual(resolveBreadcrumbs('/iq/work/job-123').map((c) => c.label), ['Build', 'Automate', 'Runs', 'Run job-123']);
});

test('local compute menu follows view while preserving deeper selection', () => {
  assert.equal(isBuildNavActive('/iq/local-compute?view=machines', '/iq/local-compute', '?machine=node-1'), true);
  assert.equal(isBuildNavActive('/iq/local-compute?view=runs', '/iq/local-compute', '?view=runs&run=job-123'), true);
  assert.equal(isBuildNavActive('/iq/local-compute?view=machines', '/iq/local-compute', '?view=runs'), false);
  assert.equal(isBuildNavActive('/admin/bots', '/admin/bots/bot-1'), true);
});

test('Explore selects All by default and the chosen lens with unrelated graph state', () => {
  assert.equal(isBuildNavActive('/iq/explore?entities=all', '/iq/explore'), true);
  assert.equal(isBuildNavActive('/iq/explore?entities=people', '/iq/explore'), false);
  for (const lens of ['people', 'skills', 'projects', 'hierarchy', 'all']) {
    const search = `?entities=${lens}&layout=radial&selected=p1&detail=p1`;
    assert.equal(isBuildNavActive(`/iq/explore?entities=${lens}`, '/iq/explore', search), true);
    assert.equal(isBuildNavActive('/iq/explore?entities=other', '/iq/explore', search), false);
  }
});
