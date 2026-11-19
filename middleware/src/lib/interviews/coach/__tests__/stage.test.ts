// A suggestion fits where a technical round is (lib/interviews/coach/stage.ts): nothing about complexity before working
// code, nothing about testing before a run; in the stand-in's choice, and for the model's answer in the service.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import { interviewApplicationsFixture, interviewOpeningsFixture, interviewsFixture } from '../../../../mock/interviews.js';
import { interviewSuggestionsFixture } from '../../../../mock/interviews-suggestions.js';
import { scriptedSuggestion } from '../model.js';
import { coachCode, type CoachCode, type CoachInput, type CoachLine } from '../prompt.js';
import { setCoachCodeSource, setCoachDeps, suggestionFor, type CoachDeps, type CoachRef } from '../service.js';
import { codeStage, fitsStage, topicOf } from '../stage.js';
import { MemorySuggestionStore } from '../store.js';
import type { CoachTranscript } from '../transcript.js';

const PAD = { text: 'def two_sum(nums, target):\n    seen = {}\n    return []\n', language: 'python' };
const run = (status: string, exitCode: number | null) => ({ language: 'python', status, result: { exitCode, stdout: '[0, 1]\n', stderr: '' } });

describe('the stage of the code', () => {
  it('none without a code part; not-run with a pad and no run; ran when the last run did not finish cleanly; works on exit 0', () => {
    expect(codeStage(null)).toBeNull();
    expect(codeStage(coachCode(PAD, null))).toBe('not-run');
    expect(codeStage(coachCode(PAD, run('failed', 1)))).toBe('ran');
    expect(codeStage(coachCode(PAD, run('compile_error', null)))).toBe('ran');
    expect(codeStage(coachCode(PAD, run('running', null)))).toBe('ran');
    expect(codeStage(coachCode(PAD, run('succeeded', 1)))).toBe('ran');
    expect(codeStage(coachCode(PAD, run('succeeded', 0)))).toBe('works');
  });

  it.each([
    ['What is the runtime complexity of your solution, in time and in space?', 'complexity'],
    ['What is the big O of that lookup?', 'complexity'],
    ['How would you test this function?', 'testing'],
    ['Which tests would you write first?', 'testing'],
    ['What would you change if the array were already sorted?', null],
  ])('"%s" is about %s', (text, topic) => { expect(topicOf(text)).toBe(topic); });

  it('complexity needs working code; testing needs a run; anything else fits always, and every topic fits a round without code', () => {
    const complexity = 'What is the runtime complexity of your solution?';
    const testing = 'How would you test this function?';
    expect([fitsStage(complexity, 'not-run'), fitsStage(complexity, 'ran'), fitsStage(complexity, 'works')]).toEqual([false, false, true]);
    expect([fitsStage(testing, 'not-run'), fitsStage(testing, 'ran'), fitsStage(testing, 'works')]).toEqual([false, true, true]);
    expect(fitsStage('Can you walk me through it?', 'not-run')).toBe(true);
    expect(fitsStage(complexity, null)).toBe(true);
  });
});

