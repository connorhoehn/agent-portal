// The kit and an opening's details, checked before anything is written (lib/interviews/kit.ts; rows I1.3, I1.8).
import {
  EMPTY_KIT, KIT_LIMITS, NOTHING_IN_USE, checkBoard, checkKit, checkOpeningDetails, competenciesOfRound, competencyIdsOfRound, kitInUse,
  openingIdFor, problemsLine, questionsOfRound, roundHasPad, roundIntro, roundSurface, TECHNICAL_ROUND_INTRO,
} from '../kit.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { EM_KIT } from '../../../mock/interviews-behavioural.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import type { OpeningKit } from '../types.js';
import { blueprintBoard, MASTER_SECTIONS, masterBoard } from '../board/templates.js';
import { TWITTER_PROMPT } from '../../../mock/interviews-design-twitter.js';

afterEach(() => fixtureRegistry.resetAll('default'));

const seedKit = (id: string): OpeningKit => structuredClone(interviewOpeningsFixture.rows().find((o) => o.id === id)!.kit);
const world = () => ({ applications: interviewApplicationsFixture.rows(), interviews: interviewsFixture.rows(), scorecards: interviewScorecardsFixture.rows() });
const paths = (r: ReturnType<typeof checkKit>) => (r.ok ? [] : r.problems.map((p) => p.path));
const messages = (r: ReturnType<typeof checkKit>) => (r.ok ? [] : r.problems.map((p) => p.message));

describe('every seeded kit passes its own check', () => {
  it.each(['op-backend', 'op-ios', 'op-em'])('%s, with what its interviews and scorecards point at', (id) => {
    const kit = seedKit(id);
    const r = checkKit(kit, kit, kitInUse(world(), id));
    expect(paths(r)).toEqual([]);
    expect(r.ok && r.value).toEqual(kit);
  });
});

describe('required fields, each a plain sentence on its own path', () => {
  it('an empty kit needs a round and a competency', () => {
    const r = checkKit({ rounds: [], competencies: [], questions: [] });
    expect(r.ok ? [] : r.problems).toEqual([
      { path: 'rounds', message: 'Add at least one round.' },
      { path: 'competencies', message: 'Add at least one competency.' },
    ]);
  });

  it('names, what good looks like, the four anchors and the words of a question', () => {
    const kit = seedKit('op-backend');
    kit.rounds[1]!.name = '  ';
    kit.competencies[2]!.lookFor = '';
    kit.competencies[0]!.anchors[3] = '';
    kit.questions[4]!.prompt = '';
    kit.questions[0]!.followUps = ['What next?', ' '];
    const r = checkKit(kit);
    expect(r.ok ? [] : r.problems).toEqual([
      { path: 'rounds.1.name', message: 'Round 2 needs a name.' },
      { path: 'competencies.0.anchors.3', message: 'Competency 1 needs a meaning for a rating of 3.' },
      { path: 'competencies.2.lookFor', message: 'Competency 3 needs a line on what good looks like.' },
      { path: 'questions.0.followUps.1', message: 'Follow-up 2 on question 1 is empty; write it or remove it.' },
      { path: 'questions.4.prompt', message: 'Question 5 needs the words the interviewer will ask.' },
    ]);
  });

  it('a round is technical or behavioural and lasts 15 to 180 whole minutes', () => {
    const kit = seedKit('op-backend');
    (kit.rounds[0] as { type: string }).type = 'take-home';
    kit.rounds[2]!.minutes = 200;
    kit.rounds[1]!.minutes = 30.5;
    expect(messages(checkKit(kit))).toEqual(expect.arrayContaining([
      'Round 1 must be technical or behavioural.',
      'Round 2 must last between 15 and 180 whole minutes.',
      'Round 3 must last between 15 and 180 whole minutes.',
    ]));
  });

  it('none of the messages carries an id, a path or a field name', () => {
    const r = checkKit({ rounds: [{ id: 'BAD ID' }], competencies: [{}], questions: [{ competencyId: 'nope', roundType: 'x', starter: { cobol: '' } }] });
    for (const m of messages(r)) expect(m).not.toMatch(/\b(rd|q|op)-|competencyId|roundType|lookFor|\.\d/);
    expect(messages(r).length).toBeGreaterThan(5);
  });
});

