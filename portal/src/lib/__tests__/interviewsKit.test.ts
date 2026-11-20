// The kit editor's pure helpers (lib/interviewsKit.ts; docs/interviews-tenant-plan.md rows I1.3, I1.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_ROUND_INTRO, TECHNICAL_ROUND_INTRO, offeredIntro, blankQuestion, blankRound, changesLine, kitChanges, kitLine, kitTitle, moved, newId, padLine, problemsByPath, roundHasPad, rowsWithProblems, starterLine,
  toggledCompetency, withoutCompetency, type OpeningKit,
} from '../interviewsKit.ts';

const KIT: OpeningKit = {
  rounds: [{ id: 'rd-a', name: 'Coding', type: 'technical', minutes: 60, competencyIds: ['c-1'] }, { id: 'rd-b', name: 'Leadership', type: 'behavioural', minutes: 45, competencyIds: ['c-1'] }],
  competencies: [{ id: 'c-1', name: 'Delivery', lookFor: 'Sees slips early.', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } }],
  questions: [
    { id: 'q-1', prompt: 'One', followUps: [], competencyId: 'c-1', roundType: 'technical', starter: { go: 'x\n', python: 'y\n' } },
    { id: 'q-2', prompt: 'Two', followUps: ['Why?'], competencyId: 'c-1', roundType: 'behavioural' },
  ],
};

test('a behavioural round has no code pad', () => {
  assert.equal(roundHasPad('behavioural'), false);
  assert.equal(padLine('technical'), 'Code pad');
  assert.equal(padLine('behavioural'), 'No code pad');
});

test('kitLine says rounds and questions; kitTitle the kinds, the competencies and the rounds', () => {
  const row = (t: number, b: number, rounds = KIT.rounds) => ({ rounds, kitSize: { competencies: 1, questions: { technical: t, behavioural: b } } });
  assert.equal(kitLine(row(4, 2)), '2 rounds · 6 questions');
  assert.equal(kitLine(row(0, 1)), '2 rounds · 1 question');
  assert.equal(kitLine(row(0, 0)), '2 rounds · no questions');
  assert.equal(kitLine(row(0, 0, [])), 'No kit yet');
  assert.equal(kitTitle(row(4, 2)), '4 technical and 2 behavioural questions; 1 competency. Coding 60 min · Leadership 45 min');
});

test('starterLine names the languages in the pad\'s order', () => {
  assert.equal(starterLine(KIT.questions[0]!), 'Python, Go');
  assert.equal(starterLine(KIT.questions[1]!), '');
});

test('newId avoids the ids taken; moved swaps neighbours and stops at either end', () => {
  let n = 0;
  const seq = () => [0, 0, 0, 0, 0, 0, 1 / 36, 0, 0, 0, 0, 0][n++ % 12]!;
  assert.equal(newId('q', new Set(['q-000000']), seq), 'q-100000');
  assert.deepEqual(moved(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
});

test('kitChanges says what was added, edited, removed or reordered, in words', () => {
  const after = structuredClone(KIT);
  after.questions.push(blankQuestion('q-3', 'behavioural', 'c-1'));
  after.competencies[0]!.lookFor = 'Sees slips early and says so.';
  assert.deepEqual(kitChanges(KIT, after), ['1 competency edited', '1 question added']);
  const reordered = structuredClone(KIT);
  reordered.questions.reverse();
  assert.deepEqual(kitChanges(KIT, reordered), ['questions reordered']);
  const removed = structuredClone(KIT);
  removed.rounds.pop();
  assert.deepEqual(kitChanges(KIT, removed), ['1 round removed']);
  assert.deepEqual(kitChanges(KIT, structuredClone(KIT)), []);
  assert.equal(changesLine(['1 question added'], true), '1 question added · details edited');
  assert.equal(changesLine([], true), 'Details edited');
  assert.equal(changesLine([], false), null);
});

test('problems map to their fields, and to the rows they sit on', () => {
  const m = problemsByPath([
    { path: 'questions.2.prompt', message: 'Question 3 needs the words the interviewer will ask.' },
    { path: 'questions.2.followUps.0', message: 'Follow-up 1 on question 3 is empty; write it or remove it.' },
    { path: 'competencies.0.lookFor', message: 'Competency 1 needs a line on what good looks like.' },
    { path: 'questions', message: 'A kit holds at most 60 questions.' },
  ]);
  assert.equal(m.get('questions.2.prompt'), 'Question 3 needs the words the interviewer will ask.');
  assert.deepEqual([...rowsWithProblems(m, 'questions')], [2]);
  assert.deepEqual([...rowsWithProblems(m, 'competencies')], [0]);
  assert.deepEqual([...rowsWithProblems(m, 'rounds')], []);
});

test('a round ticks and unticks the competencies it assesses, kept in the kit\'s order; a new round starts with none', () => {
  const kit: OpeningKit = { ...KIT, competencies: [...KIT.competencies, { ...KIT.competencies[0]!, id: 'c-2', name: 'Design' }] };
  assert.deepEqual(blankRound('rd-new').competencyIds, []);
  assert.deepEqual(toggledCompetency(kit, { competencyIds: ['c-1'] }, 'c-2'), ['c-1', 'c-2']);
  assert.deepEqual(toggledCompetency(kit, { competencyIds: ['c-2'] }, 'c-1'), ['c-1', 'c-2']);
  assert.deepEqual(toggledCompetency(kit, { competencyIds: ['c-1', 'c-2'] }, 'c-1'), ['c-2']);
  // Ticking a competency is an edit of the round.
  assert.deepEqual(kitChanges(kit, { ...kit, rounds: [{ ...kit.rounds[0]!, competencyIds: ['c-1', 'c-2'] }, kit.rounds[1]!] }), ['1 round edited']);
});

test('removing a competency unticks it in every round that assessed it', () => {
  const after = withoutCompetency(KIT, 'c-1');
  assert.deepEqual(after.competencies, []);
  assert.deepEqual(after.rounds.map((r) => r.competencyIds), [[], []]);
  assert.deepEqual(after.questions, KIT.questions);
});

test('a technical round offers the line the interviewer reads out: how to ask Milo, and (on the pad) what for; a behavioural round offers none', () => {
  assert.equal(TECHNICAL_ROUND_INTRO, "If you'd like help, just say 'Hey Milo'. Milo can add test cases for you to speed things up.");
  assert.equal(offeredIntro(blankRound('rd-new')), TECHNICAL_ROUND_INTRO);
  assert.equal(offeredIntro({ type: 'technical', surface: 'pad' }), TECHNICAL_ROUND_INTRO);
  assert.equal(offeredIntro({ type: 'technical', surface: 'board' }), BOARD_ROUND_INTRO);
  assert.equal(offeredIntro({ type: 'behavioural' }), null);
  assert.equal(blankRound('rd-new').intro, undefined); // nothing saved: the offered line is read
});
