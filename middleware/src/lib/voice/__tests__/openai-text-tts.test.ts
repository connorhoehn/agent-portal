// The text and speech provider calls: `store: false` on every text request, the key never leaks, TTS speaks the exact input.
import { requestToolChoice, textToolBody, _setTextFetch, TextToolError } from '../openai-text.js';
import { streamSpeech, ttsBody, _setTtsFetch, TtsError } from '../openai-tts.js';

const KEY = 'sk-test-secret-key';
beforeEach(() => { process.env['OPENAI_API_KEY'] = KEY; });
afterEach(() => { _setTextFetch(null); _setTtsFetch(null); delete process.env['OPENAI_API_KEY']; });

const REQ = { model: 'gpt-4.1-mini', instructions: 'i', input: 'Milo, time?', tools: [], toolChoice: 'required' as const };

describe('openai-text', () => {
  it('every request body has store: false and one tool call at most', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    _setTextFetch(async (_u, init) => { bodies.push(JSON.parse(init.body)); return { status: 200, text: async () => JSON.stringify({ output: [{ type: 'function_call', name: 'time_left', arguments: '{}' }], usage: { input_tokens: 9, output_tokens: 2 } }) }; });
    const r = await requestToolChoice(REQ, { timeoutMs: 1000 });
    expect(r.call).toEqual({ name: 'time_left', arguments: '{}' });
    expect(bodies[0]).toMatchObject({ store: false, parallel_tool_calls: false, tool_choice: 'required' });
    expect(textToolBody({ ...REQ, model: 'gpt-5.6-luna' })).toMatchObject({ store: false, reasoning: { effort: 'none' } });
  });

  it('a refused request throws with the status only, never the key or the body', async () => {
    _setTextFetch(async () => ({ status: 500, text: async () => 'boom' }));
    const e = await requestToolChoice(REQ, { timeoutMs: 1000 }).catch((x) => x);
    expect(e).toBeInstanceOf(TextToolError);
    expect(String(e.message)).not.toContain(KEY);
    expect(String(e.message)).not.toContain('Milo, time?');
  });

  it('a slow reply is a timeout', async () => {
    _setTextFetch((_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort')))));
    expect(await requestToolChoice(REQ, { timeoutMs: 20 }).catch((e) => e.kind)).toBe('timeout');
  });
});

describe('openai-tts', () => {
  it('the input is the text unchanged, PCM out, chunks whole samples', async () => {
    let body: Record<string, unknown> = {};
    _setTtsFetch(async (_u, init) => {
      body = JSON.parse(init.body);
      return { status: 200, text: async () => '', body: (async function* () { yield new Uint8Array(3); yield new Uint8Array(5); })() };
    });
    const got: number[] = [];
    const r = await streamSpeech('  Exactly  this. ', { onAudio: (b) => got.push(b.length) });
    expect(body).toMatchObject({ input: '  Exactly  this. ', response_format: 'pcm', model: 'gpt-4o-mini-tts' });
    expect(got.every((n) => n % 2 === 0)).toBe(true);
    expect(r.bytes).toBe(8);
    expect(ttsBody('x', { model: 'tts-1' })).not.toHaveProperty('stream_format');
  });

  it('an abort stops it', async () => {
    const ac = new AbortController();
    _setTtsFetch(async () => ({ status: 200, text: async () => '', body: (async function* () { yield new Uint8Array(4); ac.abort(); yield new Uint8Array(4); })() }));
    const e = await streamSpeech('x', { signal: ac.signal, onAudio: () => undefined }).catch((x) => x);
    expect(e).toBeInstanceOf(TtsError);
    expect(e.kind).toBe('aborted');
  });
});