describe('each round names the competencies it assesses', () => {
  it('competenciesOfRound: the round\'s own, in the kit\'s order; a coding round never has system design', () => {
    const kit = seedKit('op-backend');
    expect(competenciesOfRound(kit, 'rd-coding').map((c) => c.name)).toEqual(['Problem solving', 'Code quality', 'Communication']);
    expect(competencyIdsOfRound(kit, 'rd-design')).toEqual(['system-design', 'communication']);
    expect(competencyIdsOfRound(kit, 'rd-together')).toEqual(['communication', 'collaboration']);
    expect(competencyIdsOfRound(seedKit('op-em'), 'rd-leadership')).toEqual(['people-leadership', 'delivery', 'influence', 'communication']);
  });

  it('a round with no list (a kit saved before rounds named theirs), or an unknown round, reads every competency', () => {
    const kit = seedKit('op-backend');
    delete kit.rounds[1]!.competencyIds;
    const all = kit.competencies.map((c) => c.id);
    expect(competencyIdsOfRound(kit, 'rd-coding')).toEqual(all);
    expect(competencyIdsOfRound(kit, 'rd-nowhere')).toEqual(all);
    expect(competencyIdsOfRound({ ...kit, rounds: [{ ...kit.rounds[2]!, competencyIds: [] }] }, 'rd-design')).toEqual(all);
  });

  it('questionsOfRound: of the round\'s type, for a competency it assesses', () => {
    const kit = seedKit('op-backend');
    expect(questionsOfRound(kit, 'rd-coding', 'technical').map((q) => q.id)).toEqual(['q-be-ratelimit', 'q-be-retry', 'q-be-twosum']);
    expect(questionsOfRound(kit, 'rd-design', 'technical').map((q) => q.id)).toEqual(['q-be-ledger', 'q-be-shortener', 'q-be-twitter', 'q-be-reconcile']);
  });

  it('checkKit keeps the list in the kit\'s order, once each; a kit without lists still passes and stays without them', () => {
    const kit = seedKit('op-backend');
    kit.rounds[0]!.competencyIds = ['communication', 'problem-solving', 'communication'];
    const r = checkKit(kit);
    expect(r.ok && r.value.rounds[0]!.competencyIds).toEqual(['problem-solving', 'communication']);
    const old = seedKit('op-backend');
    for (const round of old.rounds) delete round.competencyIds;
    const o = checkKit(old);
    expect(o.ok && o.value.rounds.map((x) => 'competencyIds' in x)).toEqual([false, false, false, false]);
  });

  it('a save that sends a round without its list keeps the list the saved kit holds for that round id', () => {
    const saved = seedKit('op-backend');
    const sent = seedKit('op-backend');
    for (const round of sent.rounds) delete round.competencyIds;
    sent.rounds.reverse();
    sent.rounds.push({ id: 'rd-new', name: 'New round', type: 'behavioural', minutes: 30 });
    const r = checkKit(sent, saved);
    expect(paths(r)).toEqual([]);
    const byId = new Map(saved.rounds.map((x) => [x.id, x.competencyIds]));
    expect(r.ok && r.value.rounds.slice(0, 4).map((x) => x.competencyIds)).toEqual(sent.rounds.slice(0, 4).map((x) => byId.get(x.id)));
    // A round the saved kit does not have stays without a list (it reads every competency).
    expect(r.ok && 'competencyIds' in r.value.rounds[4]!).toBe(false);
  });

  it('a carried list is checked like a sent one: dropping a competency it names refuses that round', () => {
    const saved = seedKit('op-backend');
    const sent = seedKit('op-backend');
    for (const round of sent.rounds) delete round.competencyIds;
    sent.competencies = sent.competencies.filter((c) => c.id !== 'collaboration');
    sent.questions = sent.questions.filter((q) => q.competencyId !== 'collaboration');
    expect(paths(checkKit(sent, saved))).toEqual(['rounds.3.competencyIds']);
  });

  it('a round with none, or with a competency the kit does not have, is refused on its own path', () => {
    const kit = seedKit('op-backend');
    kit.rounds[0]!.competencyIds = [];
    kit.rounds[1]!.competencyIds = ['system-design', 'gone'];
    kit.rounds[2]!.competencyIds = 'communication' as unknown as string[];
    const r = checkKit(kit);
    expect(r.ok ? [] : r.problems).toEqual([
      { path: 'rounds.0.competencyIds', message: 'Round 1 needs at least one competency to assess.' },
      { path: 'rounds.1.competencyIds', message: 'Round 2 assesses a competency that is not in this kit; choose its competencies again.' },
      { path: 'rounds.2.competencyIds', message: 'Round 3\'s competencies could not be read; choose them again.' },
    ]);
  });

  it('removing a competency a round assesses refuses the round until it is unticked there', () => {
    const kit = seedKit('op-backend');
    kit.competencies = kit.competencies.filter((c) => c.id !== 'collaboration');
    kit.questions = kit.questions.filter((q) => q.competencyId !== 'collaboration');
    expect(paths(checkKit(kit))).toEqual(['rounds.3.competencyIds']);
    kit.rounds[3]!.competencyIds = ['communication'];
    expect(paths(checkKit(kit))).toEqual([]);
  });
});

