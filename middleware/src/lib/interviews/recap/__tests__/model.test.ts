// The recap's model (lib/interviews/recap/model.ts; row I5.2, contract E0): the scripted stand-in quotes the answers to the
// asked questions and invents nothing; the Bedrock class runs only over an injected fake client; one switch picks.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { ScriptedCoachModel, BedrockCoachModel, setCoachModelFactory } from '../../coach/model.js';
import { ANSWER_TEXT, BedrockRecapModel, makeRecapModel, ScriptedRecapModel, scriptedRecap } from '../model.js';
import { parseRecapAnswer } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';

afterEach(() => setCoachModelFactory(null));

describe('the scripted recap', () => {
  it('quotes each candidate line after an asked question, under that question\'s competency, and lists the rest as not covered', () => {
    expect(scriptedRecap(FIXED_INPUT)).toEqual({
      competencies: [{ id: 'communication', evidence: [
        { text: ANSWER_TEXT, seq: 2, quote: 'The payments queue backed up, so I paged the on-call lead and we split the work.' },
        { text: ANSWER_TEXT, seq: 4, quote: 'The database owner, about ten minutes in, once we saw the lock waits.' },
      ] }],
      notCovered: ['collaboration'],
    });
  });

  it('passes its own parse, and says nothing when no asked question was heard', async () => {
    const raw = (await new ScriptedRecapModel().write(FIXED_INPUT)).raw;
    expect(parseRecapAnswer(raw, { competencyIds: ['communication', 'collaboration'], lines: FIXED_INPUT.lines })).toMatchObject({ ok: true, droppedClaims: 0 });
    expect(scriptedRecap({ ...FIXED_INPUT, questions: [] })).toEqual({ competencies: [], notCovered: ['communication', 'collaboration'] });
  });
});

describe('the Bedrock recap', () => {
  it('sends the request and returns the text and the usage', async () => {
    const send = jest.fn(async (_cmd: ConverseCommand) => ({
      output: { message: { role: 'assistant', content: [{ text: '{"competencies":[],"notCovered":[]}' }] } }, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 },
    }));
    const out = await new BedrockRecapModel({ send: send as never, modelId: 'amazon.nova-pro-v1:0' }).write(FIXED_INPUT);
    expect(out).toEqual({ raw: '{"competencies":[],"notCovered":[]}', code: 'ok', sent: true, usage: { inputTokens: 900, outputTokens: 40 } });
    expect((send.mock.calls[0]![0] as unknown as { input: { modelId: string } }).input.modelId).toBe('amazon.nova-pro-v1:0');
  });

  it('turns a failure into a code and logs only the error\'s name', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = jest.fn(async () => { throw Object.assign(new Error('the transcript said …'), { name: 'ThrottlingException' }); });
    const out = await new BedrockRecapModel({ send: send as never }).write(FIXED_INPUT);
    expect(out).toEqual({ raw: null, code: 'error', sent: true, usage: null });
    expect(warn.mock.calls.flat().join(' ')).not.toContain('transcript said');
    warn.mockRestore();
  });

  it('times out as a code', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = jest.fn((_c: unknown, opts: { abortSignal: AbortSignal }) => new Promise((_r, reject) => opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))));
    expect((await new BedrockRecapModel({ send: send as never, timeoutMs: 5 }).write(FIXED_INPUT)).code).toBe('timeout');
    warn.mockRestore();
  });
});

it('follows the coach\'s one switch', () => {
  setCoachModelFactory(() => new ScriptedCoachModel());
  expect(makeRecapModel().kind).toBe('scripted');
  setCoachModelFactory(() => new BedrockCoachModel({ send: (async () => ({})) as never }));
  expect(makeRecapModel().kind).toBe('bedrock');
});
