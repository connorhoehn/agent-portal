// The deletion log's lines on a candidate's profile (lib/interviewsRetention.ts, row I6.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedByLine, deletionPath, deletionQuestion, deletionState, deletionsPath, leftLines, removedLine } from '../interviewsRetention.ts';

test('what was removed reads as one sentence', () => {
  assert.equal(removedLine({ removed: [{ kind: 'recording', count: 2 }, { kind: 'transcript-and-minutes', count: 1 }, { kind: 'resume', count: 1 }, { kind: 'contact-details', count: 1 }], doneAt: 'x', left: [] }),
    'Removed 2 recordings, the transcript and minutes of 1 call, the résumé and the contact details.');
  assert.equal(removedLine({ removed: [{ kind: 'scorecards', count: 1 }], doneAt: 'x', left: [] }), 'Removed 1 scorecard.');
  assert.equal(removedLine({ removed: [{ kind: 'something-new', count: 3 }], doneAt: 'x', left: [] }), 'Removed other records.');
  assert.equal(removedLine({ removed: [], doneAt: 'x', left: [] }), 'Nothing was held, so nothing needed removing.');
  assert.equal(removedLine({ removed: [], doneAt: null, left: [] }), 'Nothing removed yet.');
});

test('what is left says why and what happens next, without blaming anyone', () => {
  const lines = leftLines({ left: [
    { kind: 'recording', why: 'no-service', retry: false },
    { kind: 'transcript-and-minutes', why: 'call-running', retry: true },
    { kind: 'resume', why: 'failed', retry: true },
  ] });
  assert.deepEqual(lines, [
    'The recordings: no recording service is connected here, so there was nothing to remove.',
    'The transcript and minutes: the call was still running. They are removed within the hour after it ends.',
    'The résumé: not removed yet. It is tried again within the hour.',
  ]);
});

test('who asked, and the state', () => {
  assert.equal(askedByLine({ reason: 'request', requestedBy: { id: 'u', name: 'Greta Lindqvist' } }), 'Greta Lindqvist');
  assert.equal(askedByLine({ reason: 'media-period', requestedBy: null }), 'Automatic: the recording period ended');
  assert.equal(askedByLine({ reason: 'record-period', requestedBy: null }), 'Automatic: the record period ended');
  assert.deepEqual(deletionState({ doneAt: null }), { label: 'In progress', tone: 'warning' });
  assert.deepEqual(deletionState({ doneAt: 'x' }), { label: 'Done', tone: 'success' });
});

test('the prompt says what goes and what stays for how long, in two sentences', () => {
  const q = deletionQuestion({ mediaDays: 90, recordYears: 4, deletionDays: 30 });
  assert.equal(q.split('. ').length, 2);
  assert.match(q, /removes the recordings, transcripts and Milo's minutes/);
  assert.match(q, /stay for four years/);
  assert.match(deletionQuestion({ mediaDays: 90, recordYears: 6, deletionDays: 30 }), /stay for 6 years/);
});

test('the paths live under the candidate', () => {
  assert.equal(deletionsPath('c 1'), '/api/interviews/candidates/c%201/deletions');
  assert.equal(deletionPath('c 1'), '/api/interviews/candidates/c%201/deletion');
});