describe('a question probes a competency in the kit, for a round the kit has', () => {
  it('a competency that is not in the kit is refused', () => {
    const kit = seedKit('op-ios');
    kit.questions[0]!.competencyId = 'system-design';
    expect(checkKit(kit).ok ? [] : (checkKit(kit) as { problems: unknown[] }).problems)
      .toEqual([{ path: 'questions.0.competencyId', message: 'Question 1 needs a competency from this kit to gather evidence for.' }]);
  });

  it('a question for a kind of round the kit has none of is refused', () => {
    const kit = seedKit('op-ios');
    kit.rounds = kit.rounds.filter((r) => r.type === 'technical');
    expect(paths(checkKit(kit))).toEqual(['questions.2.roundType', 'questions.3.roundType']);
    expect(messages(checkKit(kit))[0]).toBe('Question 3 is for a behavioural round, and the kit has none; add one or change the question.');
  });

  it('two competencies with one name, or two items with one id, are refused', () => {
    const kit = seedKit('op-backend');
    kit.competencies.push({ ...structuredClone(kit.competencies[0]!), id: 'problem-solving-2', name: 'problem SOLVING' });
    kit.questions.push({ ...structuredClone(kit.questions[0]!) });
    expect(checkKit(kit).ok ? [] : (checkKit(kit) as { problems: unknown[] }).problems).toEqual([
      { path: 'competencies.5.name', message: 'Two competencies are called "problem SOLVING"; rename one.' },
      { path: 'questions.9.id', message: 'Question 10 repeats question 1; remove one of them.' },
    ]);
  });
});

describe('starter code: technical questions only, in the pad\'s languages (decision 11, row I1.8)', () => {
  it('a behavioural round has no code pad; a technical one has', () => {
    expect(roundHasPad('behavioural')).toBe(false);
    expect(roundHasPad('technical')).toBe(true);
  });

  it('a behavioural question carrying starter code is refused', () => {
    const kit = seedKit('op-em');
    kit.questions[0]!.starter = { python: 'print("hello")\n' };
    expect(checkKit(kit).ok ? [] : (checkKit(kit) as { problems: unknown[] }).problems).toEqual([
      { path: 'questions.0.starter', message: 'Question 1 is for a behavioural round, which has no code pad, so it cannot carry starter code.' },
    ]);
  });

  it('a language the pad does not offer, empty code and code past the limit are refused', () => {
    const kit = seedKit('op-backend');
    kit.questions[0]!.starter = { python: '   \n', cobol: 'DISPLAY "HI".' } as never;
    kit.questions[1]!.starter = { typescript: 'x'.repeat(KIT_LIMITS.starter + 1) };
    expect(messages(checkKit(kit))).toEqual([
      'Question 1\'s Python starter code is empty; write some or remove it.',
      'Question 1 has starter code in a language the pad does not offer.',
      'Question 2\'s TypeScript starter code is longer than 8,000 characters.',
    ]);
  });

  it('keeps starter code\'s indentation, ending it with one newline; an empty starter is dropped', () => {
    const kit = seedKit('op-backend');
    kit.questions[0]!.starter = { go: '\tfunc main() {}\n\n\n' };
    kit.questions[2]!.starter = {};
    const r = checkKit(kit);
    expect(r.ok && r.value.questions[0]!.starter).toEqual({ go: '\tfunc main() {}\n' });
    expect(r.ok && 'starter' in r.value.questions[2]!).toBe(false);
  });
});

describe('limits on counts and lengths', () => {
  it('rounds, competencies, questions and follow-ups', () => {
    const kit = seedKit('op-em');
    kit.rounds = Array.from({ length: KIT_LIMITS.rounds + 1 }, (_, i) => ({ id: `rd-${i}`, name: `Round ${i}`, type: 'behavioural' as const, minutes: 45 }));
    kit.competencies = Array.from({ length: KIT_LIMITS.competencies + 1 }, (_, i) => ({ ...EM_KIT.competencies[0]!, id: `c-${i}`, name: `Competency ${i}` }));
    kit.questions = Array.from({ length: KIT_LIMITS.questions + 1 }, (_, i) => ({ ...EM_KIT.questions[0]!, id: `q-${i}`, competencyId: 'c-0' }));
    kit.questions[0]!.followUps = Array.from({ length: KIT_LIMITS.followUps + 1 }, (_, i) => `Follow-up ${i}`);
    expect(messages(checkKit(kit))).toEqual([
      'A kit holds at most 6 rounds.',
      'A kit holds at most 12 competencies.',
      'A kit holds at most 60 questions.',
      'Question 1 has more than 5 follow-ups.',
    ]);
  });

  it('names, what good looks like, prompts and follow-ups', () => {
    const kit = seedKit('op-em');
    kit.rounds[0]!.name = 'r'.repeat(61);
    kit.competencies[0]!.lookFor = 'l'.repeat(401);
    kit.questions[0]!.prompt = 'p'.repeat(1001);
    kit.questions[1]!.followUps = ['f'.repeat(301)];
    expect(paths(checkKit(kit))).toEqual(['rounds.0.name', 'competencies.0.lookFor', 'questions.0.prompt', 'questions.1.followUps.0']);
  });

  it('cleans what it keeps: trims words and drops fields the kit does not have', () => {
    const kit = seedKit('op-em') as unknown as { competencies: Array<Record<string, unknown>> };
    kit.competencies[0]!['name'] = '  People leadership  ';
    kit.competencies[0]!['colour'] = 'red';
    const r = checkKit(kit);
    expect(r.ok && r.value.competencies[0]).toEqual({ ...EM_KIT.competencies[0]! });
  });
});

