import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consentColumnLabel, showsConsentColumn } from '../interviewsUpcoming.ts';

test('the Consent column says not answered, all on, or what is off in plain words', () => {
  assert.equal(consentColumnLabel(undefined), 'Not answered');
  assert.equal(consentColumnLabel(null), 'Not answered');
  assert.equal(consentColumnLabel({ answered: false, off: ['recording', 'transcription', 'milo'] }), 'Not answered');
  assert.equal(consentColumnLabel({ answered: true, off: [] }), 'All on');
  assert.equal(consentColumnLabel({ answered: true, off: ['recording'] }), 'No recording');
  assert.equal(consentColumnLabel({ answered: true, off: ['milo', 'transcription'] }), 'No transcript, no Milo');
  assert.equal(consentColumnLabel({ answered: true, off: ['milo'] }), 'No Milo');
  assert.equal(consentColumnLabel({ answered: true, off: ['transcription', 'recording', 'milo'] }), 'No recording, no transcript, no Milo');
});

test('only the recruiter sees the column', () => {
  assert.equal(showsConsentColumn('recruiter'), true);
  for (const role of ['interviewer', 'hiring-manager', 'admin', null, undefined]) assert.equal(showsConsentColumn(role), false);
});

test('consentColumnLabel: a round that cannot go ahead as set says so before what is off (row I6.4)', () => {
  assert.equal(consentColumnLabel({ answered: true, off: ['recording'], blocked: true }), 'Cannot go ahead as set: no recording');
  assert.equal(consentColumnLabel({ answered: true, off: ['milo', 'transcription'], blocked: true }), 'Cannot go ahead as set: no transcript, no Milo');
  assert.equal(consentColumnLabel({ answered: true, off: ['recording'], blocked: false }), 'No recording');
  assert.equal(consentColumnLabel({ answered: true, off: [], blocked: false }), 'All on');
  assert.equal(consentColumnLabel({ answered: false, off: ['recording', 'transcription', 'milo'], blocked: false }), 'Not answered');
});
