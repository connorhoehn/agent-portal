// The private notes' and the server draft's pure parts (lib/interviewsPrivateNotes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDraft, NOTES_PRIVACY_LINE, offersNotes, saveStateLine, saveStateTone, type ServerDraft } from '../interviewsPrivateNotes.ts';

const server = (over: Partial<ServerDraft> = {}): ServerDraft => ({ draft: { summary: 'server' }, basedOn: 0, revision: 3, updatedAt: '2026-11-16T10:05:00.000Z', ...over });

test('the server copy wins unless the browser copy is newer; a browser copy the server lacks is uploaded once', () => {
  assert.deepEqual(chooseDraft(server(), null, 0), { use: 'server', upload: false, revision: 3 });
  assert.deepEqual(chooseDraft(server(), { savedAt: '2026-11-16T10:00:00.000Z' }, 0), { use: 'server', upload: false, revision: 3 });
  assert.deepEqual(chooseDraft(server(), {}, 0), { use: 'server', upload: false, revision: 3 });
  assert.deepEqual(chooseDraft(server(), { savedAt: '2026-11-16T11:00:00.000Z' }, 0), { use: 'local', upload: true, revision: 3 });
  assert.deepEqual(chooseDraft(null, { savedAt: '2026-11-16T11:00:00.000Z' }, 0), { use: 'local', upload: true, revision: 0 });
  assert.deepEqual(chooseDraft(null, null, 0), { use: 'none', upload: false, revision: 0 });
  // A server draft for an earlier version is not this one: the browser copy replaces it, against its revision.
  assert.deepEqual(chooseDraft(server({ basedOn: 0 }), { savedAt: '2026-11-16T09:00:00.000Z' }, 1), { use: 'local', upload: true, revision: 3 });
  assert.deepEqual(chooseDraft(server({ basedOn: 0 }), null, 1), { use: 'none', upload: false, revision: 3 });
});

test('the notes are offered only when there are some and the summary is still empty', () => {
  assert.equal(offersNotes({ body: 'Asked about retries.' }, ''), true);
  assert.equal(offersNotes({ body: 'Asked about retries.' }, '  '), true);
  assert.equal(offersNotes({ body: 'Asked about retries.' }, 'Already written.'), false);
  assert.equal(offersNotes({ body: '  ' }, ''), false);
  assert.equal(offersNotes(null, ''), false);
});

test('the save line says what happened in plain words, and a refusal says why', () => {
  assert.equal(NOTES_PRIVACY_LINE, 'Only you can see these notes.');
  assert.equal(saveStateLine('saving', null), 'Saving…');
  assert.equal(saveStateLine('saved', null), 'Saved.');
  assert.match(saveStateLine('failed', null), /Not saved/);
  assert.match(saveStateLine('stale', null), /another window/);
  assert.equal(saveStateLine('saved', 'Your scorecard for this round is in.'), 'Your scorecard for this round is in.');
  assert.equal(saveStateTone('failed'), 'danger');
  assert.equal(saveStateTone('saved'), 'secondary');
});