describe('what an interview or a scorecard points at stays', () => {
  const inUse = () => kitInUse(world(), 'op-backend');

  it('kitInUse: the rounds booked, the questions chosen and the competencies rated on the opening', () => {
    const u = inUse();
    expect([...u.roundIds].sort()).toEqual(['rd-coding', 'rd-design', 'rd-screen', 'rd-together']);
    expect(u.questionIds.has('q-be-ratelimit')).toBe(true);
    expect(u.competencyIds.has('problem-solving')).toBe(true);
    expect(kitInUse(world(), 'op-nowhere')).toEqual(NOTHING_IN_USE);
  });

  it('removing a booked round, a rated competency or a chosen question is refused, naming it', () => {
    const before = seedKit('op-backend');
    const kit = structuredClone(before);
    kit.rounds = kit.rounds.filter((r) => r.id !== 'rd-design');
    kit.questions = kit.questions.filter((q) => q.id !== 'q-be-ratelimit' && q.roundType !== 'technical' || q.id === 'q-be-retry');
    kit.competencies = kit.competencies.filter((c) => c.id !== 'problem-solving');
    const m = messages(checkKit(kit, before, inUse()));
    expect(m).toEqual(expect.arrayContaining([
      'The "System design" round has interviews on it, so it stays in the kit.',
      '"Problem solving" is rated on a scorecard, so it stays in the kit.',
      '"Implement a token-bucket rate limiter that…" was chosen for an interview, so it stays in the kit.',
    ]));
  });

  it('a booked round keeps its type; a renamed one is fine', () => {
    const before = seedKit('op-backend');
    const kit = structuredClone(before);
    kit.rounds[0]!.name = 'Live coding';
    expect(checkKit(kit, before, inUse()).ok).toBe(true);
    kit.rounds[3]!.type = 'technical';
    expect(messages(checkKit(kit, before, inUse()))).toContain('The "Working together" round has interviews on it, so it stays behavioural.');
  });

  it('without anything in use, the same removals pass', () => {
    const before = seedKit('op-backend');
    const kit = structuredClone(before);
    kit.questions = kit.questions.slice(2);
    expect(checkKit(kit, before, NOTHING_IN_USE).ok).toBe(true);
  });
});

describe('an opening\'s details', () => {
  const HMS = new Set(['u-amara']);
  const good = { title: ' Data Engineer ', level: 'Senior', team: 'Analytics', location: 'Lisbon', hiringManagerId: 'u-amara', state: 'open', budgetCapUsd: 12.345 };

  it('cleans a good one', () => {
    const r = checkOpeningDetails(good, HMS);
    expect(r.ok && r.value).toEqual({ ...good, title: 'Data Engineer', budgetCapUsd: 12.35, interviewCapUsd: null });
    expect(checkOpeningDetails({ ...good, interviewCapUsd: 4.004 }, HMS)).toMatchObject({ ok: true, value: { interviewCapUsd: 4 } });
    expect(checkOpeningDetails({ ...good, hiringManagerId: '', budgetCapUsd: '' }, HMS)).toMatchObject({ ok: true, value: { hiringManagerId: null, budgetCapUsd: null } });
  });

  it('each missing or wrong field is one sentence on its own path', () => {
    const r = checkOpeningDetails({ title: '', level: '', team: '', location: 'x'.repeat(81), hiringManagerId: 'u-hugo', state: 'archived', budgetCapUsd: -1 }, HMS);
    expect(r.ok ? [] : r.problems).toEqual([
      { path: 'title', message: 'Give the opening a title.' },
      { path: 'level', message: 'Say the level, for example Senior.' },
      { path: 'team', message: 'Name the team the opening is for.' },
      { path: 'location', message: 'The location is longer than 80 characters.' },
      { path: 'hiringManagerId', message: 'Choose a hiring manager from the list, or leave it unnamed for now.' },
      { path: 'state', message: 'The opening must be open, paused or closed.' },
      { path: 'budgetCapUsd', message: "The opening's spending cap must be between $0 and $5,000." },
    ]);
  });

  it('the cap per interview has its own bounds and cannot be more than the opening\'s cap (row I0.6)', () => {
    const problems = (patch: Record<string, unknown>) => { const r = checkOpeningDetails({ ...good, ...patch }, HMS); return r.ok ? [] : r.problems; };
    expect(problems({ interviewCapUsd: 201 })).toEqual([{ path: 'interviewCapUsd', message: 'The cap per interview must be between $0 and $200.' }]);
    expect(problems({ interviewCapUsd: 'ten' })).toEqual([{ path: 'interviewCapUsd', message: 'The cap per interview must be between $0 and $200.' }]);
    expect(problems({ budgetCapUsd: 20, interviewCapUsd: 25 })).toEqual([{ path: 'interviewCapUsd', message: "The cap per interview cannot be more than the opening's spending cap." }]);
    expect(problems({ budgetCapUsd: 20, interviewCapUsd: 20 })).toEqual([]);
    expect(problems({ budgetCapUsd: null, interviewCapUsd: 25 })).toEqual([]);
    expect(problems({ budgetCapUsd: 5001 })).toEqual([{ path: 'budgetCapUsd', message: "The opening's spending cap must be between $0 and $5,000." }]);
  });

  it('the line above the sentences, and a new opening\'s id', () => {
    expect(problemsLine('kit', 1)).toBe('The kit was not saved: one thing needs fixing.');
    expect(problemsLine('details', 3)).toBe('The details were not saved: 3 things need fixing.');
    expect(openingIdFor('Ingénieure Données (Senior)', new Set())).toBe('op-ingenieure-donnees-senior');
    expect(openingIdFor('iOS Engineer', new Set(['op-ios-engineer', 'op-ios-engineer-2']))).toBe('op-ios-engineer-3');
    expect(openingIdFor('!!!', new Set())).toBe('op-opening');
    expect(EMPTY_KIT).toEqual({ rounds: [], competencies: [], questions: [] });
  });
});

