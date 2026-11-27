// The debrief on the portal side (lib/interviewsDebrief.ts, rows I5.4, I5.5): the side-by-side model lays out what
// people wrote and adds nothing of its own; the lines a round, a scorecard and the decision show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmQuestion, debriefHref, dueLine, missingLine, readsDebrief, reasonProblem, recapLine, redFlagLines, roundEmptyLine, scorecardNotes, sideBySide, applicationSideBySide,
  type DebriefApplication, type DebriefScorecard,
} from '../interviewsDebrief.ts';

const COMPETENCIES: DebriefApplication['competencies'] = [
  { id: 'design', name: 'System design', anchors: { 1: 'Misses the load', 2: 'Partly', 3: 'Sound', 4: 'Sound and simple' } },
  { id: 'comms', name: 'Communication', anchors: { 1: 'a', 2: 'b', 3: 'Clear', 4: 'd' } },
];
const card = (id: string, name: string, over: Partial<DebriefScorecard> = {}): DebriefScorecard => ({
  id, interviewer: { id: `u-${id}`, name }, version: 1, submittedAt: '2026-11-10T10:00:00Z', recommendation: 'yes', summary: `${name}'s summary`,
  ratings: [{ competencyId: 'design', competency: 'System design', rating: 3, note: 'Drew the queue first.' }],
  changedAfterRecap: false, correctionReason: null, earlierVersions: 0, ...over,
});

test('one row per competency in kit order, one column per scorecard in seat order, then the recommendation and the summary', () => {
  const lead = card('lead', 'Hugo Marchetti', { ratings: [{ competencyId: 'design', competency: 'System design', rating: 4, note: '' }, { competencyId: 'comms', competency: 'Communication', rating: 3, note: 'Explained trade-offs.' }], recommendation: 'strong-yes' });
  const panel = card('panel', 'Wen Zhao', { recommendation: 'no' });
  const { columns, rows } = sideBySide({ scorecards: [lead, panel] }, COMPETENCIES);
  assert.deepEqual(columns.map((c) => c.interviewer.name), ['Hugo Marchetti', 'Wen Zhao']);
  assert.deepEqual(rows.map((r) => r.label), ['System design', 'Communication', 'Recommendation', 'Summary']);
  assert.deepEqual(rows[0]!.cells['lead'], { kind: 'rating', rating: 4, anchor: 'Sound and simple', note: '' });
  assert.deepEqual(rows[1]!.cells['comms'], undefined);
  // A competency someone did not rate is an empty cell, never a guess.
  assert.deepEqual(rows[1]!.cells['panel'], { kind: 'none' });
  assert.deepEqual(rows[2]!.cells['panel'], { kind: 'recommendation', recommendation: 'no' });
  assert.deepEqual(rows[3]!.cells['lead'], { kind: 'summary', text: "Hugo Marchetti's summary" });
});

test('the model adds no score of its own: no average, total or ranking row, and the columns keep seat order whatever the ratings', () => {
  const low = card('a', 'First seat', { ratings: [{ competencyId: 'design', competency: 'System design', rating: 1, note: '' }] });
  const high = card('b', 'Second seat', { ratings: [{ competencyId: 'design', competency: 'System design', rating: 4, note: '' }] });
  const { columns, rows } = sideBySide({ scorecards: [low, high] }, COMPETENCIES);
  assert.deepEqual(columns.map((c) => c.id), ['a', 'b']);
  for (const r of rows) assert.doesNotMatch(r.label, /average|total|rank|score/i);
  assert.equal(rows.length, COMPETENCIES.length + 2);
});

test('a round with nothing in says why; one with some in names who is still due', () => {
  assert.equal(roundEmptyLine({ state: 'ended', due: [{ id: 'u-wen', name: 'Wen Zhao' }], scorecards: [] }), 'Nothing is in yet. Due from Wen Zhao.');
  assert.equal(roundEmptyLine({ state: 'ready', due: [], scorecards: [] }), 'This round has not been held yet.');
  assert.equal(roundEmptyLine({ state: 'cancelled', due: [], scorecards: [] }), 'This round did not go ahead.');
  assert.equal(roundEmptyLine({ state: 'scored', due: [], scorecards: [card('a', 'A')] }), null);
  assert.equal(dueLine({ due: [{ id: 'x', name: 'Ola Brandt' }], scorecards: [card('a', 'A')] }), 'Still due from Ola Brandt.');
  assert.equal(dueLine({ due: [], scorecards: [card('a', 'A')] }), null);
});

test('a scorecard says when a rating changed after the recap, why it was corrected, and how many versions came before', () => {
  assert.deepEqual(scorecardNotes(card('a', 'Hugo')), []);
  assert.deepEqual(scorecardNotes(card('a', 'Hugo', { changedAfterRecap: true, version: 2, correctionReason: 'Misread my note.', earlierVersions: 1 })), [
    "Hugo changed a rating after reading Milo's recap.",
    'Hugo corrected this in version 2: Misread my note.',
    "1 earlier version of Hugo's scorecard is kept on the scorecard page.",
  ]);
});

