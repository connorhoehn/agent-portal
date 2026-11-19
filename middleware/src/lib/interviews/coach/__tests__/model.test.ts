// The coach's model (lib/interviews/coach/model.ts; row I3.3). The Bedrock class runs only over an injected fake client:
// no test reaches a provider.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockCoachModel, coachModelChoice, coachModelId, DEFAULT_COACH_MODEL_ID, ScriptedCoachModel, questionAsked, scriptedSuggestion } from '../model.js';
import type { CoachInput } from '../prompt.js';
import { FIXED_INPUT } from './fixed-input.js';

describe('the Bedrock model, over a fake client', () => {
  it('sends the Converse request for its model and returns the text and the usage', async () => {
    const sent: ConverseCommand[] = [];
    const model = new BedrockCoachModel({
      modelId: 'amazon.nova-lite-v1:0',
      send: async (cmd) => {
        sent.push(cmd);
        return { output: { message: { role: 'assistant', content: [{ text: '{"text":"Who else?","competencyId":"communication","basedOn":null}' }] } }, usage: { inputTokens: 900, outputTokens: 30, totalTokens: 930 } } as never;
      },
    });
    const out = await model.suggest(FIXED_INPUT);
    expect(out).toEqual({ raw: '{"text":"Who else?","competencyId":"communication","basedOn":null}', code: 'ok', sent: true, usage: { inputTokens: 900, outputTokens: 30 } });
    expect(sent[0]!.input.modelId).toBe('amazon.nova-lite-v1:0');
    expect(sent[0]!.input.inferenceConfig?.maxTokens).toBe(300);
  });

  it('a failure is a code, and nothing of the request is logged', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = new BedrockCoachModel({ send: async () => { throw Object.assign(new Error('the transcript said: secret words'), { name: 'ThrottlingException' }); } });
    expect(await err.suggest(FIXED_INPUT)).toMatchObject({ raw: null, code: 'error', sent: false }); // refused: nothing ran, nothing to book
    const slow = new BedrockCoachModel({ timeoutMs: 5, send: (_c, { abortSignal }) => new Promise((_r, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')))) });
    expect(await slow.suggest(FIXED_INPUT)).toMatchObject({ code: 'timeout' });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|payments queue/);
    warn.mockRestore();
  });

  it('books spend only for a call that may have run: a refusal is not sent, a timeout or a server failure is', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = (e: unknown) => new BedrockCoachModel({ send: async () => { throw e; } }).suggest(FIXED_INPUT);
    for (const name of ['AccessDeniedException', 'UnrecognizedClientException', 'CredentialsProviderError', 'ValidationException']) {
      expect([name, (await failing(Object.assign(new Error('x'), { name }))).sent]).toEqual([name, false]);
    }
    expect((await failing(Object.assign(new Error('x'), { name: 'Other', $fault: 'client' }))).sent).toBe(false);
    expect((await failing(Object.assign(new Error('x'), { name: 'Other', $metadata: { httpStatusCode: 403 } }))).sent).toBe(false);
    expect((await failing(Object.assign(new Error('x'), { name: 'InternalServerException', $fault: 'server', $metadata: { httpStatusCode: 500 } }))).sent).toBe(true);
    expect((await failing(new Error('socket hang up'))).sent).toBe(true);
    warn.mockRestore();
  });

  it('takes its model id from INTERVIEWS_COACH_MODEL_ID, else Nova Pro', () => {
    expect(coachModelId({})).toBe(DEFAULT_COACH_MODEL_ID);
    expect(DEFAULT_COACH_MODEL_ID).toBe('amazon.nova-pro-v1:0');
    expect(coachModelId({ INTERVIEWS_COACH_MODEL_ID: 'amazon.nova-lite-v1:0' })).toBe('amazon.nova-lite-v1:0');
    expect(coachModelId({ INTERVIEWS_COACH_MODEL_ID: 'not a model id!' })).toBe(DEFAULT_COACH_MODEL_ID);
  });
});

describe('the scripted stand-in', () => {
  it('stays inside the round: the chosen question\'s follow-up, never a question of a competency nobody chose', () => {
    expect(scriptedSuggestion(FIXED_INPUT)).toEqual({ text: 'Who did you bring in, and when?', competencyId: 'communication', basedOn: null });
    const done: CoachInput = { ...FIXED_INPUT, previous: [{ text: 'Who did you bring in, and when?', competencyId: 'communication', answer: 'skip' }] };
    expect(scriptedSuggestion(done)).toBeNull();
  });

  it('offers the follow-up that fits the candidate\'s last line, quoting it ("fail over" meets "failover")', () => {
    const keyed: CoachInput = {
      ...FIXED_INPUT,
      questions: [{ ...FIXED_INPUT.questions[0]!, followUps: ['Who did you bring in, and when?', 'What happens when the failover lands mid-write?'] }, FIXED_INPUT.questions[1]!],
      lines: [...FIXED_INPUT.lines, { seq: 3, side: 'candidate', text: 'Then we had to fail over to the second region.' }],
    };
    expect(scriptedSuggestion(keyed)).toEqual({ text: 'What happens when the failover lands mid-write?', competencyId: 'communication', basedOn: 'Then we had to fail over to the second region.' });
  });

  it('the next chosen question before any follow-up; with nothing chosen, the first competency with no question', () => {
    const two: CoachInput = { ...FIXED_INPUT, chosenQuestionIds: ['q-incident', 'q-disagree'] };
    expect(scriptedSuggestion(two)).toEqual({ text: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration', basedOn: null });
    const none: CoachInput = { ...FIXED_INPUT, chosenQuestionIds: [] };
    expect(scriptedSuggestion(none)).toEqual({ text: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration', basedOn: null });
  });

  it('answers as raw JSON the parser reads', async () => {
    const out = await new ScriptedCoachModel().suggest(FIXED_INPUT);
    expect(out.code).toBe('ok');
    expect(JSON.parse(out.raw!)).toEqual(scriptedSuggestion(FIXED_INPUT));
  });
});

describe('INTERVIEWS_COACH_MODEL', () => {
  const live = { MEETING_ASSISTANT_LIVE: '1' } as NodeJS.ProcessEnv;
  it('scripted keeps the stand-in even with the live session forced on (a developer\'s machine)', () => {
    expect(coachModelChoice({ ...live, INTERVIEWS_COACH_MODEL: 'scripted' })).toBe('scripted');
  });
  it('a production process ignores scripted; bedrock asks for the model', () => {
    const prod = { NODE_ENV: 'production', ...live } as NodeJS.ProcessEnv;
    expect(coachModelChoice({ ...prod, INTERVIEWS_COACH_MODEL: 'scripted' })).toBe(coachModelChoice(prod));
    expect(coachModelChoice({ INTERVIEWS_COACH_MODEL: 'bedrock' } as NodeJS.ProcessEnv)).toBe('bedrock');
  });
});

describe('a question already asked is never suggested again', () => {
  const TWO_SUM = 'Given an array of integers and a target, return the indices of the two numbers that add up to the target.';
  const tech: CoachInput = {
    ...FIXED_INPUT, roundType: 'technical',
    questions: [{ id: 'q-two-sum', prompt: TWO_SUM, followUps: [], competencyId: 'communication' }],
    chosenQuestionIds: ['q-two-sum'],
    lines: [{ seq: 1, side: 'panel', text: 'Okay, a coding problem. I am going to post it into the pad.' }],
    previous: [],
  };
  const pad = (text: string): CoachInput => ({ ...tech, code: { pad: { language: 'python', text, cut: false }, run: null } });
  it('is suggested while nothing shows it was asked', () => {
    expect(scriptedSuggestion(tech)?.text).toBe(TWO_SUM);
  });
  it('counts the prompt posted into the pad as a wrapped comment', () => {
    const posted = '# Given an array of integers and a target, return the indices of the two\n# numbers that add up to the target.\n\ndef two_sum(nums, target):\n    pass\n';
    expect(scriptedSuggestion(pad(posted))).toBeNull();
    expect(questionAsked(pad(posted), TWO_SUM)).toBe(true);
  });
  it('is not fooled by a pad that only shares words with the question', () => {
    expect(questionAsked(pad('def f(numbers, target):\n    return indices\n'), TWO_SUM)).toBe(false);
  });
  it('matches whole words: a short prompt is not found inside a longer name', () => {
    const short: CoachInput = { ...pad('def two_summary(nums):\n    pass\n'), questions: [{ id: 'q-short', prompt: 'Two sum', followUps: [], competencyId: 'communication' }] };
    expect(questionAsked(short, 'Two sum')).toBe(false);
    expect(questionAsked({ ...short, code: { pad: { language: 'python', text: '# Two sum\ndef f(nums):\n    pass\n', cut: false }, run: null } }, 'Two sum')).toBe(true);
    expect(questionAsked({ ...short, code: null, lines: [{ seq: 1, side: 'panel', text: 'Here is a two summary of the plan.' }] }, 'Two sum')).toBe(false);
  });
  it('when two bank questions share an opening, only the whole prompt counts', () => {
    const PAIRS = 'Given an array of integers and a target, count the pairs that add up to the target.';
    const both: CoachInput = { ...tech, questions: [...tech.questions, { id: 'q-pairs', prompt: PAIRS, followUps: [], competencyId: 'communication' }] };
    const posted = '# Given an array of integers and a target, return the indices of the two\n# numbers that add up to the target.\n';
    const withPad = { ...both, code: { pad: { language: 'python' as const, text: posted, cut: false }, run: null } };
    expect(questionAsked(withPad, TWO_SUM)).toBe(true);
    expect(questionAsked(withPad, PAIRS)).toBe(false);
  });
});

// The live take of 2026-11-19, in its shapes with other words: the lead's Prepare insert put the prompt into the pad as a
// wrapped comment above the starter, the coach thought 3 s before the lead's next 30 s snapshot reached the log and offered
// the question again; later the live transcript put the follow-up's last word at the head of the candidate's answer
// ("So, what's the runtime" / "complexity? Oh! ...") and the coach offered that follow-up after it was answered.
describe('the live take: a question in the pad, a follow-up split at a speaker change', () => {
  const WIDGETS = 'Given a list of widgets and a budget, return the positions of the two widgets whose prices add up to the budget. Each input has exactly one answer, and the same widget may not be used twice.';
  const COMPLEXITY = 'What is the runtime complexity of your solution, in time and in space?';
  const TESTING = 'How would you test this function?';
  const SORTED = 'What would you change if the list were already sorted?';
  /** The pad's insert: the prompt wrapped to 60 columns, each line behind the language's comment mark. */
  const commented = (prompt: string, mark: string): string => {
    const out: string[] = []; let cur = '';
    for (const w of prompt.split(' ')) { if (cur && cur.length + 1 + w.length > 60 - mark.length - 1) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
    return [...out, cur].map((l) => `${mark} ${l}`).join('\n');
  };
  const CODE: Record<string, { mark: string; code: string }> = {
    python: { mark: '#', code: 'def pick(prices, budget):\n    seen = {}\n    for i, p in enumerate(prices):\n        if budget - p in seen:\n            return [seen[budget - p], i]\n        seen[p] = i\n    return []\n\n\nprint(pick([2, 7, 11, 15], 9))\n' },
    go: { mark: '//', code: 'package main\n\nfunc pick(prices []int, budget int) []int {\n\treturn nil\n}\n' },
    java: { mark: '//', code: 'class Main {\n    static int[] pick(int[] prices, int budget) {\n        return new int[0];\n    }\n}\n' },
  };
  const base: CoachInput = {
    ...FIXED_INPUT, roundType: 'technical',
    questions: [{ id: 'q-widgets', prompt: WIDGETS, followUps: [COMPLEXITY, TESTING, SORTED], competencyId: 'communication' }],
    chosenQuestionIds: ['q-widgets'],
    lines: [
      { seq: 1, side: 'panel', text: 'Okay, a coding problem. I am going to post it into the pad. Here it comes' },
      { seq: 2, side: 'candidate', text: '. Okay. Give me a second to look at it Hmm. A list of widgets. A budget? Return the positions' },
    ],
    previous: [],
  };
  const works = { language: 'python', status: 'succeeded', exitCode: 0, output: '[0, 1]', cut: false };

  it('counts the prompt as asked from the pad log\'s insert while the snapshot is still the text from before it', () => {
    const before: CoachInput = { ...base, code: { pad: { language: 'python', text: '', cut: false }, run: null } };
    expect(scriptedSuggestion(before)?.text).toBe(WIDGETS);
    const inserted: CoachInput = { ...base, code: { ...before.code!, posted: ['q-widgets'] } };
    expect(questionAsked(inserted, WIDGETS)).toBe(true);
    expect(scriptedSuggestion(inserted)).toBeNull();
    // With no snapshot at all, the insert alone still counts; another question's insert does not.
    expect(questionAsked({ ...base, code: { pad: null, run: null, posted: ['q-widgets'] } }, WIDGETS)).toBe(true);
    expect(questionAsked({ ...base, code: { pad: null, run: null, posted: ['q-other'] } }, WIDGETS)).toBe(false);
  });

  it.each(Object.entries(CODE))('counts the wrapped comment above the candidate\'s %s code once the snapshot holds it', (language, { mark, code }) => {
    const text = `${commented(WIDGETS, mark)}\n${code}`;
    expect(text.split('\n').filter((l) => l.startsWith(`${mark} `)).length).toBeGreaterThan(2);
    expect(questionAsked({ ...base, code: { pad: { language, text, cut: false }, run: null } }, WIDGETS)).toBe(true);
    expect(questionAsked({ ...base, code: { pad: { language, text: code, cut: false }, run: null } }, WIDGETS)).toBe(false);
  });

  const afterRun = (lines: CoachInput['lines']): CoachInput => ({
    ...base,
    lines: [...base.lines, ...lines],
    code: { pad: { language: 'python', text: `${commented(WIDGETS, '#')}\n${CODE['python']!.code}`, cut: false }, run: works, posted: ['q-widgets'] },
  });
  const SPLIT = [
    { seq: 3, side: 'panel' as const, text: '. So, what\'s the runtime' },
    { seq: 4, side: 'candidate' as const, text: 'complexity? Oh! It\'s linear time! Since we only pass through the list once. And linear space for the map' },
    { seq: 5, side: 'panel' as const, text: 'And if the list were already sorted, would you do anything different? Then' },
    { seq: 6, side: 'candidate' as const, text: 'I\'d use two pointers, one at each end, and walk them toward each other. That gets the extra space down to constant' },
  ];

  it('reads a question\'s last word that opened the candidate\'s answer as the panel\'s, and offers the follow-up not yet asked', () => {
    const input = afterRun(SPLIT);
    expect(questionAsked(input, COMPLEXITY)).toBe(true);
    expect(questionAsked(input, SORTED)).toBe(true);
    expect(questionAsked(input, TESTING)).toBe(false);
    expect(scriptedSuggestion(input)).toEqual({ text: TESTING, competencyId: 'communication', basedOn: null });
  });

  it('takes only a short first fragment, from the very next line, and only someone else\'s', () => {
    // The answer's first sentence is the candidate's own (more than three words): not read as the question's end.
    const long = afterRun([SPLIT[0]!, { ...SPLIT[1]!, text: 'complexity is linear in time, I think. And linear space for the map' }]);
    expect(questionAsked(long, COMPLEXITY)).toBe(false);
    // A line left out between them (nobody was credited with it): no join across the gap.
    expect(questionAsked(afterRun([SPLIT[0]!, { ...SPLIT[1]!, seq: 5 }]), COMPLEXITY)).toBe(false);
    // The whole question in one panel line counts as before.
    expect(questionAsked(afterRun([{ seq: 3, side: 'panel', text: 'So, what\'s the runtime complexity?' }]), COMPLEXITY)).toBe(true);
  });
});
