import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_DRAFT, createRefusal, newInitiativeBody, newInitiativeProblems } from '../newInitiativeModel.ts';

const draft = (over: Partial<typeof EMPTY_DRAFT>) => ({ ...EMPTY_DRAFT, ...over });

test('a name is required and capped at 80 characters', () => {
  assert.ok(newInitiativeProblems(draft({ name: '   ' })).name);
  assert.ok(newInitiativeProblems(draft({ name: 'x'.repeat(81) })).name);
  assert.deepEqual(newInitiativeProblems(draft({ name: 'x'.repeat(80) })), {});
});

test('the summary is capped at 600 and the repository must read owner/name', () => {
  assert.ok(newInitiativeProblems(draft({ name: 'a', summary: 'x'.repeat(601) })).summary);
  for (const repo of ['billing', 'a/b/c', 'a b/c', `a/${'b'.repeat(140)}`]) assert.ok(newInitiativeProblems(draft({ name: 'a', repo })).repo, repo);
  assert.deepEqual(newInitiativeProblems(draft({ name: 'a', repo: 'acme/billing-2.0' })), {});
});

test('the body leaves out blank fields and the caller as owner', () => {
  assert.deepEqual(newInitiativeBody(draft({ name: ' Billing ', ownerId: 'p-1' }), 'p-1'), { name: 'Billing' });
  assert.deepEqual(
    newInitiativeBody(draft({ name: 'B', summary: ' why ', ownerId: 'p-2', sponsorId: 'p-3', repo: ' a/b ' }), 'p-1'),
    { name: 'B', summary: 'why', owner_person_id: 'p-2', sponsor_person_id: 'p-3', repo: 'a/b' },
  );
});

test('a duplicate name points at the existing initiative; other refusals keep the server words', () => {
  assert.deepEqual(createRefusal(409, { code: 'NAME_TAKEN', existingId: 'p-x' }, 'taken'), { field: 'name', message: 'taken', existingId: 'p-x' });
  assert.equal(createRefusal(409, { code: 'REPO_LINKED', existingId: 'p-y' }, 'linked').field, 'repo');
  assert.equal(createRefusal(400, { code: 'NO_SUCH_PERSON' }, 'no one').field, 'owner');
  assert.equal(createRefusal(403, null, null).field, null);
  assert.equal(createRefusal(500, null, 'boom').message, 'boom');
});
