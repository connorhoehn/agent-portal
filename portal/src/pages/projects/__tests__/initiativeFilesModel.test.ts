// G56: the Docs tab's New menu. Document and Whiteboard follow the route's
// answer (the initiative's own people), Presentation follows DispatchAgentRun
// (a deck spends); nothing shows to a persona who may make nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { NEW_FILE_DENIED_HINT, RECORDINGS_NEED_SOCIAL, holdsSocialRole, newFileChoices, newFileTrigger, readCanWrite, recordingsMode, recordingsNote, showNewFileHint } from '../initiativeFilesModel.ts';

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

test('a viewer who may create nothing keeps a disabled New file trigger and the hint, once settled', () => {
  assert.deepEqual(newFileTrigger([]), { disabled: true });
  assert.deepEqual(newFileTrigger(['document']), { disabled: false });
  assert.equal(NEW_FILE_DENIED_HINT, 'Only this initiative’s people and org-leaders add files here.');
  assert.equal(showNewFileHint({ capabilitiesReady: true, pending: false, choices: [] }), true);
  assert.equal(showNewFileHint({ capabilitiesReady: true, pending: true, choices: [] }), false, 'still loading');
  assert.equal(showNewFileHint({ capabilitiesReady: false, pending: false, choices: [] }), false, 'capabilities not read');
  assert.equal(showNewFileHint({ capabilitiesReady: true, pending: false, choices: ['document'] }), false);
});

test('recordings are read only with ViewSocial; without it the Docs tab says so and never calls the read', () => {
  assert.equal(recordingsMode({ capabilitiesReady: true, canViewSocial: true }), 'read');
  assert.equal(recordingsMode({ capabilitiesReady: true, canViewSocial: false }), 'needs-social');
  assert.equal(recordingsMode({ capabilitiesReady: false, canViewSocial: false }), 'pending');
  assert.equal(RECORDINGS_NEED_SOCIAL, 'Recordings need the Social workspace.');
});

test('a Social role reads recordings from any workspace (Sienna: orgiq member or org-leader, Social participant)', () => {
  const sienna = { orgiq: ['org-leader', 'member'], social: ['participant'] };
  assert.equal(holdsSocialRole(sienna), true);
  assert.equal(holdsSocialRole({ orgiq: ['member'] }), false);
  assert.equal(holdsSocialRole({ orgiq: ['member'], social: [] }), false);
  assert.equal(holdsSocialRole(null), false);
  const mode = recordingsMode({ capabilitiesReady: true, canViewSocial: false || holdsSocialRole(sienna) });
  assert.equal(mode, 'read');
  assert.equal(recordingsNote(mode, null), null, 'no "need the Social workspace" line for a Social participant');
  // A read that fails says why, in the same info line.
  assert.equal(recordingsNote(mode, 'The call recording service is not configured.'), 'Recordings: The call recording service is not configured.');
  assert.equal(recordingsNote('needs-social', null), RECORDINGS_NEED_SOCIAL);
  assert.equal(recordingsNote('pending', 'x'), null);
});

test('only the route\'s literal `canWrite: true` opens the page choices', () => {
  assert.equal(readCanWrite({ projectId: 'p', documents: [], canWrite: true }), true);
  for (const body of [{ canWrite: 'true' }, { canWrite: 1 }, { documents: [] }, null, undefined, []]) assert.equal(readCanWrite(body), false, JSON.stringify(body));
});
