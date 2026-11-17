// Add a candidate (lib/interviewsCandidates.ts): what counts as typed, and how the server's answers are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLANK_CANDIDATE, candidateChanged, createCandidate } from '../interviewsCandidates.ts';

const answer = (status: number, body: unknown) => { globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch; };

test('a blank form is unchanged, and any typed or chosen field changes it', () => {
  assert.equal(candidateChanged(BLANK_CANDIDATE), false);
  assert.equal(candidateChanged({ ...BLANK_CANDIDATE, name: '  ' }), false);
  assert.equal(candidateChanged({ ...BLANK_CANDIDATE, openingId: 'op-backend' }), true);
});

test('created answers the new candidate; a bad field and a duplicate come back as sentences', async () => {
  answer(201, { candidate: { id: 'cand-x' }, application: {} });
  assert.deepEqual(await createCandidate({ ...BLANK_CANDIDATE, name: 'N' }), { ok: true, candidateId: 'cand-x' });
  answer(400, { error: 'The candidate was not added: one thing needs fixing.', fields: [{ path: 'email', message: 'Give an email address that looks like name@example.com.' }] });
  assert.deepEqual(await createCandidate(BLANK_CANDIDATE), { ok: false, error: 'The candidate was not added: one thing needs fixing.', fields: [{ path: 'email', message: 'Give an email address that looks like name@example.com.' }], duplicate: false });
  answer(409, { error: 'This person is already a candidate for this opening.' });
  assert.deepEqual(await createCandidate(BLANK_CANDIDATE), { ok: false, error: 'This person is already a candidate for this opening.', fields: [], duplicate: true });
});
