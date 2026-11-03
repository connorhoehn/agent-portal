import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { crumbLabel, resetCrumbLabels, setCrumbLabel } from '../crumbLabels.ts';

beforeEach(() => resetCrumbLabels());

test('an unregistered id has no label, so the resolver’s short id stands', () => {
  assert.equal(crumbLabel('des-auth-rotation'), undefined);
  assert.equal(crumbLabel(undefined), undefined);
});

test('a registered title is read back by id and cleared with null', () => {
  setCrumbLabel('des-auth-rotation', 'Session token rotation on tenant switch');
  assert.equal(crumbLabel('des-auth-rotation'), 'Session token rotation on tenant switch');
  setCrumbLabel('des-auth-rotation', null);
  assert.equal(crumbLabel('des-auth-rotation'), undefined);
});

test('an empty title is treated as no title, not as a blank crumb', () => {
  setCrumbLabel('lib-x', '');
  assert.equal(crumbLabel('lib-x'), undefined);
});

test('a page may register its whole trail under its id, and clearing it restores the resolver’s', async () => {
  const { crumbTrail, setCrumbTrail } = await import('../crumbLabels.ts');
  assert.equal(crumbTrail('wdoc-1'), undefined);
  setCrumbTrail('wdoc-1', [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' }, { label: 'Auth Migration', path: '/iq/projects/p-auth-migration' }, { label: 'Cutover notes' }]);
  assert.equal(crumbTrail('wdoc-1')?.length, 4);
  assert.equal(crumbTrail('wdoc-1')?.[2]?.label, 'Auth Migration');
  setCrumbTrail('wdoc-1', null);
  assert.equal(crumbTrail('wdoc-1'), undefined);
  setCrumbTrail('wdoc-1', []);
  assert.equal(crumbTrail('wdoc-1'), undefined);
});