describe('a round\'s surface and a question\'s starting board (WHITEBOARD-PLAN steps 1 and 2)', () => {
  it('a technical round works on the pad or the board; an old kit with no surface reads as the pad', () => {
    expect(roundSurface({ type: 'technical' })).toBe('pad');
    expect(roundSurface({ type: 'technical', surface: 'board' })).toBe('board');
    expect(roundSurface({ type: 'behavioural' })).toBeNull();
    expect(roundSurface(null)).toBeNull();
    const old = seedKit('op-backend');
    for (const r of old.rounds) delete r.surface;
    for (const q of old.questions) delete q.board;
    const r = checkKit(old);
    expect(r.ok && r.value.rounds.map((x) => x.surface)).toEqual(['pad', 'pad', 'pad', undefined]);
  });

  it('the seeded System design round is a board round, and its questions carry the three templates', () => {
    const kit = seedKit('op-backend');
    expect(kit.rounds.find((r) => r.id === 'rd-design')!.surface).toBe('board');
    const boards = kit.questions.filter((q) => q.board).map((q) => q.board!.name);
    expect(boards).toEqual(['Frames with starter notes', 'Prompt and empty frames', 'Master template']);
    const blueprint = kit.questions.find((q) => q.id === 'q-be-ledger')!.board!;
    const frames = blueprint.elements.filter((e) => e['type'] === 'frame').map((e) => e['name']);
    expect(frames).toEqual(['Clarifying questions', 'Requirements', 'Non-functional requirements', 'API', 'High-level design', 'Data model', 'Trade-offs']);
    expect(blueprint.elements.filter((e) => e['type'] === 'rectangle').length).toBe(21);
    // Every element has an index, in order, and every sticky's text is bound to it.
    const idx = blueprint.elements.map((e) => String(e['index']));
    expect([...idx].sort()).toEqual(idx);
    for (const t of blueprint.elements.filter((e) => e['type'] === 'text')) {
      const box = blueprint.elements.find((e) => e['id'] === t['containerId'])!;
      expect(box['boundElements']).toEqual([{ type: 'text', id: t['id'] }]);
    }
    const prompt = kit.questions.find((q) => q.id === 'q-be-shortener')!.board!;
    expect(prompt.elements.some((e) => e['type'] === 'text' && String(e['originalText']).includes('URL shortener'))).toBe(true);
    expect(prompt.elements.filter((e) => e['type'] === 'rectangle').length).toBe(1);
  });

  it('"Design Twitter" is in the master template\'s format: the prompt and "Your design" on its board, the answer key beside it', () => {
    const kit = seedKit('op-backend');
    const q = kit.questions.find((x) => x.id === 'q-be-twitter')!;
    expect(q).toMatchObject({ competencyId: 'system-design', roundType: 'technical' });
    expect(q.board).toEqual(masterBoard(TWITTER_PROMPT, { palette: true }));
    expect(q.board!.elements.filter((e) => e['type'] === 'frame').map((e) => e['name'])).toEqual(MASTER_SECTIONS.map((s) => s.name));
    expect(q.board!.elements.find((e) => e['id'] === 'mt-a-title')!['originalText']).toBe('Design Twitter');
    // The answer key: five questions with answers, the last the enhancement; red flags in all four groups; its own board.
    expect(q.designQuestions!.map((d) => Boolean(d.answer))).toEqual([true, true, true, true, true]);
    expect(q.designQuestions!.map((d) => d.enhancement ?? false)).toEqual([false, false, false, false, true]);
    expect(new Set(q.redFlags!.map((f) => f.group))).toEqual(new Set(['over-engineering', 'responsibility', 'naming', 'other']));
    expect(q.providedDesign!.name).toBe('Provided design');
    // None of the answer key is on the starting board the candidate sees.
    const onBoard = JSON.stringify(q.board);
    for (const d of q.designQuestions!) expect(onBoard).not.toContain(d.answer!.slice(0, 40));
    for (const f of q.redFlags!) expect(onBoard).not.toContain(f.text.slice(0, 40));
    expect(onBoard).not.toContain('Fan-out worker');
    const r = checkKit(kit);
    const saved = r.ok ? r.value.questions.find((x) => x.id === 'q-be-twitter')! : null;
    expect(saved).toEqual(q);
  });

  it('a behavioural round on the board, or a surface the room does not have, is refused', () => {
    const kit = seedKit('op-backend') as unknown as { rounds: Array<Record<string, unknown>> };
    kit.rounds[3]!['surface'] = 'board';
    kit.rounds[0]!['surface'] = 'slides';
    expect(paths(checkKit(kit))).toEqual(['rounds.0.surface', 'rounds.3.surface']);
  });

  it('a board on a behavioural question, an unreadable, empty, unnamed or too large board is refused', () => {
    const at = (q: Record<string, unknown>) => { const kit = seedKit('op-backend') as unknown as { questions: Array<Record<string, unknown>> }; Object.assign(kit.questions[2]!, q); return paths(checkKit(kit)); };
    const board = blueprintBoard();
    expect(at({ board })).toEqual([]);
    expect(at({ board: { ...board, name: '' } })).toEqual(['questions.2.board']);
    expect(at({ board: { name: 'X', elements: 'nope' } })).toEqual(['questions.2.board']);
    expect(at({ board: { name: 'X', elements: [{ id: 'a', type: 'rectangle', isDeleted: true }] } })).toEqual(['questions.2.board']);
    expect(at({ board: { name: 'X', elements: [{ id: 'a', type: 'rectangle' }, { id: 'a', type: 'text' }] } })).toEqual(['questions.2.board']);
    const many = Array.from({ length: KIT_LIMITS.boardElements + 1 }, (_, n) => ({ id: `e${n}`, type: 'rectangle' }));
    expect(at({ board: { name: 'X', elements: many } })).toEqual(['questions.2.board']);
    const kit = seedKit('op-backend') as unknown as { questions: Array<Record<string, unknown>> };
    const behavioural = kit.questions.findIndex((q) => q['roundType'] === 'behavioural');
    kit.questions[behavioural]!['board'] = board;
    expect(paths(checkKit(kit))).toEqual([`questions.${behavioural}.board`]);
  });

  it('a board keeps only its live elements, and checkBoard says why one is refused', () => {
    const r = checkBoard({ name: ' Sketch ', elements: [{ id: 'a', type: 'rectangle' }, { id: 'b', type: 'text', isDeleted: true }] });
    expect(r).toEqual({ ok: true, board: { name: 'Sketch', elements: [{ id: 'a', type: 'rectangle' }] } });
    expect(checkBoard(null)).toEqual({ ok: false, why: 'unreadable' });
    expect(checkBoard({ name: 'x', elements: [] })).toEqual({ ok: false, why: 'empty' });
  });

  it('a starting board holds only the kinds a board draws, and no links (review WB-1, item 8)', () => {
    const r = checkBoard({ name: 'Sketch', elements: [{ id: 'a', type: 'rectangle', link: 'https://example.com' }, { id: 'b', type: 'frame', name: 'API' }] });
    expect(r).toEqual({ ok: true, board: { name: 'Sketch', elements: [{ id: 'a', type: 'rectangle', link: null }, { id: 'b', type: 'frame', name: 'API' }] } });
    for (const type of ['embeddable', 'iframe', 'image', 'magicframe', 'script']) {
      expect(checkBoard({ name: 'Sketch', elements: [{ id: 'a', type: 'rectangle' }, { id: 'b', type, link: 'https://example.com' }] })).toEqual({ ok: false, why: 'kind' });
    }
    const kit = seedKit('op-backend');
    const q = kit.questions.findIndex((x) => x.board);
    kit.questions[q]!.board = { name: 'Sketch', elements: [{ id: 'x', type: 'embeddable', link: 'https://example.com' }] } as never;
    const out = checkKit(kit);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain('embedded page');
  });
});

