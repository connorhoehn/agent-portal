// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { activeNavId, destinationTitle, moduleNav } from '../moduleNavModel.ts';

test('three groups, each listing its views, with the scope carried on every link', () => {
  const nav = moduleNav({ L0: 97, L1: 22, L2: 11, pending: 6, decided: 21, health: 'danger' }, 'orgiq-observability', true);
  assert.deepEqual([...new Set(nav.map((e) => e.group))], ['Knowledge', 'Review', 'Activity']);
  assert.deepEqual(nav.map((e) => e.label), ['Guides & findings', 'Patterns', 'Run notes', 'Knowledge pending', 'Knowledge reviewed', 'Asset promotions', 'Runs', 'Tier graph']);
  assert.ok(nav.every((e) => e.path.includes('repo=orgiq-observability')));
  assert.equal(nav.find((e) => e.id === 'patterns')!.path, '/iq/distillation/knowledge?view=patterns&repo=orgiq-observability');
  assert.equal(nav.find((e) => e.id === 'guides')!.count, 11);
  assert.equal(nav.find((e) => e.id === 'pending')!.count, 6);
  assert.equal(nav.find((e) => e.id === 'runs')!.accent, 'danger');
});

test('an unloaded count is absent, never a 0; a healthy fleet carries no accent', () => {
  const nav = moduleNav({}, null, false);
  assert.ok(nav.every((e) => e.count === undefined));
  assert.equal(nav.find((e) => e.id === 'runs')!.accent, undefined);
  assert.match(nav.find((e) => e.id === 'pending')!.hint, /read-only/);
});

test('the active entry follows the path AND the view/tab param', () => {
  assert.equal(activeNavId('/iq/distillation/knowledge', ''), 'guides');
  assert.equal(activeNavId('/iq/distillation/knowledge', '?view=notes&item=obs-1'), 'notes');
  assert.equal(activeNavId('/iq/distillation/review', '?tab=decided'), 'decided');
  assert.equal(activeNavId('/iq/distillation/review', ''), 'pending');
  assert.equal(activeNavId('/iq/distillation/activity', '?view=graph&run=comp-1'), 'graph');
  assert.equal(activeNavId('/iq/projects', ''), null);
  assert.equal(destinationTitle('/iq/distillation/activity'), 'Activity');
});
