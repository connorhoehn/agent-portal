// The kit and an opening's details, checked before anything is written (lib/interviews/kit.ts; rows I1.3, I1.8).
import {
  EMPTY_KIT, KIT_LIMITS, NOTHING_IN_USE, checkKit, checkOpeningDetails, kitInUse, openingIdFor, problemsLine, roundHasPad,
} from '../kit.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewScorecardsFixture, interviewsFixture } from '../../../mock/interviews.js';
import { EM_KIT } from '../../../mock/interviews-behavioural.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import type { OpeningKit } from '../types.js';

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
      { path: 'questions.6.id', message: 'Question 7 repeats question 1; remove one of them.' },
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
    expect([...u.roundIds].sort()).toEqual(['rd-coding', 'rd-design', 'rd-together']);
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
    kit.rounds[2]!.type = 'technical';
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
    expect(r.ok && r.value).toEqual({ ...good, title: 'Data Engineer', budgetCapUsd: 12.35 });
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
      { path: 'budgetCapUsd', message: 'The cap per interview must be between $0 and $1,000.' },
    ]);
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
