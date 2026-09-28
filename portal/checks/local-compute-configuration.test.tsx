// Run: node --import ../middleware/node_modules/tsx/dist/loader.mjs --test checks/local-compute-configuration.test.tsx
import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { BuildSectionLayout } from '../src/components/shell/BuildSectionLayout';
import { ConfigurationContents } from '../src/pages/local-compute/ConfigurationPage';
import type { SessionBundleDetail } from '../src/pages/release/types';
import type { LibraryResponse } from '../src/pages/library/types';

const bundle: SessionBundleDetail = {
  id: 'example', version: 'v12', status: 'live', publishedBy: 'Example author', publishedAt: '2026-09-01',
  appliesTo: ['fleet'], sessionsAffected: 2,
  skills: [{ id: 'skill-a', name: 'Example skill', description: 'A skill', version: '2', status: 'stale', source: 'library' }],
  hooks: [{ event: 'SessionStart', command: 'lab recall', enabled: true, description: 'Read memory' }],
  settings: { DISABLE_AUTOUPDATER: true },
};
const library = { assets: [{ id: 'skill-a', version: '3', description: 'Updated skill' }], total: 1 } as LibraryResponse;

function render(view: 'skills' | 'hooks' | 'settings' = 'skills', catalog: LibraryResponse | null = library) {
  return renderToStaticMarkup(<MemoryRouter initialEntries={['/iq/local-compute/configuration']}>
    <BuildSectionLayout title="Local compute" storageKey="test-local-compute" items={[
      { path: '/iq/local-compute?view=machines', label: 'Machines' },
      { path: '/iq/local-compute?view=runs', label: 'Runs' },
      { path: '/iq/local-compute/configuration', label: 'Configuration' },
    ]}><ConfigurationContents bundle={bundle} library={catalog} view={view} onViewChange={() => {}} /></BuildSectionLayout>
  </MemoryRouter>);
}

test('Configuration is selected in the Local compute menu alongside Machines and Runs', () => {
  const html = render();
  assert.match(html, /aria-label="Local compute navigation"/);
  assert.match(html, /<a aria-current="page"[^>]*href="\/iq\/local-compute\/configuration"/);
  assert.match(html, /Machines/);
  assert.match(html, /Runs/);
  assert.doesNotMatch(html, /Release/);
});

test('preview compares explicit versions without offering unsupported publishing', () => {
  const html = render();
  assert.match(html, /1 update available/);
  assert.match(html, /v2/);
  assert.match(html, /v3/);
  assert.match(html, /Example data/);
  assert.match(html, /Machine assignments: not reported/);
  assert.match(html, /Review changes/);
  assert.doesNotMatch(html, /skill stale|Active configuration|Publish to fleet|restarts 2/);
});

test('commands and settings values start in collapsed disclosure rows', () => {
  for (const view of ['hooks', 'settings'] as const) {
    const html = render(view);
    assert.match(html, /<details/);
    assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|\s|>)/);
    assert.match(html, view === 'hooks' ? /lab recall/ : /DISABLE_AUTOUPDATER/);
  }
});

test('an unavailable catalog never invents the newer version', () => {
  const html = render('skills', null);
  assert.match(html, /version unavailable/);
  assert.doesNotMatch(html, /Library v3/);
});