describe('the stand-in follows the stage', () => {
  const FOLLOW = {
    complexity: 'What is the runtime complexity of your solution, in time and in space?',
    testing: 'How would you test this function?',
    sorted: 'What would you change if the array were already sorted?',
  };
  const input = (code: CoachCode | null, lastCandidate: string): CoachInput => ({
    roundType: 'technical',
    competencies: [{ id: 'problem-solving', name: 'Problem solving', lookFor: 'x', anchors: { 1: 'a', 2: 'b', 3: 'c', 4: 'd' } as never }],
    questions: [{ id: 'q-twosum', competencyId: 'problem-solving', prompt: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.', followUps: [FOLLOW.complexity, FOLLOW.testing, FOLLOW.sorted] }],
    chosenQuestionIds: ['q-twosum'],
    lines: [
      { seq: 1, side: 'panel', text: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.' },
      { seq: 2, side: 'candidate', text: lastCandidate },
    ],
    previous: [],
    ...(code ? { code } : {}),
  });
  // The candidate's line shares the most words with the complexity follow-up, then with the testing one.
  const aboutCost = 'I think the runtime complexity is fine in time and in space, and I would test this function later.';

  it('before a run: neither the complexity nor the testing follow-up, though the line fits them best', () => {
    expect(scriptedSuggestion(input(coachCode(PAD, null), aboutCost))?.text).toBe(FOLLOW.sorted);
  });
  it('after a run that did not finish cleanly: the testing follow-up, not yet the complexity one', () => {
    expect(scriptedSuggestion(input(coachCode(PAD, run('failed', 1)), aboutCost))?.text).toBe(FOLLOW.testing);
  });
  it('with working code: the complexity follow-up', () => {
    expect(scriptedSuggestion(input(coachCode(PAD, run('succeeded', 0)), aboutCost))?.text).toBe(FOLLOW.complexity);
  });
  it('a round without code holds nothing back', () => {
    expect(scriptedSuggestion(input(null, aboutCost))?.text).toBe(FOLLOW.complexity);
  });
});

describe('the model\'s answer in the service', () => {
  const IV = 'iv-k1p5w8ra'; // Mateo's coding round (technical)
  const store = new MemorySuggestionStore();
  let code: { pad: typeof PAD | null; lastRun: unknown } = { pad: PAD, lastRun: null };
  const refOf = (): CoachRef => {
    const interview = { ...interviewsFixture.rows().find((i) => i.id === IV)!, state: 'live' as never };
    const app = interviewApplicationsFixture.rows().find((a) => a.id === interview.applicationId)!;
    return { interview, opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)! };
  };
  const ref = () => refOf();
  const lines: CoachLine[] = [{ seq: 1, side: 'candidate', text: 'I use a hash map of what I have seen.' }];
  const transcript: CoachTranscript = { callId: 'call-1', lastSeq: 1, lines };
  let n = 0;
  const answerWith = (text: string) => {
    const competencyId = ref().opening.kit.competencies[0]!.id;
    setCoachDeps({
      store: () => store,
      consents: async () => ({ transcription: true, milo: true }),
      transcript: async () => transcript,
      model: () => ({ kind: 'bedrock', modelId: 'amazon.nova-pro-v1:0', suggest: async () => ({ raw: JSON.stringify({ text, competencyId, basedOn: null }), code: 'ok', sent: true, usage: null }) }),
      reserve: async (i: { key: string; estimateUsd: number }) => ({ ok: true, holdId: `h-${i.key}`, sourceId: `s-${i.key}`, amountUsd: i.estimateUsd }),
      settle: async () => undefined,
      release: async () => undefined,
      now: () => Date.UTC(2026, 11, 1, 15, 0),
      newId: () => `sg-${++n}`,
    } as unknown as CoachDeps);
  };

  beforeEach(() => {
    fixtureRegistry.resetAll('default');
    interviewSuggestionsFixture.rows().splice(0);
    code = { pad: PAD, lastRun: null };
    setCoachCodeSource(async () => code as never);
  });
  afterAll(() => { setCoachDeps(null); setCoachCodeSource(null); });

  it('a complexity question before working code is kept as nothing, never shown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    answerWith('What is the runtime complexity of your solution?');
    const out = await suggestionFor(ref(), { userId: ref().interview.leadId });
    expect(out.kind === 'ok' && out.body.suggestion).toBeNull();
    expect((await store.listSuggestions(IV)).at(-1)).toEqual(expect.objectContaining({ dropped: 'nothing', text: '', shownAt: null }));
    warn.mockRestore();
  });

  it('the same question once the last run finished cleanly is shown', async () => {
    code = { pad: PAD, lastRun: run('succeeded', 0) };
    answerWith('What is the runtime complexity of your solution?');
    const out = await suggestionFor(ref(), { userId: ref().interview.leadId });
    expect(out.kind === 'ok' && out.body.suggestion?.text).toBe('What is the runtime complexity of your solution?');
  });
});
