// The interviews pages' words and order (lib/interviews.ts, docs/interviews-tenant-plan.md "Pages").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  byStageLine, candidateHref, deskLabel, deskOrder, inDeskView, lastResultLine, matches, nextInterviewLine, recommendationTone, roundStatus, stageSteps, stageTone, whenLabel,
  type InterviewRow,
} from '../interviews.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const TZ = 'UTC';

test('whenLabel says today, tomorrow and yesterday, else the weekday and date, on a 24-hour clock', () => {
  assert.equal(whenLabel('2026-11-16T14:00:00Z', NOW, TZ), 'Today 14:00');
  assert.equal(whenLabel('2026-11-17T10:00:00Z', NOW, TZ), 'Tomorrow 10:00');
  assert.equal(whenLabel('2026-11-15T16:00:00Z', NOW, TZ), 'Yesterday 16:00');
  assert.equal(whenLabel('2026-11-19T09:30:00Z', NOW, TZ), 'Thu 19 Nov, 09:30');
  assert.equal(whenLabel(null, NOW, TZ), 'No time set');
  assert.equal(whenLabel('not a time', NOW, TZ), 'No time set');
});

test('the next interview and the last result read as one line each, with no ids', () => {
  assert.equal(nextInterviewLine({ id: 'iv-1', roundName: 'System design', type: 'technical', scheduledAt: '2026-11-17T10:00:00Z', state: 'ready', lead: { id: 'u-hugo', name: 'Hugo Marchetti' } }, NOW, TZ),
    'System design · Tomorrow 10:00');
  assert.equal(nextInterviewLine(null, NOW, TZ), '');
  assert.equal(lastResultLine({ recommendation: 'strong-yes', roundName: 'Coding', interviewer: { id: 'u-hugo', name: 'Hugo Marchetti' }, submittedAt: '2026-11-07T16:20:00Z' }), 'Strong yes · Coding');
  assert.equal(lastResultLine(null), '');
});

test('candidates by stage follow the stage order and leave zeros out', () => {
  assert.equal(byStageLine({ rejected: 1, interviewing: 2, screening: 1, debrief: 1 }), 'Screening 1 · Interviewing 2 · Debrief 1 · Not moving forward 1');
  assert.equal(byStageLine({ applied: 0 }), '');
});

test('tones: a go is success, a no caution, a strong no danger; stages read calmly', () => {
  assert.deepEqual(['strong-yes', 'yes', 'no', 'strong-no'].map((r) => recommendationTone(r as 'yes')), ['success', 'success', 'caution', 'danger']);
  assert.equal(stageTone('interviewing'), 'info');
  assert.equal(stageTone('rejected'), 'neutral');
});

const row = (over: Partial<InterviewRow>): InterviewRow => ({
  id: 'iv', candidate: { id: 'c', name: 'C', headline: '' }, opening: { id: 'o', title: 'O', team: 'T' }, applicationId: 'a',
  round: { id: 'r', name: 'Coding', type: 'technical', minutes: 60 }, lead: { id: 'u', name: 'U' }, panel: [], scheduledAt: null,
  state: 'accepted', bucket: 'upcoming', seat: 'lead', questions: 0, myScorecard: null, scorecardsIn: 0, ...over,
});

test('the desk: what needs you first, then upcoming by time, then done newest first', () => {
  const rows = [
    row({ id: 'done-old', bucket: 'done', state: 'reviewed', scheduledAt: '2026-11-07T14:00:00Z' }),
    row({ id: 'up-late', scheduledAt: '2026-11-21T15:00:00Z' }),
    row({ id: 'due', bucket: 'scorecard-due', state: 'ended', scheduledAt: '2026-11-15T16:00:00Z' }),
    row({ id: 'accept', bucket: 'to-accept', state: 'assigned', scheduledAt: '2026-11-19T14:00:00Z' }),
    row({ id: 'up-soon', state: 'ready', scheduledAt: '2026-11-17T10:00:00Z' }),
    row({ id: 'done-new', bucket: 'done', state: 'scored', scheduledAt: '2026-11-13T10:00:00Z' }),
  ];
  assert.deepEqual([...rows].sort(deskOrder).map((r) => r.id), ['accept', 'due', 'up-soon', 'up-late', 'done-new', 'done-old']);
  assert.deepEqual(rows.filter((r) => inDeskView(r, 'open')).map((r) => r.id).sort(), ['accept', 'due', 'up-late', 'up-soon']);
  assert.deepEqual(rows.filter((r) => inDeskView(r, 'done')).map((r) => r.id).sort(), ['done-new', 'done-old']);
});

test('the desk says what each interview waits for', () => {
  assert.equal(deskLabel(row({ bucket: 'to-accept', state: 'assigned' })), 'Accept or decline');
  assert.equal(deskLabel(row({ bucket: 'to-accept', state: 'assigned', seat: 'panel' })), 'Panel: accept or decline');
  assert.equal(deskLabel(row({ state: 'ready' })), 'Prepared');
  assert.equal(deskLabel(row({ state: 'accepted' })), 'Choose questions');
  assert.equal(deskLabel(row({ state: 'accepted', seat: 'panel' })), 'On the panel');
  assert.equal(deskLabel(row({ bucket: 'scorecard-due', state: 'ended' })), 'Scorecard due');
  assert.equal(deskLabel(row({ bucket: 'done', state: 'scored' })), 'Scorecard in');
});

test('search matches any shown field, case-insensitively', () => {
  assert.equal(matches('ingrid', 'Ingrid Solberg', 'Senior Backend Engineer'), true);
  assert.equal(matches('PAYMENTS', 'Mateo', 'Payments'), true);
  assert.equal(matches('swift', 'Mateo', null, undefined), false);
  assert.equal(matches('  ', 'x'), true);
});

test('stageSteps marks the stages reached as done and the current one active', () => {
  const when = (iso: string) => `at ${iso.slice(0, 10)}`;
  const steps = stageSteps('interviewing', [
    { stage: 'applied', at: '2026-11-01T09:00:00Z' }, { stage: 'screening', at: '2026-11-03T09:00:00Z' }, { stage: 'interviewing', at: '2026-11-08T09:00:00Z' },
  ], when);
  assert.deepEqual(steps.map((s) => [s.label, s.done, s.active]), [
    ['Applied', true, false], ['Screening', true, false], ['Interviewing', false, true], ['Debrief', false, false], ['Offer', false, false], ['Hired', false, false],
  ]);
  assert.equal(steps[2]!.description, 'at 2026-11-08');
  assert.equal(steps[3]!.description, '');
});

test('stageSteps ends the track at the stage of a candidate on hold or not moving forward', () => {
  const steps = stageSteps('rejected', [{ stage: 'applied', at: '2026-11-01T09:00:00Z' }, { stage: 'screening', at: '2026-11-03T09:00:00Z' }, { stage: 'rejected', at: '2026-11-04T09:00:00Z' }], () => 'x');
  assert.deepEqual(steps.map((s) => [s.label, s.done, s.active]), [['Applied', true, false], ['Screening', true, false], ['Not moving forward', false, true]]);
});

test('roundStatus words each interview state and candidateHref addresses the profile', () => {
  assert.equal(roundStatus('assigned').label, 'To accept');
  assert.equal(roundStatus('ready').label, 'Scheduled');
  assert.equal(roundStatus('ended').label, 'Scorecard due');
  assert.equal(roundStatus('reviewed').label, 'Done');
  assert.equal(candidateHref('cand-ingrid'), '/interviews/candidates/cand-ingrid');
});
