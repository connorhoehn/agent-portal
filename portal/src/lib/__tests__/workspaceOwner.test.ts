import test from 'node:test';
import assert from 'node:assert/strict';
import { mayOpenOwnerShell, pathOwner } from '../workspaceOwner.ts';

test('pathOwner names each tenant by its manifest root', () => {
  assert.equal(pathOwner('/assessment/teams'), 'assessment');
  assert.equal(pathOwner('/social/channels'), 'social');
  assert.equal(pathOwner('/pipelines/runs'), 'pipelines');
  assert.equal(pathOwner('/access'), 'access');
  assert.equal(pathOwner('/interviews/my-interviews'), 'interviews');
  assert.equal(pathOwner('/iq/projects'), 'orgiq');
});

test('orgiq also owns /admin; a prefix lookalike is nobody\'s', () => {
  assert.equal(pathOwner('/admin/knowledge'), 'orgiq');
  assert.equal(pathOwner('/admin'), 'orgiq');
  assert.equal(pathOwner('/interviewsfoo'), null);
  assert.equal(pathOwner('/iqx'), null);
});

test('shared paths belong to nobody', () => {
  for (const p of ['/', '/settings', '/nowhere']) assert.equal(pathOwner(p), null);
});

test('mayOpenOwnerShell', () => {
  const work = { tenant: 'orgiq', role: 'member' };
  assert.equal(mayOpenOwnerShell(work, 'interviews'), false);
  assert.equal(mayOpenOwnerShell(null, 'interviews'), false);
  assert.equal(mayOpenOwnerShell(work, 'orgiq'), true);
  assert.equal(mayOpenOwnerShell({ tenant: 'orgiq', role: 'admin' }, 'interviews'), true);
  assert.equal(mayOpenOwnerShell(null, null), true);
  assert.equal(mayOpenOwnerShell(work, null), true);
});