test('the decision asks once more when a scorecard is still due, and says it is recorded under the decider\'s name', () => {
  assert.equal(confirmQuestion({ scorecardsMissing: 0 }, 'advance', 'Amara Okafor'),
    'Record "Advance to an offer" under your name, Amara Okafor? It cannot be edited; a later decision is a new entry.');
  assert.match(confirmQuestion({ scorecardsMissing: 2 }, 'reject', 'Amara Okafor'), /^2 scorecards are still due\. You can decide now/);
  assert.equal(missingLine(1), '1 scorecard was still due');
  assert.equal(missingLine(0), null);
  const limits = { reasonMin: 10, reasonMax: 20 };
  assert.match(reasonProblem('short', limits)!, /Say why/);
  assert.match(reasonProblem('x'.repeat(21), limits)!, /under 20/);
  assert.equal(reasonProblem('  long enough now ', limits), null);
});

test('who opens a debrief, where it is, and what the recap says when it has nothing to show', () => {
  assert.deepEqual(['recruiter', 'hiring-manager', 'admin', 'interviewer', undefined].map(readsDebrief), [true, true, true, false, false]);
  assert.equal(debriefHref('cand 1'), '/interviews/candidates/cand%201/debrief');
  const empty = { paused: null, writtenAt: null, competencies: [], notCovered: [] };
  assert.match(recapLine({ ...empty, state: 'no-transcript' })!, /without a transcript/);
  assert.match(recapLine({ ...empty, state: 'paused', paused: 'budget' })!, /budget/);
  assert.equal(recapLine({ ...empty, state: 'ready', competencies: [{ id: 'd', name: 'D', evidence: [{ text: 't', source: { kind: 'transcript', seq: 1, quote: 'q' } }] }] }), null);
});

test('one table for an application: each round a group of one column per interviewer, the recommendation and the summary as rows', () => {
  const r1 = { interviewId: 'iv-1', name: 'Coding', scorecards: [card('a', 'Hugo Marchetti'), card('b', 'Wen Zhao')] };
  const r2 = { interviewId: 'iv-2', name: 'Together', scorecards: [card('c', 'Amara Okafor', { recommendation: 'strong-yes' })] };
  const { columns, rows } = applicationSideBySide([r1, r2], COMPETENCIES);
  assert.deepEqual(columns.map((c) => [c.roundName, c.interviewer.name, c.firstInRound]), [['Coding', 'Hugo Marchetti', true], ['Coding', 'Wen Zhao', false], ['Together', 'Amara Okafor', true]]);
  assert.deepEqual(rows.map((r) => r.label), ['System design', 'Communication', 'Recommendation', 'Summary']);
  assert.deepEqual(Object.keys(rows[2]!.cells).sort(), ['a', 'b', 'c']);
  assert.deepEqual(rows[2]!.cells['c'], { kind: 'recommendation', recommendation: 'strong-yes' });
});

test('a round with no scorecard adds no column, and no rounds at all still gives the competency rows', () => {
  const none = { interviewId: 'iv-3', name: 'Design', scorecards: [] };
  assert.equal(applicationSideBySide([none], COMPETENCIES).columns.length, 0);
  assert.equal(applicationSideBySide([none], COMPETENCIES).rows.length, COMPETENCIES.length + 2);
  assert.equal(applicationSideBySide([], COMPETENCIES).rows.length, COMPETENCIES.length + 2);
});

test('five interviewers over two rounds give five columns, each under its round, wider than a 1280 window (the case the pinned Competency column is for)', () => {
  const r1 = { interviewId: 'iv-1', name: 'Coding', scorecards: ['a', 'b', 'c'].map((id) => card(id, `Interviewer ${id}`)) };
  const r2 = { interviewId: 'iv-2', name: 'Together', scorecards: ['d', 'e'].map((id) => card(id, `Interviewer ${id}`, { version: id === 'e' ? 2 : 1 })) };
  const { columns, rows } = applicationSideBySide([r1, r2], COMPETENCIES);
  assert.deepEqual(columns.map((c) => c.roundId), ['iv-1', 'iv-1', 'iv-1', 'iv-2', 'iv-2']);
  assert.ok(176 + columns.length * 300 > 1280);
  assert.deepEqual(Object.keys(rows[0]!.cells).sort(), ['a', 'b', 'c', 'd', 'e']);
});

test('the round\'s ticked red flags read one sentence each with who ticked them; none when nobody ticked one', () => {
  const hugo = { id: 'u-hugo', name: 'Hugo Marchetti' };
  const wen = { id: 'u-wen', name: 'Wen Zhao' };
  assert.deepEqual(redFlagLines({ redFlags: [{ text: 'Cannot say where the data lives.', by: [hugo, wen] }, { text: 'Skips the clarifying questions', by: [wen] }] }), [
    'Red flag: Cannot say where the data lives, ticked by Hugo Marchetti and Wen Zhao.',
    'Red flag: Skips the clarifying questions, ticked by Wen Zhao.',
  ]);
  assert.deepEqual(redFlagLines({ redFlags: [] }), []);
});
