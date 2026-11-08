// Run: node --import ../middleware/node_modules/tsx/dist/loader.mjs --test checks/initiative-work-table.test.tsx
import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { WorkTableView as InitiativeWorkTable, type WorkTableViewProps } from '@connorhoehn/ui-components';
import { InitiativesExplorer } from '../src/pages/projects/InitiativesExplorer';
import { WORK_GROUPS } from '../src/pages/project-detail/workListModel';

const props: WorkTableViewProps = {
  query: '', onQueryChange() {}, onOpenItem() {}, groups: WORK_GROUPS.map((group) => group.id === 'in_progress' ? { ...group, defaultOpen: true } : group),
  items: [
    { id: 'bug', title: 'Fix public contract', groupId: 'open', kindLabel: 'Bug', owner: { id: 'iv', name: 'Isabel Vasquez' }, points: 3 },
    { id: 'story', title: 'Publish typed contracts', groupId: 'in_progress', points: 5 },
    { id: 'done', title: 'Previous release', groupId: 'done', done: true },
  ],
};

test('full-width Work table has the mockup columns, counts, and expanded active groups', () => {
  const html = renderToStaticMarkup(<InitiativeWorkTable {...props} />);
  for (const label of ['Work item', 'Owner', 'Type', 'Points', '1 next up · 1 in progress · 1 done', 'Fix public contract', 'Publish typed contracts', '3 work items']) assert.ok(html.includes(label), label);
  assert.match(html, /aria-expanded="false"[^>]*>.*?Done/);
  assert.doesNotMatch(html, /Previous release/);
  assert.match(html, /aria-label="Open Fix public contract"/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test('write-capable roles keep their accessible completion controls', () => {
  const html = renderToStaticMarkup(<InitiativeWorkTable {...props} onToggleDone={() => {}} />);
  assert.match(html, /aria-label="Mark Fix public contract done"/);
});

test('loading and failed reads do not render invented counts or a stale table', () => {
  for (const state of [{ loading: true }, { error: 'Read unavailable' }]) {
    const html = renderToStaticMarkup(<InitiativeWorkTable {...props} {...state} />);
    assert.doesNotMatch(html, /<table|3 work items|1 next up/);
    assert.match(html, state.loading ? /Loading work/ : /Read unavailable/);
  }
});

test('filtered empties retain controls and explain the empty table', () => {
  const html = renderToStaticMarkup(<InitiativeWorkTable {...props} items={[]} count={3} emptyLabel="No work matches these filters" />);
  assert.match(html, /No work matches these filters/);
  assert.match(html, /Group work/);
  assert.doesNotMatch(html, /<table/);
});

test('the combined detail frame puts views and project rows in a single rail', () => {
  const html = renderToStaticMarkup(<MemoryRouter initialEntries={['/iq/projects/p-design-system-api?scope=all&tab=work']}>
    <InitiativesExplorer combinedNavigation scope="all" railTitle="All initiatives" railCount={14}
      rail={<div>Design System API</div>} railHeader={<input aria-label="Find an initiative" />}
      composer={<div data-testid="shared-composer" />}>
      <InitiativeWorkTable {...props} />
    </InitiativesExplorer>
  </MemoryRouter>);
  assert.equal((html.match(/data-testid="explorer-layout-rail"/g) ?? []).length, 1);
  assert.match(html, /aria-label="Initiative views"/);
  assert.match(html, /aria-current="page"/);
  assert.ok(html.indexOf('My initiatives') < html.indexOf('Find an initiative'));
  assert.match(html, /data-testid="shared-composer"/);
  assert.doesNotMatch(html, /initiative-work-explorer/);
});
