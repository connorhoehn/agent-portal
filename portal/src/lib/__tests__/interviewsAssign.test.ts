// Assigning a round and answering a seat, the portal's pure helpers (lib/interviewsAssign.ts, row I1.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignHref, canReassign, declineLines, panelChoices, reasonProblem, seatingOf, seatsOfRow } from '../interviewsAssign.ts';

test('a decline needs a reason between the floor and the ceiling, as the server says', () => {
  assert.match(reasonProblem('busy') ?? '', /at least 10 characters/);
  assert.equal(reasonProblem('  On leave   that whole week. '), null);
  assert.match(reasonProblem('x'.repeat(501)) ?? '', /under 500/);
});

test('the form\'s seats drop blanks, repeats and the lead', () => {
  assert.deepEqual(seatingOf('u-hugo', ['', 'u-wen']), { leadId: 'u-hugo', panelIds: ['u-wen'] });
  assert.deepEqual(seatingOf('u-hugo', ['u-wen', 'u-wen']), { leadId: 'u-hugo', panelIds: ['u-wen'] });
  assert.deepEqual(seatingOf('u-hugo', ['u-hugo', '']), { leadId: 'u-hugo', panelIds: [] });
  const people = [{ id: 'u-hugo', name: 'Hugo' }, { id: 'u-wen', name: 'Wen' }, { id: 'u-ola', name: 'Ola' }];
  assert.deepEqual(panelChoices(people, 'u-hugo', 'u-wen').map((p) => p.id), ['u-ola']);
  assert.deepEqual(seatsOfRow({ lead: { id: 'u-hugo', name: 'Hugo' }, panel: [{ id: 'u-wen', name: 'Wen' }] }), { leadId: 'u-hugo', panel: ['u-wen', ''] });
  assert.deepEqual(seatsOfRow(null), { leadId: '', panel: ['', ''] });
});

test('who declined and why, the latest first; who sits may change until the call starts', () => {
  const lines = declineLines({ declines: [
    { person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel', reason: 'Clashes with on-call.', at: '2026-11-16T10:00:00Z' },
    { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'lead', reason: 'On leave.', at: '2026-11-16T12:00:00Z' },
  ] });
  assert.deepEqual(lines, ['Hugo Marchetti declined to lead: On leave.', 'Wen Zhao declined the panel seat: Clashes with on-call.']);
  assert.deepEqual(['assigned', 'accepted', 'ready', 'declined', 'live', 'ended', 'cancelled'].map((s) => canReassign(s as 'live')), [true, true, true, true, false, false, false]);
  assert.equal(assignHref('cand-x', { application: 'app-x' }), '/interviews/candidates/cand-x/assign?application=app-x');
  assert.equal(assignHref('cand-x', { round: 'iv-1' }), '/interviews/candidates/cand-x/assign?round=iv-1');
});
