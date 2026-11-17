// The row models of My interviews and Upcoming (lib/interviewsDesk.ts): the four tabs and their counts, the live round
// first, and Upcoming listing what has not finished with the finished rounds one choice away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bucket, InterviewRow, InterviewState } from '../interviews.ts';
import { deskTabCounts, deskTabOf, deskTabRows, finishedCount, firstDeskTab, isLive, upcomingRows } from '../interviewsDesk.ts';

const row = (id: string, state: InterviewState, bucket: Bucket, scheduledAt: string | null, name = id): InterviewRow => ({
  id, candidate: { id: `c-${id}`, name, headline: '' }, opening: { id: 'op', title: 'Opening', team: 'Team' }, applicationId: 'app',
  round: { id: 'r', name: 'Round', type: 'technical', minutes: 45 }, lead: { id: 'u-1', name: 'Lead' }, panel: [], scheduledAt, state, bucket, seat: 'lead',
  questions: 0, myScorecard: null, scorecardsIn: 0, seats: [], myAnswer: null, declines: [], revision: 1,
} as InterviewRow);

const ROWS = [
  row('a', 'assigned', 'to-accept', '2026-11-20T10:00:00Z'),
  row('b', 'accepted', 'to-prepare', '2026-11-21T10:00:00Z'),
  row('c', 'ready', 'upcoming', '2026-11-19T10:00:00Z'),
  row('d', 'live', 'upcoming', '2026-11-22T10:00:00Z'),
  row('e', 'ended', 'scorecard-due', '2026-11-15T10:00:00Z'),
  row('f', 'scored', 'done', '2026-11-10T10:00:00Z'),
  row('g', 'declined', 'closed', null),
  row('h', 'live', 'to-prepare', '2026-11-18T10:00:00Z'),
];

test('every round is in at most one tab, and the counts add up to the rounds that are not closed', () => {
  const counts = deskTabCounts(ROWS);
  assert.deepEqual(counts, { 'to-accept': 1, 'to-prepare': 1, upcoming: 3, 'scorecard-due': 1, done: 1 });
  assert.equal(deskTabOf(ROWS[6]!), null);
});

test('a live round is in Upcoming and first there, and the first tab shown is the first with rows', () => {
  assert.equal(isLive(ROWS[3]!), true);
  assert.deepEqual(deskTabRows(ROWS, 'upcoming').map((r) => r.id), ['h', 'd', 'c']);
  assert.equal(deskTabRows(ROWS, 'upcoming')[0]!.state, 'live');
  assert.equal(firstDeskTab(deskTabCounts(ROWS)), 'to-accept');
  assert.equal(firstDeskTab(deskTabCounts([ROWS[2]!])), 'upcoming');
  assert.equal(firstDeskTab(deskTabCounts([])), 'upcoming');
  // While a round is live the desk opens on Upcoming, where it is first, even with something to accept.
  assert.equal(firstDeskTab(deskTabCounts(ROWS), true), 'upcoming');
  assert.equal(firstDeskTab(deskTabCounts([ROWS[0]!]), true), 'to-accept');
});

test('Upcoming lists the rounds that have not finished, live first then soonest, with finished ones behind their own choice and counted', () => {
  const open = upcomingRows(ROWS, 'not-finished');
  assert.deepEqual(open.map((r) => r.id), ['h', 'd', 'c', 'a', 'b']);
  assert.deepEqual(upcomingRows(ROWS, 'finished').map((r) => r.id), ['e', 'f']);
  assert.equal(finishedCount(ROWS), 2);
});
