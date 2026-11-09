// G56: the Docs tab's New menu. Document and Whiteboard follow the route's
// answer (the initiative's own people), Presentation follows DispatchAgentRun
// (a deck spends); nothing shows to a persona who may make nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newFileChoices, readCanWrite } from '../initiativeFilesModel.ts';

test('a contributor without DispatchAgentRun sees Document and Whiteboard, never Presentation', () => {
  assert.deepEqual(newFileChoices({ capabilitiesReady: true, canWritePages: true, canDispatch: false }), ['document', 'whiteboard']);
});

test('an owner who may also dispatch sees all three; a dispatcher who is not on the initiative sees only Presentation', () => {
  assert.deepEqual(newFileChoices({ capabilitiesReady: true, canWritePages: true, canDispatch: true }), ['document', 'whiteboard', 'presentation']);
  assert.deepEqual(newFileChoices({ capabilitiesReady: true, canWritePages: false, canDispatch: true }), ['presentation']);
});

test('a stranger sees no New menu; Presentation waits for the capabilities read', () => {
  assert.deepEqual(newFileChoices({ capabilitiesReady: true, canWritePages: false, canDispatch: false }), []);
  assert.deepEqual(newFileChoices({ capabilitiesReady: false, canWritePages: false, canDispatch: true }), []);
});

test('only the route\'s literal `canWrite: true` opens the page choices', () => {
  assert.equal(readCanWrite({ projectId: 'p', documents: [], canWrite: true }), true);
  for (const body of [{ canWrite: 'true' }, { canWrite: 1 }, { documents: [] }, null, undefined, []]) assert.equal(readCanWrite(body), false, JSON.stringify(body));
});
