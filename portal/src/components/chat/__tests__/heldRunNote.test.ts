import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldRunNote } from '../heldRunNote.ts';

test('the private card names what it is waiting for', () => {
  assert.equal(heldRunNote('summary'), 'Only you can see this. Post it when it is ready.');
  assert.equal(heldRunNote('diagram'), 'Only you can see this. Post it when it is ready.');
  assert.equal(heldRunNote('doc'), 'Only you can see this. Save it as a document when it is ready.');
  assert.equal(heldRunNote('agent'), 'Only you can see this. Nothing runs until you approve the plan.');
});
