// Consent records and the export, portal side (lib/interviewsRecords.ts, rows I6.1 and I6.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentsPath, exportPath, noticeLabel, readsConsents, yesNo } from '../interviewsRecords.ts';

test('the paths carry the encoded id', () => {
  assert.ok(consentsPath('a b').endsWith('/candidates/a%20b/consents'));
  assert.ok(exportPath('iv-1').endsWith('/interviews/iv-1/milo-export'));
});

test('three roles read the section; the interviewer does not', () => {
  assert.deepEqual(['recruiter', 'admin', 'hiring-manager', 'interviewer', 'guest'].map(readsConsents), [true, true, true, false, false]);
});

test('answers read yes or no and the notice names its day', () => {
  assert.equal(yesNo(true), 'Yes');
  assert.equal(yesNo(false), 'No');
  assert.equal(noticeLabel('2026-11-16.1'), 'Notice of 16 Nov 2026');
  assert.equal(noticeLabel('odd'), 'odd');
  assert.equal(noticeLabel(null), '—');
});