describe('a system design question\'s clarifying questions (WHITEBOARD-PLAN step 2b)', () => {
  it('the seeded board questions carry three to five, and the kit keeps them as written', () => {
    const kit = seedKit('op-backend');
    for (const id of ['q-be-ledger', 'q-be-shortener', 'q-be-twitter']) {
      const q = kit.questions.find((x) => x.id === id)!;
      expect(q.clarifying!.length).toBeGreaterThanOrEqual(3);
      expect(q.clarifying!.length).toBeLessThanOrEqual(5);
    }
    const r = checkKit(kit);
    expect(r.ok && r.value.questions.find((q) => q.id === 'q-be-ledger')!.clarifying).toEqual(kit.questions.find((q) => q.id === 'q-be-ledger')!.clarifying);
  });

  it('"Design Twitter" asks about the read to write ratio, daily active users, freshness, very large accounts and media', () => {
    const r = checkKit(seedKit('op-backend'));
    expect(r.ok && r.value.questions.find((q) => q.id === 'q-be-twitter')!.clarifying).toEqual([
      'What is the read to write ratio?',
      'How many daily active users?',
      'How fresh must the home timeline be?',
      'What about accounts with very many followers?',
      'Text only, or images and video too?',
    ]);
  });

  it('more than five, an empty one, and any on a behavioural question are refused, each on its own path', () => {
    const kit = seedKit('op-backend');
    const at = kit.questions.findIndex((q) => q.id === 'q-be-ledger');
    kit.questions[at]!.clarifying = ['a?', 'b?', 'c?', 'd?', 'e?', 'f?'];
    expect(paths(checkKit(kit))).toEqual([`questions.${at}.clarifying`]);
    kit.questions[at]!.clarifying = ['Who uses it?', '  '];
    expect(paths(checkKit(kit))).toEqual([`questions.${at}.clarifying.1`]);
    const em = seedKit('op-em');
    em.questions[0]!.clarifying = ['Who uses it?'];
    expect(messages(checkKit(em))).toEqual(['Question 1 is for a behavioural round; clarifying questions belong to a system design question.']);
  });

  it('a question without any keeps none', () => {
    const kit = seedKit('op-backend');
    const r = checkKit(kit);
    expect(r.ok && r.value.questions.filter((q) => !q.clarifying).every((q) => !('clarifying' in q))).toBe(true);
  });
});

