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

test('the lead\'s room control: copy the link made in this tab, else make one; a live link made earlier is re-made, a closed round shows nothing', async () => {
  const { roomLinkControl } = await import('../interviewsUpcoming.ts');
  const status = (state: string) => ({ state, issuedAt: null, issuedBy: null, expiresAt: null, revokedAt: null, firstOpenedAt: null, lastOpenedAt: null, openCount: 0 }) as never;
  assert.deepEqual(roomLinkControl(status('live'), true), { kind: 'copy' });
  assert.equal(roomLinkControl(null, false), null);
  assert.equal(roomLinkControl(status('closed'), false), null);
  for (const s of ['none', 'revoked', 'expired', 'other-interview']) assert.equal((roomLinkControl(status(s), false) as { label: string }).label, 'Make candidate link');
  const again = roomLinkControl(status('live'), false) as { label: string; hint: string };
  assert.equal(again.label, 'Make a new candidate link');
  assert.match(again.hint, /shown only once.*stops the old one/);
});

test('invitationMessage: first name, opening, round, the time in words with its zone, the length, the link, what to expect', async () => {
  const { invitationMessage, firstNameOf } = await import('../interviewsUpcoming.ts');
  const base = { candidateName: '  Avery Quill ', openingTitle: 'Backend Engineer', roundName: 'Technical round', roundType: 'technical' as const, scheduledAt: '2027-03-04T15:30:00.000Z', minutes: 60, link: 'https://example.com/join#abc' };
  const text = invitationMessage(base, 'UTC');
  assert.equal(text, [
    'Hi Avery,',
    '',
    'Thank you for applying for Backend Engineer. Your Technical round is on Thursday 4 March 2027 at 15:30 UTC and lasts 1 hour.',
    '',
    'Join from this link when it is time: https://example.com/join#abc',
    '',
    'The interview is a video call in your browser, with a shared code pad or whiteboard for the technical part; there is nothing to install. The link is yours alone, so please do not share it. If you cannot make this time, open the link and tell us.',
  ].join('\n'));
  const behavioural = invitationMessage({ ...base, roundType: 'behavioural', minutes: 45, roundName: 'Culture chat' }, 'America/New_York');
  assert.match(behavioural, /Your Culture chat is on Thursday 4 March 2027 at 10:30 GMT-5 and lasts 45 minutes\./);
  assert.doesNotMatch(behavioural, /code pad/);
  assert.match(invitationMessage({ ...base, minutes: 120 }, 'UTC'), /lasts 2 hours/);
  assert.match(invitationMessage({ ...base, scheduledAt: null }, 'UTC'), /is on a time we will confirm with you/);
  assert.equal(firstNameOf(''), 'there');
  assert.ok(!invitationMessage(base, 'UTC').includes('Quill'), 'only the first name');
});
