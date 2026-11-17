// The deletion log's lines on a candidate's profile (lib/interviewsRetention.ts, row I6.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askedByLine, deletionPath, deletionQuestion, deletionState, deletionsPath, lateLine, leftLines, removedLine } from '../interviewsRetention.ts';

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
  assert.deepEqual(deletionState({ doneAt: null, overdue: true, doneLate: false }), { label: 'Late', tone: 'danger' });
  assert.deepEqual(deletionState({ doneAt: 'x', overdue: false, doneLate: true }), { label: 'Done late', tone: 'warning' });
});

test('a late deletion says so in plain words, and what to do', () => {
  const dueBy = '2026-03-01T12:00:00.000Z';
  const late = lateLine({ dueBy, overdue: true, doneLate: false });
  assert.ok(late && late.startsWith('Late: this was due by '));
  assert.match(late!, /is not finished\. Ask for the deletion again to retry it now\.$/);
  assert.match(lateLine({ dueBy, overdue: false, doneLate: true })!, /^Finished late: it was due by /);
  assert.equal(lateLine({ dueBy, overdue: false, doneLate: false }), null);
});

test('the reasons written on stage changes are named when they go', () => {
  assert.equal(removedLine({ removed: [{ kind: 'contact-details', count: 1 }, { kind: 'stage-reasons', count: 2 }], doneAt: 'x', left: [] }),
    'Removed the contact details and the reasons written on 2 applications\' stage changes.');
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