describe('a board question\'s answer key: provided design, design questions, red flags (the master template\'s part C)', () => {
  const tech = () => {
    const kit = seedKit('op-backend') as unknown as { questions: Array<Record<string, unknown>> };
    const i = kit.questions.findIndex((q) => q['id'] === 'q-be-shortener');
    return { kit, i };
  };
  const at = (q: Record<string, unknown>) => { const { kit, i } = tech(); Object.assign(kit.questions[i]!, q); return { i, r: checkKit(kit) }; };

  it('an old question has none of the three, and still saves unchanged', () => {
    const { i, r } = at({});
    expect(r.ok).toBe(true);
    const q = r.ok ? r.value.questions[i]! : null;
    expect(q && ['providedDesign', 'designQuestions', 'redFlags'].some((k) => k in q)).toBe(false);
  });

  it('keeps a provided design, the design questions with answers and an enhancement last, and grouped red flags', () => {
    const providedDesign = blueprintBoard();
    const { i, r } = at({
      providedDesign,
      designQuestions: [{ text: ' Who are the actors? ', answer: ' Users and the API. ' }, { text: 'Add trending topics.', enhancement: true }],
      redFlags: [{ group: 'naming', text: ' APIs named as nouns ' }, { group: 'over-engineering', text: 'A service per noun' }],
    });
    expect(paths(r)).toEqual([]);
    const q = r.ok ? r.value.questions[i]! : null;
    expect(q?.providedDesign).toEqual(providedDesign);
    expect(q?.designQuestions).toEqual([{ text: 'Who are the actors?', answer: 'Users and the API.' }, { text: 'Add trending topics.', enhancement: true }]);
    expect(q?.redFlags).toEqual([{ group: 'naming', text: 'APIs named as nouns' }, { group: 'over-engineering', text: 'A service per noun' }]);
    // empty lists are dropped
    const empty = at({ designQuestions: [], redFlags: [] });
    expect(empty.r.ok && !('designQuestions' in empty.r.value.questions[empty.i]!) && !('redFlags' in empty.r.value.questions[empty.i]!)).toBe(true);
  });

  it('refuses too many, too long, an enhancement before the last, an unknown group, and an unreadable or oversized design', () => {
    const q = (n: number) => Array.from({ length: n }, (_, j) => ({ text: `Q${j}` }));
    expect(paths(at({ designQuestions: q(KIT_LIMITS.designQuestions + 1) }).r)).toEqual([`questions.${tech().i}.designQuestions`]);
    expect(paths(at({ designQuestions: [{ text: 'x'.repeat(KIT_LIMITS.designQuestion + 1) }] }).r)).toEqual([`questions.${tech().i}.designQuestions.0.text`]);
    expect(paths(at({ designQuestions: [{ text: 'a', answer: 'x'.repeat(KIT_LIMITS.designAnswer + 1) }] }).r)).toEqual([`questions.${tech().i}.designQuestions.0.answer`]);
    expect(paths(at({ designQuestions: [{ text: 'a', enhancement: true }, { text: 'b' }] }).r)).toEqual([`questions.${tech().i}.designQuestions.0.enhancement`]);
    expect(paths(at({ redFlags: [{ group: 'style', text: 'a' }] }).r)).toEqual([`questions.${tech().i}.redFlags.0`]);
    expect(paths(at({ redFlags: Array.from({ length: KIT_LIMITS.redFlags + 1 }, () => ({ group: 'other', text: 'a' })) }).r)).toEqual([`questions.${tech().i}.redFlags`]);
    expect(paths(at({ redFlags: 'many' }).r)).toEqual([`questions.${tech().i}.redFlags`]);
    // the same flag twice (as written, case and spaces aside) would be one tick on the scorecard: refused on the second
    const twice = at({ redFlags: [{ group: 'naming', text: 'Vague names' }, { group: 'other', text: 'Other one' }, { group: 'responsibility', text: ' vague  NAMES ' }] }).r;
    expect(paths(twice)).toEqual([`questions.${tech().i}.redFlags.2`]);
    expect(paths(at({ providedDesign: { name: 'Key', elements: 'x' } }).r)).toEqual([`questions.${tech().i}.providedDesign`]);
    // its own byte cap, under the starting board's
    const big = { name: 'Key', elements: Array.from({ length: 300 }, (_, n) => ({ id: `e${n}`, type: 'text', text: 'x'.repeat(700) })) };
    expect(checkBoard(big).ok).toBe(true);
    expect(paths(at({ providedDesign: big }).r)).toEqual([`questions.${tech().i}.providedDesign`]);
  });

  it('a behavioural question carries none of them', () => {
    const kit = seedKit('op-backend') as unknown as { questions: Array<Record<string, unknown>> };
    const b = kit.questions.findIndex((q) => q['roundType'] === 'behavioural');
    Object.assign(kit.questions[b]!, { providedDesign: blueprintBoard(), designQuestions: [{ text: 'a' }], redFlags: [{ group: 'other', text: 'a' }] });
    expect(paths(checkKit(kit))).toEqual([`questions.${b}.providedDesign`, `questions.${b}.designQuestions`, `questions.${b}.redFlags`]);
  });
});

