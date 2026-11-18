// The coach's model (lib/interviews/coach/model.ts; row I3.3). The Bedrock class runs only over an injected fake client:
// no test reaches a provider.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockCoachModel, coachModelChoice, coachModelId, DEFAULT_COACH_MODEL_ID, ScriptedCoachModel, scriptedSuggestion } from '../model.js';
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
