// Run with:  cd portal && node --test 'src/pages/projects/__tests__/*.test.ts'
//
// The Mine view: rows win; an empty list is explained by the person read;
// a failed read of either is an error, never "nothing linked".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMine, CHECK_PROFILE_HREF } from '../mineModel.ts';
import type { ProjectSummary } from '../types.ts';

const row = { id: 'p-x', name: 'X', status: 'in_progress', contributorCount: 1, createdAt: null } as ProjectSummary;

test('rows answer on their own, whatever the person read says', () => {
  const m = buildMine({ list: { data: [row] }, person: { data: null, error: 'HTTP 500' } });
  assert.equal(m.state, 'has-rows');
});

test('unlinked: the mockup copy, Browse all + Check profile, and how the view works', () => {
  const m = buildMine({ list: { data: [] }, person: { data: { linked: false, personId: null } } });
  if (m.state !== 'unlinked') throw new Error(m.state);
  assert.equal(m.copy.heading, 'No initiatives are linked to you yet.');
  assert.deepEqual(m.copy.lines, [
    "You can still browse your team's work in Everyone.",
    'If you expected to see your initiatives here, check your profile connection.',
  ]);
  assert.equal(m.copy.primary.label, 'Browse all initiatives');
  assert.deepEqual(m.copy.secondary, { label: 'Check profile', href: CHECK_PROFILE_HREF });
  assert.equal(CHECK_PROFILE_HREF, '/settings#profile');
  assert.equal(m.copy.details.title, 'How this view works');
  assert.equal(m.copy.details.lines.length, 3);
  assert.equal(m.copy.details.action.label, 'Refresh this view');
});

test('linked with nothing: names the person when known', () => {
  const m = buildMine({ list: { data: [] }, person: { data: { linked: true, personId: 'p-005' } }, personName: 'Sienna Garcia' });
  if (m.state !== 'linked-none') throw new Error(m.state);
  assert.equal(m.personId, 'p-005');
  assert.match(m.copy.lines[0]!, /^You are connected as Sienna Garcia, but no initiative lists you/);
  const anon = buildMine({ list: { data: [] }, person: { data: { linked: true, personId: 'p-005' } } });
  assert.equal(anon.state === 'linked-none' && anon.copy.lines[0]!.startsWith('Your account is connected'), true);
});

test('failed reads are errors; pending reads are loading', () => {
  assert.deepEqual(buildMine({ list: { data: [], error: 'HTTP 503' }, person: { data: null } }), { state: 'error', failed: 'initiatives', error: 'HTTP 503' });
  assert.deepEqual(buildMine({ list: { data: [] }, person: { data: null, error: 'HTTP 500' } }), { state: 'error', failed: 'profile', error: 'HTTP 500' });
  assert.equal(buildMine({ list: { data: undefined }, person: { data: null } }).state, 'loading');
  assert.equal(buildMine({ list: { data: [] }, person: { data: undefined } }).state, 'loading');
});