describe('the line the interviewer reads to the candidate when a round starts', () => {
  it('a technical round on the pad offers the default; a board round only how to ask; a behavioural round none', () => {
    expect(TECHNICAL_ROUND_INTRO).toBe("If you'd like help, just say 'Hey Milo'. Milo can add test cases for you to speed things up.");
    expect(roundIntro({ type: 'technical' })).toBe(TECHNICAL_ROUND_INTRO);
    expect(roundIntro({ type: 'technical', surface: 'pad' })).toBe(TECHNICAL_ROUND_INTRO);
    expect(roundIntro({ type: 'technical', surface: 'board' })).toBe("If you'd like help, just say 'Hey Milo'.");
    expect(roundIntro({ type: 'behavioural' })).toBeNull();
    expect(roundIntro(null)).toBeNull();
  });

  it('a round\'s own line replaces the default; the kit keeps it trimmed, keeps none for an empty one and refuses one that is too long', () => {
    expect(roundIntro({ type: 'technical', intro: 'Say "Hey Milo" for the time.' })).toBe('Say "Hey Milo" for the time.');
    expect(roundIntro({ type: 'behavioural', intro: 'Milo keeps the time.' })).toBe('Milo keeps the time.');
    const kit = seedKit('op-backend');
    kit.rounds[0]!.intro = '  Say "Hey Milo" for the time.  ';
    (kit.rounds[1] as { intro?: unknown }).intro = '   ';
    const saved = checkKit(kit);
    expect(saved.ok && saved.value.rounds[0]!.intro).toBe('Say "Hey Milo" for the time.');
    expect(saved.ok && 'intro' in saved.value.rounds[1]!).toBe(false);
    kit.rounds[0]!.intro = 'x'.repeat(KIT_LIMITS.intro + 1);
    (kit.rounds[1] as { intro?: unknown }).intro = 7;
    const refused = checkKit(kit);
    expect(paths(refused)).toEqual(expect.arrayContaining(['rounds.0.intro', 'rounds.1.intro']));
    expect(messages(refused)).toEqual(expect.arrayContaining([`Round 1's line to read out is longer than ${KIT_LIMITS.intro} characters.`]));
  });
});
