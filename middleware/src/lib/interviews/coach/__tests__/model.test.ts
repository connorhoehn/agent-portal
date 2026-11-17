// The coach's model (lib/interviews/coach/model.ts; row I3.3). The Bedrock class runs only over an injected fake client:
// no test reaches a provider.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockCoachModel, coachModelId, DEFAULT_COACH_MODEL_ID, ScriptedCoachModel, scriptedSuggestion } from '../model.js';
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
  it('asks the next competency with no question yet, quoting the last candidate line', () => {
    expect(scriptedSuggestion(FIXED_INPUT)).toEqual({
      text: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration',
      basedOn: 'The payments queue backed up, so I paged the on-call lead and we split the work.',
    });
  });

  it('goes to the follow-ups once every competency is covered, then has nothing left', () => {
    const covered: CoachInput = { ...FIXED_INPUT, previous: [{ text: 'Tell me about a time you disagreed with a technical decision.', competencyId: 'collaboration', answer: 'ask' }] };
    expect(scriptedSuggestion(covered)).toMatchObject({ text: 'Who did you bring in, and when?', competencyId: 'communication' });
    const done: CoachInput = { ...covered, previous: [...covered.previous,
      { text: 'Who did you bring in, and when?', competencyId: 'communication', answer: 'skip' },
      { text: 'What did you do once it was decided?', competencyId: 'collaboration', answer: 'ask' }] };
    expect(scriptedSuggestion(done)).toBeNull();
  });

  it('quotes nothing before the candidate has spoken, and answers as raw JSON the parser reads', async () => {
    const quiet = { ...FIXED_INPUT, lines: FIXED_INPUT.lines.filter((l) => l.side === 'panel') };
    expect(scriptedSuggestion(quiet)?.basedOn).toBeNull();
    const out = await new ScriptedCoachModel().suggest(FIXED_INPUT);
    expect(out.code).toBe('ok');
    expect(JSON.parse(out.raw!)).toEqual(scriptedSuggestion(FIXED_INPUT));
  });
});
