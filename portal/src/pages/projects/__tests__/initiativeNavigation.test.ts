import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initiativeBreadcrumbs, initiativeHref, initiativeListHref, landingScope } from '../initiativeNavigation.ts';

const search = new URLSearchParams('scope=all&q=auth&status=active&sort=name&tab=work&item=work-1&view=history&wq=fix');

test('list parent retains filters but closes project and work selections', () => {
  assert.equal(initiativeListHref(search, 'all'), '/iq/projects?scope=all&q=auth&status=active&sort=name');
});

test('project and work parents clear only their descendants', () => {
  assert.equal(initiativeHref('p-auth', search, 'all'), '/iq/projects/p-auth?scope=all&q=auth&status=active&sort=name');
  assert.equal(initiativeHref('p-auth', search, 'all', 'work'), '/iq/projects/p-auth?scope=all&q=auth&status=active&sort=name&tab=work');
});

test('Agent output stays visible when moving through initiative content', () => {
  const params = new URLSearchParams('pane=agent&paneRecord=run:old&item=wi-old&tab=work&scope=all');
  assert.equal(initiativeHref('p-auth', params, 'all'), '/iq/projects/p-auth?scope=all&pane=agent');
  assert.equal(initiativeListHref(params, 'all'), '/iq/projects?scope=all');
});

test('work trail names every level and links to each parent', () => {
  const trail = initiativeBreadcrumbs({ search, scope: 'all', project: { id: 'p-auth', name: 'Auth Migration' }, tab: 'work', item: 'Migrate users' });
  assert.deepEqual(trail.map((c) => c.label), ['Plan', 'Initiatives', 'Auth Migration', 'Work', 'Migrate users']);
  assert.equal(trail[1].href, initiativeListHref(search, 'all'));
  assert.equal(trail[2].href, initiativeHref('p-auth', search, 'all'));
  assert.equal(trail[3].href, initiativeHref('p-auth', search, 'all', 'work'));
  assert.equal(trail[4].href, undefined);
});

test('every project tab keeps the same ancestors', () => {
  for (const tab of ['work', 'decisions', 'agents', 'contributors']) {
    const trail = initiativeBreadcrumbs({ search, scope: 'mine', project: { id: 'p-auth', name: 'Auth Migration' }, tab });
    assert.deepEqual(trail.slice(0, 4).map((c) => c.label), ['Plan', 'Initiatives', 'My initiatives', 'Auth Migration']);
    assert.equal(trail.at(-1)?.href, undefined);
  }
});

test('sprint parent retains its scope and window but clears selection', () => {
  const params = new URLSearchParams('lens=sprints&sprint=s1&sprintScope=mine&sprintWindow=any');
  const trail = initiativeBreadcrumbs({ search: params, scope: 'mine', sprints: true, sprint: 'Sprint 12' });
  assert.deepEqual(trail.map((c) => c.label), ['Plan', 'Initiatives', 'Sprints', 'Sprint 12']);
  assert.equal(trail[2].href, '/iq/projects?lens=sprints&sprintScope=mine&sprintWindow=any');
});

test('the section landing defaults to All initiatives, never a placeholder', () => {
  assert.equal(landingScope(new URLSearchParams('nav=section')), 'all');
  assert.equal(landingScope(new URLSearchParams('nav=section&scope=mine')), null);
  assert.equal(landingScope(new URLSearchParams('nav=section&lens=sprints')), null);
  assert.equal(landingScope(new URLSearchParams('')), null);
});
