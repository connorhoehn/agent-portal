// Milo's model for the lead's private questions (lib/interviews/milo-notes/model.ts; row I3.6, contract E0).
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import type { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { setCoachModelFactory, ScriptedCoachModel, BedrockCoachModel } from '../../coach/model.js';
import { BedrockMiloModel, contentWords, makeMiloModel, ScriptedMiloModel, scriptedAnswer } from '../model.js';
import { parseAskAnswer } from '../parse.js';
import { NOT_SAID } from '../prompt.js';
import { FIXED_ASK } from './fixed-input.js';

afterEach(() => setCoachModelFactory(null));

describe('the Bedrock model', () => {
  it('sends the ask request for its model and returns the text and the usage', async () => {
    const sent: ConverseCommand[] = [];
    const m = new BedrockMiloModel({ modelId: 'amazon.nova-pro-v1:0', send: async (cmd) => {
      sent.push(cmd);
      return { output: { message: { role: 'assistant', content: [{ text: '{"answer":"x","sources":[]}' }] } }, usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } } as never;
    } });
    expect(await m.ask(FIXED_ASK)).toEqual({ raw: '{"answer":"x","sources":[]}', code: 'ok', sent: true, usage: { inputTokens: 900, outputTokens: 40 } });
    expect(sent[0]!.input.modelId).toBe('amazon.nova-pro-v1:0');
    expect(sent[0]!.input.inferenceConfig).toEqual({ maxTokens: 400, temperature: 0 });
  });

  it('turns a failure and a timeout into codes, logging the error\'s name only', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = new BedrockMiloModel({ send: async () => { throw Object.assign(new Error('the transcript said: secret words'), { name: 'ThrottlingException' }); } });
    expect(await err.ask(FIXED_ASK)).toEqual({ raw: null, code: 'error', sent: true, usage: null });
    const slow = new BedrockMiloModel({ timeoutMs: 5, send: (_c, { abortSignal }) => new Promise((_r, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')))) });
    expect((await slow.ask(FIXED_ASK)).code).toBe('timeout');
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret words|paged/);
    warn.mockRestore();
  });

  it('sends any request built as data (the question plan uses this)', async () => {
    const sent: ConverseCommand[] = [];
    const m = new BedrockMiloModel({ send: async (cmd) => { sent.push(cmd); return { output: { message: { role: 'assistant', content: [{ text: 'ok' }] } } } as never; } });
    const req = { modelId: m.modelId, messages: [{ role: 'user' as const, content: [{ text: 'plan' }] }] };
    expect((await m.converse(req)).raw).toBe('ok');
    expect(sent[0]!.input).toEqual(req);
  });
});

describe('the scripted stand-in', () => {
  it('quotes the candidate lines that share the question\'s words, and its answer passes the real parse', async () => {
    const out = scriptedAnswer(FIXED_ASK);
    expect(out).toEqual({ answer: 'The candidate spoke of it in line 2.', sources: [{ seq: 2, quote: FIXED_ASK.lines[1]!.text }] });
    const raw = (await new ScriptedMiloModel().ask(FIXED_ASK)).raw;
    expect(parseAskAnswer(raw, FIXED_ASK.lines)).toEqual({ ok: true, value: out });
  });

  it('never quotes the panel, and says the transcript does not say when nothing matches', () => {
    expect(scriptedAnswer({ ...FIXED_ASK, question: 'What happened first?' }).sources.every((s) => s.seq !== 1)).toBe(true);
    expect(scriptedAnswer({ ...FIXED_ASK, question: 'What about kubernetes?' })).toEqual({ answer: NOT_SAID, sources: [] });
    expect(scriptedAnswer({ ...FIXED_ASK, question: 'what did they say?' })).toEqual({ answer: NOT_SAID, sources: [] });
  });

  it('reads content words only', () => {
    expect(contentWords('What did they say about the alerts and alert?')).toEqual(['alert']);
    expect(contentWords('Paged, paging, page')).toEqual(['pag']);
  });
});

describe('the one switch', () => {
  it('follows the coach\'s model choice', () => {
    setCoachModelFactory(() => new ScriptedCoachModel());
    expect(makeMiloModel().kind).toBe('scripted');
    setCoachModelFactory(() => new BedrockCoachModel({ send: async () => { throw new Error('never'); } }));
    expect(makeMiloModel().kind).toBe('bedrock');
  });
});
