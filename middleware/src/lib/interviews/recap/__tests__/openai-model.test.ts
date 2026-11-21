jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { TextToolError, textToolBody, type TextToolRequest } from '../../../voice/openai-text.js';
import { extractedRecap, OpenAIRecapModel } from '../openai-model.js';
import { parseRecapAnswer } from '../parse.js';
import { FIXED_INPUT } from './fixed-input.js';
import { makeRecapModel } from '../model.js';
import { ScriptedCoachModel, setCoachModelFactory } from '../../coach/model.js';
import { scriptedPadWriter } from '../../milo-tools/writer.js';

afterEach(() => { delete process.env['INTERVIEWS_RECAP_MODEL']; setCoachModelFactory(null); });

test('the live recap sends fenced transcript through store:false and keeps usage for accounting', async () => {
  let request: TextToolRequest | undefined;
  const raw = JSON.stringify({ competencies: [], notCovered: ['communication'] });
  const model = new OpenAIRecapModel({ request: async (r) => { request = r; return { call: { name: 'record_recap', arguments: raw }, text: '', usage: { input: 100, output: 20 }, ms: 1 }; } });
  expect(await model.write(FIXED_INPUT)).toEqual({ raw, code: 'ok', sent: true, usage: { inputTokens: 100, outputTokens: 20 } });
  expect(textToolBody(request!).store).toBe(false);
  expect(request!.input).toContain('<untrusted-');
  expect(request!.instructions).toContain('never judge');
});

test('an unexpected tool does not become a recap', async () => {
  const model = new OpenAIRecapModel({ request: async () => ({ call: { name: 'wrong', arguments: '{}' }, text: '', usage: null, ms: 1 }) });
  expect(await model.write(FIXED_INPUT)).toMatchObject({ raw: null, code: 'error', sent: true });
});

test('extractive claims keep exact source words and still go through the common source guards', () => {
  const raw = JSON.stringify({ competencies: [{ id: 'communication', evidence: [
    { seq: 2, quote: 'The payments queue backed up' },
    { seq: 1, quote: 'Tell me about an incident you led.' },
    { seq: 4, quote: 'I fixed the database myself.' },
  ] }], notCovered: [] });
  const result = parseRecapAnswer(extractedRecap(raw), { competencyIds: ['communication'], lines: FIXED_INPUT.lines });
  expect(result.ok && result.recap.competencies[0]!.evidence).toEqual([
    { seq: 2, quote: 'The payments queue backed up', text: 'The candidate said this.' },
  ]);
  expect(result.ok && result.droppedClaims).toBe(2);
});

test('free-form claims cannot sneak through the extraction adapter', () => {
  expect(extractedRecap(JSON.stringify({ competencies: [{ id: 'communication', evidence: [
    { seq: 2, quote: 'The payments queue backed up', text: 'The candidate is excellent.' },
  ] }], notCovered: [] }))).toBeNull();
  expect(extractedRecap('not JSON')).toBeNull();
});

test.each([['no-key', 'error', false], ['timeout', 'timeout', true]] as const)('%s preserves failure and spend state', async (kind, code, sent) => {
  const model = new OpenAIRecapModel({ request: async () => { throw new TextToolError('test', kind); } });
  expect(await model.write(FIXED_INPUT)).toEqual({ raw: null, code, sent, usage: null });
});

test('live recap and writer can be selected without changing the scripted coach', () => {
  setCoachModelFactory(() => new ScriptedCoachModel());
  expect(makeRecapModel().kind).toBe('scripted');
  process.env['INTERVIEWS_RECAP_MODEL'] = 'openai';
  expect(makeRecapModel().kind).toBe('openai');
  expect(scriptedPadWriter({})).toBe(true);
  expect(scriptedPadWriter({ MILO_PAD_WRITER_LIVE: '1' })).toBe(false);
});
