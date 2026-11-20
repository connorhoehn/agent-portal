// The text and speech provider calls: `store: false` on every text request, the key never leaks, TTS speaks the exact input,
// and the model, voice and backend are config.
import { requestToolChoice, textToolBody, readTextToolReply, _setTextFetch, TextToolError } from '../openai-text.js';
import { streamSpeech, ttsBody, openAiSpeech, _setTtsFetch, TtsError, DEFAULT_TTS_MODEL } from '../openai-tts.js';
import { speechBackend } from '../speech.js';
import type { ResponsesFunctionTool } from '../catalogue.js';

const KEY = 'sk-test-secret-key';
const ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'MILO_TTS_MODEL', 'MILO_TTS_VOICE', 'MILO_TTS_BACKEND', 'VOICE_VOICE'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } process.env['OPENAI_API_KEY'] = KEY; });
afterEach(() => {
  _setTextFetch(null); _setTtsFetch(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const TOOL: ResponsesFunctionTool = { type: 'function', name: 'time_left', description: 'Say how much time is left.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };
const REQ = { model: 'gpt-4.1-mini', instructions: 'i', input: 'Milo, time?', tools: [TOOL], toolChoice: 'required' as const };
const OK = JSON.stringify({ output: [{ type: 'function_call', name: 'time_left', arguments: '{}' }], usage: { input_tokens: 9, output_tokens: 2 } });

/** A fake text transport: records what was sent, answers from `replies` in turn. */
function textWire(replies: Array<{ status: number; text: string }>) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  _setTextFetch(async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = replies[Math.min(sent.length - 1, replies.length - 1)]!;
    return { status: r.status, text: async () => r.text };
  });
  return sent;
}

describe('openai-text', () => {
  it('the request on the wire has store: false, the model asked for and one tool call at most', async () => {
    const sent = textWire([{ status: 200, text: OK }]);
    const r = await requestToolChoice(REQ, { timeoutMs: 1000 });
    expect(r.call).toEqual({ name: 'time_left', arguments: '{}' });
    expect(r.usage).toEqual({ input: 9, output: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(sent[0]!.body['store']).toBe(false);
    expect(sent[0]!.body).toMatchObject({ model: 'gpt-4.1-mini', parallel_tool_calls: false, tool_choice: 'required', instructions: 'i', input: [{ role: 'user', content: 'Milo, time?' }] });
    expect(sent[0]!.body['tools']).toEqual([{ type: 'function', name: 'time_left', description: TOOL.description, parameters: TOOL.parameters, strict: false }]);
    // Nothing chains to a stored reply or asks the provider to keep one.
    expect(sent[0]!.body).not.toHaveProperty('previous_response_id');
    expect(sent[0]!.body).not.toHaveProperty('conversation');
  });

  it('store: false for every model family and both tool choices', () => {
    for (const model of ['gpt-5.4-mini', 'gpt-4.1', 'gpt-5.4-nano', 'gpt-5.6-luna', 'gpt-6-luna', 'o4-mini', 'some-future-model']) {
      for (const toolChoice of ['required', 'auto'] as const) expect(textToolBody({ ...REQ, model, toolChoice })['store']).toBe(false);
    }
  });

  it('a reasoning model is asked with reasoning off; another model gets no reasoning field', () => {
    expect(textToolBody({ ...REQ, model: 'gpt-5.4-mini' })).toMatchObject({ model: 'gpt-5.4-mini', store: false, reasoning: { effort: 'none' } });
    expect(textToolBody(REQ)).not.toHaveProperty('reasoning');
  });

  it('a model that refuses the reasoning effort is asked again, and the second request also has store: false', async () => {
    const sent = textWire([{ status: 400, text: '{"error":{"message":"Unsupported value: reasoning.effort"}}' }, { status: 200, text: OK }]);
    const r = await requestToolChoice({ ...REQ, model: 'gpt-5-retry-test' }, { timeoutMs: 1000 });
    expect(r.call?.name).toBe('time_left');
    expect(sent.map((s) => s.body['store'])).toEqual([false, false]);
    expect(sent.map((s) => (s.body['reasoning'] as { effort: string }).effort)).toEqual(['none', 'minimal']);
  });

  it('OPENAI_BASE_URL moves the request, the key goes in the header only', async () => {
    process.env['OPENAI_BASE_URL'] = 'http://127.0.0.1:9/v1/';
    const sent = textWire([{ status: 200, text: OK }]);
    await requestToolChoice(REQ, { timeoutMs: 1000 });
    expect(sent[0]!.url).toBe('http://127.0.0.1:9/v1/responses');
    expect(sent[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(sent[0]!.body)).not.toContain(KEY);
  });

  it('a refused request throws with the status only, never the key or the body', async () => {
    textWire([{ status: 500, text: `boom ${KEY} Milo, time?` }]);
    const e = await requestToolChoice(REQ, { timeoutMs: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(TextToolError);
    expect(e).toMatchObject({ kind: 'status', status: 500 });
    expect(String(e.message)).not.toContain(KEY);
    expect(String(e.message)).not.toContain('Milo, time?');
  });

  it('no key: no request is made', async () => {
    const sent = textWire([{ status: 200, text: OK }]);
    for (const v of ['', 'REPLACE_ME']) {
      process.env['OPENAI_API_KEY'] = v;
      expect(await requestToolChoice(REQ, { timeoutMs: 1000 }).catch((e) => e.kind)).toBe('no-key');
    }
    expect(sent).toHaveLength(0);
  });

  it('a slow reply is a timeout; a reply that is not a Responses reply is malformed', async () => {
    _setTextFetch((_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))));
    expect(await requestToolChoice(REQ, { timeoutMs: 20 }).catch((e) => e.kind)).toBe('timeout');
    textWire([{ status: 200, text: 'not json' }]);
    expect(await requestToolChoice(REQ, { timeoutMs: 1000 }).catch((e) => e.kind)).toBe('malformed');
    textWire([{ status: 200, text: '{"id":"x"}' }]);
    expect(await requestToolChoice(REQ, { timeoutMs: 1000 }).catch((e) => e.kind)).toBe('malformed');
  });

  it('reads the first function call and the answer text', () => {
    expect(readTextToolReply({ output: [{ type: 'reasoning' }, { type: 'function_call', name: 'a', arguments: '{"x":1}' }, { type: 'function_call', name: 'b', arguments: '{}' }] }))
      .toEqual({ call: { name: 'a', arguments: '{"x":1}' }, text: '', usage: null });
    expect(readTextToolReply({ output: [{ type: 'message', content: [{ type: 'output_text', text: ' Twelve ' }, { type: 'output_text', text: 'minutes. ' }] }] }))
      .toEqual({ call: null, text: 'Twelve minutes.', usage: null });
  });
});

/** A fake speech transport: records the raw body text and the parsed body, answers with the given PCM chunks. */
function speechWire(chunks: number[] = [4], status = 200) {
  const sent: Array<{ url: string; raw: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  _setTtsFetch(async (url, init) => {
    sent.push({ url, raw: init.body, body: JSON.parse(init.body), headers: init.headers });
    return { status, text: async () => `refused ${KEY}`, body: (async function* () { for (const n of chunks) yield new Uint8Array(n); })() };
  });
  return sent;
}

/** Lines a normaliser would be tempted to change. */
const EXACT = [
  '  Exactly  this. ',
  'You have about twelve minutes left.',
  'Tabs\tand\nnew lines stay.',
  'Quotes "double" and \'single\', a backslash \\ and <tags> & ampersands.',
  'Numbers stay as written: 12, 3.5%, $40, 2026-11-20, O(n log n).',
  'Accents and marks: café, naïve, Zoë, über; dashes - and –; an ellipsis…',
  'Emoji and wide characters: 👍 日本語 🇺🇳.',
  'x'.repeat(5000),
];

describe('openai-tts', () => {
  it.each(EXACT.map((t, i) => [i, t] as const))('the input sent is the given text, character for character (%i)', async (_i, text) => {
    const sent = speechWire();
    const reported: string[] = [];
    await streamSpeech(text, { onInput: (s) => reported.push(s), onAudio: () => undefined });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body['input']).toBe(text);
    expect(reported).toEqual([text]);
    // And through the JSON on the wire, not only the object: the text survives the encoding.
    expect((JSON.parse(sent[0]!.raw) as { input: string }).input).toBe(text);
  });

  it('the default request: gpt-4o-mini-tts, cedar, PCM, streamed audio, whole-sample chunks', async () => {
    const sent = speechWire([3, 5]);
    const got: number[] = [];
    const r = await streamSpeech('Hello.', { onAudio: (b) => got.push(b.length) });
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(sent[0]!.body).toEqual({ model: 'gpt-4o-mini-tts', voice: 'cedar', input: 'Hello.', response_format: 'pcm', stream_format: 'audio' });
    expect(got.every((n) => n % 2 === 0)).toBe(true);
    expect(r.bytes).toBe(8);
    expect(DEFAULT_TTS_MODEL).toBe('gpt-4o-mini-tts');
  });

  it('the model and voice are config: another model gets the plain request with the same exact input', async () => {
    process.env['MILO_TTS_MODEL'] = 'some-successor-tts';
    process.env['VOICE_VOICE'] = 'marin';
    const sent = speechWire();
    await speechBackend().speak(EXACT[0]!, { onInput: () => undefined, onAudio: () => undefined });
    expect(sent[0]!.body).toEqual({ model: 'some-successor-tts', voice: 'marin', input: EXACT[0], response_format: 'pcm' });
    process.env['MILO_TTS_VOICE'] = 'ash';
    expect(ttsBody('x')).toMatchObject({ voice: 'ash', input: 'x' });
    expect(ttsBody('x', { model: 'tts-1', instructions: 'calm' })).toEqual({ model: 'tts-1', voice: 'ash', input: 'x', response_format: 'pcm' });
    expect(ttsBody('x', { model: 'gpt-4o-mini-tts-2025-12-15', instructions: 'calm' })).toMatchObject({ input: 'x', instructions: 'calm', stream_format: 'audio' });
  });

  it('the backend is behind an interface: openai by default, named by MILO_TTS_BACKEND, an unknown name refused', async () => {
    const b = speechBackend();
    expect(b).toMatchObject({ id: 'openai:gpt-4o-mini-tts:cedar', sampleRate: 24_000 });
    expect(b.id).not.toContain(KEY);
    process.env['MILO_TTS_BACKEND'] = 'OpenAI';
    process.env['MILO_TTS_MODEL'] = 'm2';
    expect(speechBackend().id).toBe(openAiSpeech().id);
    expect(speechBackend().id).toBe('openai:m2:cedar');
    for (const name of ['elsewhere', 'constructor', '__proto__']) {
      process.env['MILO_TTS_BACKEND'] = name;
      expect(() => speechBackend()).toThrow(/no voice backend/);
    }
  });

  it('the words are reported before the request and before any audio', async () => {
    const order: string[] = [];
    _setTtsFetch(async () => { order.push('request'); return { status: 200, text: async () => '', body: (async function* () { yield new Uint8Array(4); })() }; });
    await streamSpeech('Hi.', { onInput: () => order.push('input'), onAudio: () => order.push('audio') });
    expect(order).toEqual(['input', 'request', 'audio']);
  });

  it('a refused request throws with the status only, never the key or the words; no key, no request', async () => {
    const sent = speechWire([4], 429);
    const e = await streamSpeech('Secret words.', { onAudio: () => undefined }).catch((x) => x);
    expect(e).toBeInstanceOf(TtsError);
    expect(e).toMatchObject({ kind: 'status', status: 429 });
    expect(String(e.message)).not.toContain(KEY);
    expect(String(e.message)).not.toContain('Secret words.');
    expect(sent[0]!.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(sent[0]!.raw).not.toContain(KEY);
    process.env['OPENAI_API_KEY'] = '';
    expect(await streamSpeech('x', { onAudio: () => undefined }).catch((x) => x.kind)).toBe('no-key');
    expect(sent).toHaveLength(1);
  });

  it('an abort stops it', async () => {
    const ac = new AbortController();
    _setTtsFetch(async () => ({ status: 200, text: async () => '', body: (async function* () { yield new Uint8Array(4); ac.abort(); yield new Uint8Array(4); })() }));
    const got: number[] = [];
    const e = await streamSpeech('x', { signal: ac.signal, onAudio: (b) => got.push(b.length) }).catch((x) => x);
    expect(e).toBeInstanceOf(TtsError);
    expect(e.kind).toBe('aborted');
    expect(got).toEqual([4]);
  });
});
