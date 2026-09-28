// Run: node --import ../middleware/node_modules/tsx/dist/loader.mjs --test checks/initiative-stack.test.tsx
import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { InitiativesExplorer } from '../src/pages/projects/InitiativesExplorer';
import { initiativeBreadcrumbs } from '../src/pages/projects/initiativeNavigation';

function render(path: string, tab?: string) {
  const search = new URLSearchParams(path.split('?')[1]);
  const sprints = search.get('lens') === 'sprints';
  return renderToStaticMarkup(<MemoryRouter initialEntries={[path]}>
    <InitiativesExplorer scope="all" lens={sprints ? 'sprints' : 'initiatives'}
      railTitle={sprints ? 'Sprints' : 'All initiatives'}
      rail={<div data-testid="parent-list">Parent list</div>}
      breadcrumbs={initiativeBreadcrumbs({ search, scope: 'all', sprints,
        ...(tab ? { project: { id: 'p-auth', name: 'Auth Migration' }, tab } : {}),
        ...(search.has('item') ? { item: 'Selected work' } : {}),
      })}>
      <div data-testid="content">Detail</div>
    </InitiativesExplorer>
  </MemoryRouter>);
}

test('the section parent closes descendant lists and content', () => {
  const html = render('/iq/projects?nav=section');
  assert.match(html, /aria-label="Initiative views"/);
  assert.doesNotMatch(html, /data-testid="parent-list"/);
  assert.doesNotMatch(html, /data-testid="content"/);
});

for (const tab of ['overview', 'work', 'decisions', 'agents', 'contributors']) {
  test(`${tab} keeps both the view navigation and parent list`, () => {
    const html = render(`/iq/projects/p-auth?scope=all&tab=${tab}`, tab);
    assert.match(html, /aria-label="Initiative views"/);
    assert.match(html, /data-testid="parent-list"/);
    assert.match(html, /<a aria-current="page"[^>]*href="\/iq\/projects\?scope=all"/);
    assert.match(html, /Auth Migration/);
  });
}

test('all work-item ancestors remain visible and linked, never collapsed to an ellipsis', () => {
  const html = render('/iq/projects/p-auth?scope=all&tab=work&item=w1', 'work');
  const trail = html.match(/<nav[^>]*data-testid="initiative-breadcrumbs".*?<\/nav>/)?.[0] ?? '';
  for (const label of ['Plan', 'Initiatives', 'All initiatives', 'Auth Migration', 'Work', 'Selected work']) assert.ok(trail.includes(label), label);
  assert.doesNotMatch(trail, /More items/);
});

test('Sprints uses the same navigation and list frame', () => {
  const html = render('/iq/projects?lens=sprints');
  assert.match(html, /<a aria-current="page"[^>]*href="\/iq\/projects\?lens=sprints"/);
  assert.match(html, /data-testid="parent-list"/);
});
