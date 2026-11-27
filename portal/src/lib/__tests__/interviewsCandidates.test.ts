// Add a candidate (lib/interviewsCandidates.ts): what counts as typed, and how the server's answers are read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLANK_CANDIDATE, candidateChanged, createCandidate, openToCandidates } from '../interviewsCandidates.ts';

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

test('only an open opening is offered; a paused or closed one is not, and the server\'s refusal comes back on the opening', async () => {
  assert.deepEqual(['open', 'paused', 'closed'].map((state) => openToCandidates({ state })), [true, false, false]);
  const line = 'This opening is not open, so it takes no new candidates. Open it again first.';
  answer(409, { error: line, fields: [{ path: 'openingId', message: line }] });
  assert.deepEqual(await createCandidate(BLANK_CANDIDATE), { ok: false, error: line, fields: [{ path: 'openingId', message: line }], duplicate: true });
});

test('the details form starts from the record and knows when it changed (gap audit 2026-11-20 §6)', async () => {
  const { detailsOf, detailsChanged } = await import('../interviewsCandidates.ts');
  const was = detailsOf({ name: 'Robin Example', email: 'robin@example.com', headline: 'Engineer', location: 'Lisbon' });
  assert.deepEqual(was, { name: 'Robin Example', email: 'robin@example.com', headline: 'Engineer', location: 'Lisbon' });
  assert.equal(detailsOf({ name: 'A', headline: '', location: '' }).email, '');
  assert.equal(detailsChanged(was, { ...was }), false);
  assert.equal(detailsChanged(was, { ...was, name: ' Robin Example  ' }), false);
  assert.equal(detailsChanged(was, { ...was, email: 'robyn@example.com' }), true);
});
