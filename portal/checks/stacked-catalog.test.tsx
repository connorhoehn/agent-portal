// Run from portal: node --import ../middleware/node_modules/tsx/dist/loader.mjs --test checks/stacked-catalog.test.tsx
// Keep JSX rendering checks separate from the plain-Node source-model tests.
import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { StackedCatalogLayout } from '../src/components/shell/StackedCatalogLayout';

function render(path: string, basePath: string, selectedId?: string) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <StackedCatalogLayout
        title="Catalog" basePath={basePath} listTitle="Records"
        items={[{ path: `${basePath}?status=all`, label: 'All records', active: true }]}
        rows={[{ id: 'record-1', title: 'First record' }]}
        selectedId={selectedId} selectedTitle="Selected record"
        onSelect={() => {}}
      >
        <div data-testid="record-content">Record body</div>
      </StackedCatalogLayout>
    </MemoryRouter>,
  );
}

for (const basePath of ['/iq/designs', '/iq/library']) {
  test(`${basePath}: the section closes descendant rails and content`, () => {
    const html = render(`${basePath}?nav=section`, basePath);
    assert.match(html, /Catalog navigation/);
    assert.doesNotMatch(html, /data-testid="catalog-explorer"/);
    assert.doesNotMatch(html, /data-testid="record-content"/);
    assert.doesNotMatch(html, /<a[^>]*aria-current="page"/);
  });

  test(`${basePath}: a view opens its list beside the content`, () => {
    const html = render(`${basePath}?status=all`, basePath);
    assert.match(html, /data-testid="catalog-explorer"/);
    assert.match(html, /First record/);
    assert.match(html, /data-testid="record-content"/);
    assert.match(html, /href="[^\"]+\?nav=section"/);
  });
}

test('a selected design links back to its filtered list', () => {
  const html = render('/iq/designs/record-1?status=proposed', '/iq/designs', 'record-1');
  assert.match(html, /href="\/iq\/designs\?status=proposed"/);
  assert.match(html, /Selected record/);
});

test('a deep asset link keeps kind, tier and search on its list breadcrumb', () => {
  const html = render('/iq/library/record-1?kind=skill&tier=internal&q=auth', '/iq/library', 'record-1');
  assert.match(html, /href="\/iq\/library\?kind=skill&amp;tier=internal&amp;q=auth"/);
});
